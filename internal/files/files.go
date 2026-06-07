// Package files exposes a remote file manager + config editor surface for the
// SSH ops dock: directory listing, file read (size-capped, base64 transported),
// backup-on-write, and chmod — all over the pooled SSH connection. List/Read
// require ActionConnect on the node; Write/Chmod are gated by storage:manage at
// the route (filesystem mutations reuse the storage permission + audit kind).
package files

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
	"go.uber.org/zap"
)

var (
	ErrDisabled         = errors.New("files subsystem disabled")
	ErrUnauthorized     = errors.New("not authorized for node")
	ErrUnreachable      = errors.New("node unreachable")
	ErrPermissionDenied = errors.New("permission denied")
	ErrBadPath          = errors.New("invalid path")
	ErrTooLarge         = errors.New("file too large to edit")
	ErrNotFound         = errors.New("path not found")
)

// MaxRead caps both the read preview and the editable write size.
const MaxRead = 256 * 1024

type Config struct {
	Enabled    bool
	SSHTimeout time.Duration
}

type Deps struct {
	Logger *zap.Logger
	Nodes  *repo.NodeRepo
	Creds  *repo.CredentialRepo
	Asset  *asset.Resolver
	Audit  *audit.Writer
	SSH    sshrun.Deps
}

type AuditClaims struct {
	UserID   uint64
	Username string
	ClientIP string
}

type Entry struct {
	Name  string `json:"name"`
	Type  string `json:"type"` // dir | file | link | other
	Size  int64  `json:"size"`
	Mode  string `json:"mode"` // octal, e.g. "644"
	MTime int64  `json:"mtime"`
	Owner string `json:"owner"`
}

type Listing struct {
	Path    string  `json:"path"`
	Entries []Entry `json:"entries"`
}

type FileContent struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	Size      int64  `json:"size"`
	Truncated bool   `json:"truncated"`
	Binary    bool   `json:"binary"`
}

type Manager struct {
	cfg    Config
	logger *zap.Logger
	nodes  *repo.NodeRepo
	creds  *repo.CredentialRepo
	asset  *asset.Resolver
	audit  *audit.Writer
	deps   sshrun.Deps
}

func NewManager(cfg Config, deps Deps) *Manager {
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 15 * time.Second
	}
	m := &Manager{cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds, asset: deps.Asset, audit: deps.Audit, deps: deps.SSH}
	if m.logger != nil {
		m.logger.Info("files subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

// List enumerates a directory: one stat line per entry (name, type, size, mode,
// mtime, owner). Hidden entries are included; "." and ".." are not.
func (m *Manager) List(ctx context.Context, userID, nodeID uint64, dir string) (*Listing, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if dir == "" {
		dir = "/"
	}
	if !validPath(dir) {
		return nil, ErrBadPath
	}
	q := shellQuote(dir)
	script := fmt.Sprintf(`P=%s; if [ ! -d "$P" ]; then echo "__NODIR__"; exit 0; fi; ls -A1 "$P" 2>/dev/null | while IFS= read -r f; do printf '%%s\t' "$f"; stat -c '%%F\t%%s\t%%a\t%%Y\t%%U' "$P/$f" 2>/dev/null || printf '?\t0\t0\t0\t?\n'; done`, q)
	res, err := m.run(ctx, node, cred, script)
	if err != nil && res.Stdout == "" {
		return nil, classify(err, "ls")
	}
	out := strings.TrimRight(res.Stdout, "\n")
	if strings.TrimSpace(out) == "__NODIR__" {
		return nil, ErrNotFound
	}
	listing := &Listing{Path: cleanDir(dir), Entries: parseListing(out)}
	return listing, nil
}

// Read returns up to MaxRead bytes of a file, base64-transported to survive
// binary content, plus the true size and a truncated flag.
func (m *Manager) Read(ctx context.Context, userID, nodeID uint64, file string) (*FileContent, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !validPath(file) || strings.HasSuffix(file, "/") {
		return nil, ErrBadPath
	}
	q := shellQuote(file)
	script := fmt.Sprintf(`P=%s; if [ ! -f "$P" ]; then echo "__NOFILE__"; exit 0; fi; SZ=$(stat -c %%s "$P" 2>/dev/null || echo -1); echo "SIZE:$SZ"; head -c %d "$P" 2>/dev/null | base64 | tr -d '\n'; echo`, q, MaxRead)
	res, err := m.run(ctx, node, cred, script)
	if err != nil && res.Stdout == "" {
		return nil, classify(err, "read")
	}
	out := res.Stdout
	if strings.HasPrefix(strings.TrimSpace(out), "__NOFILE__") {
		return nil, ErrNotFound
	}
	nl := strings.IndexByte(out, '\n')
	if nl < 0 {
		return nil, fmt.Errorf("read: unexpected output")
	}
	header := strings.TrimSpace(out[:nl])
	b64 := strings.TrimSpace(out[nl+1:])
	size := int64(-1)
	if strings.HasPrefix(header, "SIZE:") {
		size = atoi64(strings.TrimPrefix(header, "SIZE:"))
	}
	raw, derr := base64.StdEncoding.DecodeString(b64)
	if derr != nil {
		return nil, fmt.Errorf("read decode: %w", derr)
	}
	binary := false
	for _, b := range raw {
		if b == 0 {
			binary = true
			break
		}
	}
	fc := &FileContent{
		Path:      file,
		Size:      size,
		Truncated: size > MaxRead,
		Binary:    binary,
	}
	if !binary {
		fc.Content = string(raw)
	}
	return fc, nil
}

// Write backs up the existing file to <path>.bak (if present), then overwrites
// it with the supplied content. Prefers a passwordless-sudo tee so /etc configs
// can be edited; falls back to an unprivileged write.
func (m *Manager) Write(ctx context.Context, userID, nodeID uint64, claims AuditClaims, file, content string) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validPath(file) || strings.HasSuffix(file, "/") {
		return ErrBadPath
	}
	if len(content) > MaxRead {
		return ErrTooLarge
	}
	b64 := base64.StdEncoding.EncodeToString([]byte(content))
	q := shellQuote(file)
	script := fmt.Sprintf(`P=%s; if [ -f "$P" ]; then (sudo -n cp -a "$P" "$P.bak" 2>/dev/null || cp -a "$P" "$P.bak" 2>/dev/null); fi; printf '%%s' %s | base64 -d | (sudo -n tee "$P" >/dev/null 2>&1 || tee "$P" >/dev/null 2>&1) && echo __OK__ || echo __FAIL__`, q, shellQuote(b64))
	res, err := m.run(ctx, node, cred, script)
	combined := res.Stdout + " " + res.Stderr
	if e := classifyOutput(combined); e != nil {
		return e
	}
	if err != nil || !strings.Contains(res.Stdout, "__OK__") {
		if err != nil {
			return classify(err, "write")
		}
		return fmt.Errorf("write failed (insufficient permission or read-only path)")
	}
	m.recordAudit(claims, nodeID, "edit "+file)
	return nil
}

// Chmod changes a path's permission bits.
func (m *Manager) Chmod(ctx context.Context, userID, nodeID uint64, claims AuditClaims, file, mode string) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validPath(file) || !validMode(mode) {
		return ErrBadPath
	}
	q := shellQuote(file)
	script := fmt.Sprintf(`(sudo -n chmod %s %s 2>&1 || chmod %s %s 2>&1)`, mode, q, mode, q)
	res, err := m.run(ctx, node, cred, script)
	if e := classifyOutput(res.Stdout + " " + res.Stderr); e != nil {
		return e
	}
	if err != nil {
		return classify(err, "chmod")
	}
	m.recordAudit(claims, nodeID, fmt.Sprintf("chmod %s %s", mode, file))
	return nil
}

func (m *Manager) run(ctx context.Context, node *model.Node, cred *model.Credential, script string) (sshrun.Result, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	return sshrun.Run(cctx, m.deps, node, cred, script, m.cfg.SSHTimeout)
}

func (m *Manager) gateAndLoad(ctx context.Context, userID, nodeID uint64) (*model.Node, *model.Credential, error) {
	if !m.cfg.Enabled {
		return nil, nil, ErrDisabled
	}
	if m.asset != nil {
		ok, err := m.asset.Check(ctx, userID, nodeID, asset.ActionConnect)
		if err != nil {
			return nil, nil, fmt.Errorf("asset check: %w", err)
		}
		if !ok {
			return nil, nil, ErrUnauthorized
		}
	}
	node, err := m.nodes.FindByID(ctx, nodeID)
	if err != nil || node == nil {
		return nil, nil, fmt.Errorf("node %d not found", nodeID)
	}
	if node.Disabled {
		return nil, nil, fmt.Errorf("node disabled")
	}
	cred, err := m.creds.FindByID(ctx, node.CredentialID)
	if err != nil || cred == nil {
		return nil, nil, fmt.Errorf("credential lookup failed")
	}
	return node, cred, nil
}

func (m *Manager) recordAudit(c AuditClaims, nodeID uint64, payload string) {
	if m.audit == nil {
		return
	}
	nid := nodeID
	m.audit.Log(model.AuditLog{
		Kind: model.AuditStorageAction, UserID: c.UserID, Username: c.Username,
		NodeID: &nid, ClientIP: c.ClientIP, Payload: payload,
	})
}

func parseListing(raw string) []Entry {
	out := []Entry{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < 6 {
			continue
		}
		out = append(out, Entry{
			Name:  f[0],
			Type:  fileType(f[1]),
			Size:  atoi64(f[2]),
			Mode:  strings.TrimSpace(f[3]),
			MTime: atoi64(f[4]),
			Owner: strings.TrimSpace(f[5]),
		})
	}
	return out
}

func fileType(statF string) string {
	switch {
	case strings.Contains(statF, "directory"):
		return "dir"
	case strings.Contains(statF, "symbolic link"):
		return "link"
	case strings.Contains(statF, "regular"):
		return "file"
	default:
		return "other"
	}
}

func classify(err error, op string) error {
	if err == nil {
		return nil
	}
	e := strings.ToLower(err.Error())
	if strings.Contains(e, "unable to authenticate") || strings.Contains(e, "no route to host") ||
		strings.Contains(e, "i/o timeout") || strings.Contains(e, "connection refused") {
		return fmt.Errorf("%w: %v (%s)", ErrUnreachable, err, op)
	}
	return fmt.Errorf("%s: %w", op, err)
}

func classifyOutput(out string) error {
	low := strings.ToLower(out)
	if strings.Contains(low, "permission denied") || strings.Contains(low, "operation not permitted") ||
		strings.Contains(low, "read-only file system") || strings.Contains(low, "a password is required") {
		return fmt.Errorf("%w: %s", ErrPermissionDenied, strings.TrimSpace(truncate(out, 160)))
	}
	return nil
}

// validPath requires an absolute path with no newline / NUL injection. Shell
// metacharacters are still neutralised by shellQuote at call sites.
func validPath(p string) bool {
	if p == "" || !strings.HasPrefix(p, "/") || len(p) > 4096 {
		return false
	}
	if strings.ContainsAny(p, "\n\r\x00") {
		return false
	}
	return true
}

func validMode(s string) bool {
	if len(s) < 3 || len(s) > 4 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '7' {
			return false
		}
	}
	return true
}

func cleanDir(p string) string {
	c := path.Clean(p)
	if c == "" {
		return "/"
	}
	return c
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func atoi64(s string) int64 {
	n, _ := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	return n
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
