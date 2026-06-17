// Package backup exposes a backup-snapshot + job-scheduling surface for the SSH
// ops dock: one-shot tar/rsync snapshots, and `at` one-off job orchestration
// (list / add / remove). Info reads require ActionConnect; the snapshot and
// job mutations are gated by storage:manage (filesystem + scheduling) and
// audited as storage actions. All over the pooled SSH connection.
package backup

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	"github.com/michongs/wayfort/internal/sshrun"
	"go.uber.org/zap"
)

var (
	ErrDisabled         = errors.New("backup subsystem disabled")
	ErrUnauthorized     = errors.New("not authorized for node")
	ErrUnreachable      = errors.New("node unreachable")
	ErrPermissionDenied = errors.New("permission denied")
	ErrBadArg           = errors.New("invalid argument")
)

type Config struct {
	Enabled       bool
	SSHTimeout    time.Duration // default 15s (info/jobs)
	SnapshotTimeout time.Duration // default 10m (tar/rsync can be slow)
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

type Tools struct {
	Rsync  bool `json:"rsync"`
	Tar    bool `json:"tar"`
	Restic bool `json:"restic"`
	At     bool `json:"at"`
}

type AtJob struct {
	ID   string `json:"id"`
	When string `json:"when"`
	User string `json:"user"`
}

type Info struct {
	Tools     Tools     `json:"tools"`
	AtJobs    []AtJob   `json:"at_jobs"`
	SampledAt time.Time `json:"sampled_at"`
}

type SnapshotResult struct {
	Output string `json:"output"`
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
	if cfg.SnapshotTimeout <= 0 {
		cfg.SnapshotTimeout = 10 * time.Minute
	}
	m := &Manager{cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds, asset: deps.Asset, audit: deps.Audit, deps: deps.SSH}
	if m.logger != nil {
		m.logger.Info("backup subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

const infoScript = `echo __TOOLS__; for t in rsync tar restic at; do if command -v "$t" >/dev/null 2>&1; then echo "$t=1"; else echo "$t=0"; fi; done; echo __ATJOBS__; (sudo -n atq 2>/dev/null || atq 2>/dev/null)`

func (m *Manager) Info(ctx context.Context, userID, nodeID uint64) (*Info, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	res, err := m.run(ctx, node, cred, infoScript, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classify(err, "backup info")
	}
	info := &Info{SampledAt: time.Now().UTC()}
	section := ""
	for _, line := range strings.Split(res.Stdout, "\n") {
		line = strings.TrimRight(line, "\r")
		switch line {
		case "__TOOLS__":
			section = "tools"
			continue
		case "__ATJOBS__":
			section = "jobs"
			continue
		}
		if line == "" {
			continue
		}
		if section == "tools" {
			k, v, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			on := v == "1"
			switch k {
			case "rsync":
				info.Tools.Rsync = on
			case "tar":
				info.Tools.Tar = on
			case "restic":
				info.Tools.Restic = on
			case "at":
				info.Tools.At = on
			}
		} else if section == "jobs" {
			if j, ok := parseAtq(line); ok {
				info.AtJobs = append(info.AtJobs, j)
			}
		}
	}
	return info, nil
}

// Snapshot tars or rsyncs src → dest. method ∈ {tar, rsync}.
func (m *Manager) Snapshot(ctx context.Context, userID, nodeID uint64, claims AuditClaims, method, src, dest string) (*SnapshotResult, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !validPath(src) || !validPath(dest) {
		return nil, ErrBadArg
	}
	qs, qd := shellQuote(src), shellQuote(dest)
	var cmd string
	switch method {
	case "tar":
		cmd = fmt.Sprintf(`(sudo -n tar -czf %s %s 2>&1 || tar -czf %s %s 2>&1) && echo __OK__`, qd, qs, qd, qs)
	case "rsync":
		cmd = fmt.Sprintf(`(sudo -n rsync -a --info=stats1 %s/ %s/ 2>&1 || rsync -a --info=stats1 %s/ %s/ 2>&1) && echo __OK__`, qs, qd, qs, qd)
	default:
		return nil, ErrBadArg
	}
	res, err := m.run(ctx, node, cred, cmd, m.cfg.SnapshotTimeout)
	combined := res.Stdout + " " + res.Stderr
	if e := classifyOutput(combined); e != nil {
		return nil, e
	}
	if err != nil && res.Stdout == "" {
		return nil, classify(err, method)
	}
	if !strings.Contains(res.Stdout, "__OK__") {
		return nil, fmt.Errorf("%s failed: %s", method, strings.TrimSpace(truncate(combined, 240)))
	}
	out := strings.ReplaceAll(res.Stdout, "__OK__", "")
	m.recordAudit(claims, nodeID, fmt.Sprintf("%s %s -> %s", method, src, dest))
	return &SnapshotResult{Output: strings.TrimSpace(out)}, nil
}

// AddAt schedules a one-off command with `at`.
func (m *Manager) AddAt(ctx context.Context, userID, nodeID uint64, claims AuditClaims, when, command string) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validWhen(when) || !validCommand(command) {
		return ErrBadArg
	}
	cmd := fmt.Sprintf(`printf '%%s\n' %s | (sudo -n at %s 2>&1 || at %s 2>&1)`, shellQuote(command), shellQuote(when), shellQuote(when))
	res, err := m.run(ctx, node, cred, cmd, m.cfg.SSHTimeout)
	combined := res.Stdout + " " + res.Stderr
	if e := classifyOutput(combined); e != nil {
		return e
	}
	if err != nil {
		return classify(err, "at")
	}
	if strings.Contains(strings.ToLower(combined), "garbled time") || strings.Contains(strings.ToLower(combined), "cannot") {
		return fmt.Errorf("at 拒绝: %s", strings.TrimSpace(truncate(combined, 160)))
	}
	m.recordAudit(claims, nodeID, fmt.Sprintf("at add (%s) %s", when, command))
	return nil
}

// RemoveAt cancels a scheduled `at` job by id.
func (m *Manager) RemoveAt(ctx context.Context, userID, nodeID uint64, claims AuditClaims, id string) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validID(id) {
		return ErrBadArg
	}
	cmd := fmt.Sprintf(`(sudo -n atrm %s 2>&1 || atrm %s 2>&1)`, id, id)
	res, err := m.run(ctx, node, cred, cmd, m.cfg.SSHTimeout)
	if e := classifyOutput(res.Stdout + " " + res.Stderr); e != nil {
		return e
	}
	if err != nil {
		return classify(err, "atrm")
	}
	m.recordAudit(claims, nodeID, "at remove "+id)
	return nil
}

func (m *Manager) run(ctx context.Context, node *model.Node, cred *model.Credential, script string, to time.Duration) (sshrun.Result, error) {
	cctx, cancel := context.WithTimeout(ctx, to)
	defer cancel()
	return sshrun.Run(cctx, m.deps, node, cred, script, to)
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

// parseAtq parses one `atq` line: "<id>\t<weekday month day time year> <queue> <user>".
func parseAtq(line string) (AtJob, bool) {
	fields := strings.Fields(line)
	if len(fields) < 3 {
		return AtJob{}, false
	}
	id := fields[0]
	user := fields[len(fields)-1]
	// Drop id (first) + queue-letter (second-last) + user (last); the middle is the time.
	when := strings.Join(fields[1:len(fields)-2], " ")
	if when == "" {
		when = strings.Join(fields[1:len(fields)-1], " ")
	}
	return AtJob{ID: id, When: when, User: user}, true
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
		strings.Contains(low, "a password is required") || strings.Contains(low, "read-only file system") {
		return fmt.Errorf("%w: %s", ErrPermissionDenied, strings.TrimSpace(truncate(out, 160)))
	}
	return nil
}

func validPath(p string) bool {
	if p == "" || !strings.HasPrefix(p, "/") || len(p) > 4096 {
		return false
	}
	return !strings.ContainsAny(p, "\n\r\x00")
}

func validWhen(s string) bool {
	if s == "" || len(s) > 64 || strings.ContainsAny(s, "\n\r\x00") {
		return false
	}
	return true
}

func validCommand(s string) bool {
	return s != "" && len(s) <= 4096 && !strings.ContainsAny(s, "\n\r\x00")
}

func validID(s string) bool {
	if s == "" || len(s) > 12 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
