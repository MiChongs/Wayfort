package process

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/michongs/wayfort/internal/asset"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	"github.com/michongs/wayfort/internal/sshrun"
	"go.uber.org/zap"
	"golang.org/x/sync/singleflight"
)

type Config struct {
	Enabled    bool
	CacheTTL   time.Duration // default 3s
	SSHTimeout time.Duration // default 10s
}

type Manager struct {
	cfg    Config
	logger *zap.Logger
	nodes  *repo.NodeRepo
	creds  *repo.CredentialRepo
	asset  *asset.Resolver
	audit  *audit.Writer
	deps   sshrun.Deps

	mu     sync.Mutex
	cache  map[uint64]*cacheEntry
	flight singleflight.Group
}

type cacheEntry struct {
	at   time.Time
	list ProcessList
}

type Deps struct {
	Logger *zap.Logger
	Nodes  *repo.NodeRepo
	Creds  *repo.CredentialRepo
	Asset  *asset.Resolver
	Audit  *audit.Writer
	SSH    sshrun.Deps
}

func NewManager(cfg Config, deps Deps) *Manager {
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 3 * time.Second
	}
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 10 * time.Second
	}
	m := &Manager{
		cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds,
		asset: deps.Asset, audit: deps.Audit, deps: deps.SSH,
		cache: map[uint64]*cacheEntry{},
	}
	if m.logger != nil {
		m.logger.Info("process subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

// List returns the process table sorted by `by` (cpu/mem/rss/pid).
func (m *Manager) List(ctx context.Context, userID, nodeID uint64, by string) (*ProcessList, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	var list ProcessList
	if c := m.cached(nodeID); c != nil {
		list = c.list
	} else {
		v, err, _ := m.flight.Do(fmt.Sprintf("list:%d", nodeID), func() (any, error) {
			return m.collect(ctx, nodeID, loaded)
		})
		if err != nil {
			return nil, err
		}
		list = v.(*cacheEntry).list
	}
	out := list
	out.Processes = append([]Process(nil), list.Processes...)
	sortProcs(out.Processes, by)
	return &out, nil
}

func (m *Manager) collect(ctx context.Context, nodeID uint64, l *nodeAndCred) (*cacheEntry, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, l.node, l.cred, listScript, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, res.Stderr, "list processes")
	}
	procs := parsePsList(res.Stdout)
	if len(procs) == 0 {
		return nil, ErrParse
	}
	entry := &cacheEntry{at: time.Now().UTC(), list: ProcessList{
		GeneratedAt: time.Now().UTC(), Total: len(procs), Processes: procs,
	}}
	m.store(nodeID, entry)
	return entry, nil
}

// Detail expands one PID (status + limits + fd count + io + cmdline).
func (m *Manager) Detail(ctx context.Context, userID, nodeID uint64, pid int) (*Detail, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !validPID(pid) {
		return nil, ErrBadPID
	}
	script := fmt.Sprintf(`LC_ALL=C
echo '===STATUS==='
cat /proc/%d/status 2>/dev/null
echo '===CMDLINE==='
tr '\0' ' ' < /proc/%d/cmdline 2>/dev/null
echo '===LIMITS==='
cat /proc/%d/limits 2>/dev/null
echo '===FDCOUNT==='
ls /proc/%d/fd 2>/dev/null | wc -l
echo '===IO==='
cat /proc/%d/io 2>/dev/null
echo '===END==='
`, pid, pid, pid, pid, pid)
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, script, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, res.Stderr, "process detail")
	}
	sec := splitSections(res.Stdout)
	status := parseStatus(sec["STATUS"])
	if len(status) == 0 {
		return nil, fmt.Errorf("%w: pid %d not found", ErrBadPID, pid)
	}
	read, write := parseIO(sec["IO"])
	fdc := atoi(strings.TrimSpace(sec["FDCOUNT"]))
	return &Detail{
		PID:       pid,
		Status:    status,
		Cmdline:   strings.TrimSpace(sec["CMDLINE"]),
		Limits:    strings.TrimSpace(sec["LIMITS"]),
		FDCount:   fdc,
		IORead:    read,
		IOWrite:   write,
		SampledAt: time.Now().UTC(),
	}, nil
}

// Signal sends a whitelisted signal to a PID and audits it.
func (m *Manager) Signal(ctx context.Context, userID, nodeID uint64, claims AuditClaims, pid int, sig Signal) error {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validPID(pid) {
		return ErrBadPID
	}
	if !ValidSignal(sig) {
		return ErrBadSignal
	}
	cmd := fmt.Sprintf("kill -%s %d 2>&1", string(sig), pid)
	if err := m.exec(ctx, loaded, cmd, "signal"); err != nil {
		return err
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditProcessAction, fmt.Sprintf("signal %s pid=%d", sig, pid))
	return nil
}

// Renice changes a PID's scheduling priority (-20..19) and audits it.
func (m *Manager) Renice(ctx context.Context, userID, nodeID uint64, claims AuditClaims, pid, nice int) error {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validPID(pid) {
		return ErrBadPID
	}
	if nice < -20 || nice > 19 {
		return ErrBadNice
	}
	cmd := fmt.Sprintf("renice -n %d -p %d 2>&1", nice, pid)
	if err := m.exec(ctx, loaded, cmd, "renice"); err != nil {
		return err
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditProcessAction, fmt.Sprintf("renice %d pid=%d", nice, pid))
	return nil
}

func (m *Manager) exec(ctx context.Context, l *nodeAndCred, cmd, op string) error {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, l.node, l.cred, cmd, m.cfg.SSHTimeout)
	if err != nil {
		return classifySSHError(err, res.Stderr+res.Stdout, op)
	}
	if e := classifyToolOutput(res.Stdout + " " + res.Stderr); e != nil {
		return e
	}
	return nil
}

// ---- plumbing (mirrors systemd) ----

func (m *Manager) cached(nodeID uint64) *cacheEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.cache[nodeID]; ok && time.Since(c.at) < m.cfg.CacheTTL {
		return c
	}
	return nil
}
func (m *Manager) store(nodeID uint64, c *cacheEntry) {
	m.mu.Lock()
	m.cache[nodeID] = c
	m.mu.Unlock()
}
func (m *Manager) invalidate(nodeID uint64) {
	m.mu.Lock()
	delete(m.cache, nodeID)
	m.mu.Unlock()
}

type nodeAndCred struct {
	node *model.Node
	cred *model.Credential
}

func (m *Manager) gateAndLoad(ctx context.Context, userID, nodeID uint64) (*nodeAndCred, error) {
	if !m.cfg.Enabled {
		return nil, ErrDisabled
	}
	if m.asset != nil {
		ok, err := m.asset.Check(ctx, userID, nodeID, asset.ActionConnect)
		if err != nil {
			return nil, fmt.Errorf("asset check: %w", err)
		}
		if !ok {
			return nil, ErrUnauthorized
		}
	}
	node, err := m.nodes.FindByID(ctx, nodeID)
	if err != nil || node == nil {
		return nil, fmt.Errorf("node %d not found", nodeID)
	}
	if node.Disabled {
		return nil, fmt.Errorf("node disabled")
	}
	cred, err := m.creds.FindByID(ctx, node.CredentialID)
	if err != nil || cred == nil {
		return nil, fmt.Errorf("credential lookup failed")
	}
	return &nodeAndCred{node: node, cred: cred}, nil
}

func (m *Manager) recordAudit(c AuditClaims, nodeID uint64, kind model.AuditEventKind, payload string) {
	if m.audit == nil {
		return
	}
	nid := nodeID
	m.audit.Log(model.AuditLog{
		Kind: kind, UserID: c.UserID, Username: c.Username,
		NodeID: &nid, ClientIP: c.ClientIP, Payload: payload,
	})
}

func classifySSHError(err error, stderr, op string) error {
	if err == nil {
		return nil
	}
	msg := strings.ToLower(stderr)
	switch {
	case strings.Contains(msg, "permission denied") || strings.Contains(msg, "operation not permitted") ||
		strings.Contains(msg, "not permitted"):
		return fmt.Errorf("%w: %s (%s)", ErrPermissionDenied, truncate(stderr, 200), op)
	case strings.Contains(strings.ToLower(err.Error()), "unable to authenticate") ||
		strings.Contains(strings.ToLower(err.Error()), "no route to host") ||
		strings.Contains(strings.ToLower(err.Error()), "i/o timeout") ||
		strings.Contains(strings.ToLower(err.Error()), "connection refused"):
		return fmt.Errorf("%w: %v (%s)", ErrUnreachable, err, op)
	default:
		return fmt.Errorf("%s: %w (stderr: %s)", op, err, truncate(stderr, 200))
	}
}

func classifyToolOutput(out string) error {
	low := strings.ToLower(out)
	if strings.Contains(low, "operation not permitted") || strings.Contains(low, "permission denied") {
		return fmt.Errorf("%w: %s", ErrPermissionDenied, truncate(out, 200))
	}
	if strings.Contains(low, "no such process") {
		return fmt.Errorf("%w: %s", ErrBadPID, truncate(out, 120))
	}
	return nil
}

func splitSections(raw string) map[string]string {
	out := map[string]string{}
	cur := ""
	var buf strings.Builder
	for _, line := range strings.Split(raw, "\n") {
		t := strings.TrimRight(line, "\r")
		if strings.HasPrefix(t, "===") && strings.HasSuffix(t, "===") && len(t) > 6 {
			out[cur] = buf.String()
			cur = strings.Trim(t, "= ")
			buf.Reset()
			continue
		}
		buf.WriteString(t)
		buf.WriteByte('\n')
	}
	out[cur] = buf.String()
	delete(out, "END")
	return out
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
