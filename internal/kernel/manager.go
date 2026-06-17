package kernel

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
	CacheTTL   time.Duration // default 5s
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
	cache  map[uint64]*entry
	flight singleflight.Group
}

type entry struct {
	at   time.Time
	info Info
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
		cfg.CacheTTL = 5 * time.Second
	}
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 10 * time.Second
	}
	m := &Manager{cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds, asset: deps.Asset, audit: deps.Audit, deps: deps.SSH, cache: map[uint64]*entry{}}
	if m.logger != nil {
		m.logger.Info("kernel subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

func (m *Manager) Info(ctx context.Context, userID, nodeID uint64) (*Info, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if c, ok := m.cache[nodeID]; ok && time.Since(c.at) < m.cfg.CacheTTL {
		info := c.info
		m.mu.Unlock()
		return &info, nil
	}
	m.mu.Unlock()
	v, err, _ := m.flight.Do(fmt.Sprintf("kinfo:%d", nodeID), func() (any, error) {
		return m.collect(ctx, nodeID, loaded)
	})
	if err != nil {
		return nil, err
	}
	return v.(*Info), nil
}

func (m *Manager) collect(ctx context.Context, nodeID uint64, l *nodeAndCred) (*Info, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, l.node, l.cred, snapshotScript, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, "kernel snapshot")
	}
	sec := splitSections(res.Stdout)
	host, kern, tz := parseHost(sec["HOST"])
	info := Info{
		Hostname:  host,
		Kernel:    kern,
		OS:        kern,
		Timezone:  tz,
		Sysctls:   parseSysctl(sec["SYSCTL"]),
		Modules:   parseLsmod(sec["LSMOD"]),
		Limits:    strings.TrimSpace(sec["LIMITS"]),
		SampledAt: time.Now().UTC(),
	}
	m.mu.Lock()
	m.cache[nodeID] = &entry{at: time.Now(), info: info}
	m.mu.Unlock()
	return &info, nil
}

// SetSysctl applies a sysctl value (runtime), optionally persisting it to
// /etc/sysctl.d, and audits the change.
func (m *Manager) SetSysctl(ctx context.Context, userID, nodeID uint64, claims AuditClaims, key, value string, persist bool) error {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validKey(key) {
		return ErrBadKey
	}
	if !validValue(value) {
		return ErrBadValue
	}
	cmd := fmt.Sprintf("sysctl -w %s 2>&1", shellQuote(key+"="+value))
	if persist {
		cmd += fmt.Sprintf(" && printf '%%s = %%s\\n' %s %s >> /etc/sysctl.d/99-wayfort.conf 2>&1",
			shellQuote(key), shellQuote(value))
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, m.cfg.SSHTimeout)
	if err != nil {
		return classifyWrite(err, res.Stderr+res.Stdout, "sysctl -w")
	}
	if e := classifyToolOutput(res.Stdout + " " + res.Stderr); e != nil {
		return e
	}
	m.mu.Lock()
	delete(m.cache, nodeID)
	m.mu.Unlock()
	mode := "runtime"
	if persist {
		mode = "persistent"
	}
	m.recordAudit(claims, nodeID, fmt.Sprintf("sysctl %s=%s (%s)", key, value, mode))
	return nil
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

func (m *Manager) recordAudit(c AuditClaims, nodeID uint64, payload string) {
	if m.audit == nil {
		return
	}
	nid := nodeID
	m.audit.Log(model.AuditLog{
		Kind: model.AuditKernelChange, UserID: c.UserID, Username: c.Username,
		NodeID: &nid, ClientIP: c.ClientIP, Payload: payload,
	})
}

func classifySSHError(err error, op string) error {
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

func classifyWrite(err error, out, op string) error {
	if err == nil {
		return nil
	}
	low := strings.ToLower(out)
	if strings.Contains(low, "permission denied") || strings.Contains(low, "not permitted") ||
		strings.Contains(low, "read-only") {
		return fmt.Errorf("%w: %s", ErrPermissionDenied, truncate(out, 160))
	}
	return classifySSHError(err, op)
}

func classifyToolOutput(out string) error {
	low := strings.ToLower(out)
	if strings.Contains(low, "permission denied") || strings.Contains(low, "operation not permitted") {
		return fmt.Errorf("%w: %s", ErrPermissionDenied, truncate(out, 160))
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
