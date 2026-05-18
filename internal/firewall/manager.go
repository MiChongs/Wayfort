package firewall

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
	"go.uber.org/zap"
	"golang.org/x/sync/singleflight"
)

// Config controls per-node caching of the firewall snapshot. Mutations are
// always synchronous; reads are deduplicated within CacheTTL.
type Config struct {
	Enabled    bool
	CacheTTL   time.Duration // default 5s — firewall changes slowly
	SSHTimeout time.Duration // default 10s
}

var (
	ErrDisabled     = errors.New("firewall: disabled by config")
	ErrUnauthorized = errors.New("firewall: not authorised on node")
)

// Manager fetches and mutates firewall state over SSH on managed nodes.
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
	at     time.Time
	status Status
	rules  []Rule
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
	return &Manager{
		cfg:    cfg,
		logger: deps.Logger,
		nodes:  deps.Nodes,
		creds:  deps.Creds,
		asset:  deps.Asset,
		audit:  deps.Audit,
		deps:   deps.SSH,
		cache:  map[uint64]*cacheEntry{},
	}
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

// Status returns just the high-level state (tool/active/policy/count).
// Internally it fetches the full snapshot — reused with cache.
func (m *Manager) Status(ctx context.Context, userID, nodeID uint64) (*Status, error) {
	snap, _, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	return &snap, nil
}

func (m *Manager) ListRules(ctx context.Context, userID, nodeID uint64) ([]Rule, error) {
	_, rules, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	return rules, nil
}

func (m *Manager) snapshot(ctx context.Context, userID, nodeID uint64) (Status, []Rule, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return Status{}, nil, err
	}
	if c := m.cached(nodeID); c != nil {
		return c.status, c.rules, nil
	}
	key := fmt.Sprintf("snapshot:%d", nodeID)
	v, err, _ := m.flight.Do(key, func() (any, error) {
		return m.collect(ctx, nodeID, loaded)
	})
	if err != nil {
		return Status{}, nil, err
	}
	r := v.(*cacheEntry)
	return r.status, r.rules, nil
}

func (m *Manager) collect(ctx context.Context, nodeID uint64, l *nodeAndCred) (*cacheEntry, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	// Step 1: detect tool. The keyed format survives leading/trailing
	// blank lines and lets the parser look up by name.
	probe, err := sshrun.Run(cctx, m.deps, l.node, l.cred,
		`printf 'ufw=%s\nfirewalld=%s\niptables=%s\n' "$(command -v ufw 2>/dev/null)" "$(command -v firewall-cmd 2>/dev/null)" "$(command -v iptables 2>/dev/null)"`,
		m.cfg.SSHTimeout)
	if err != nil {
		return nil, fmt.Errorf("probe firewall: %w", err)
	}
	tool := detectTool(probe.Stdout)
	if tool == ToolUnsupported {
		return m.unsupportedEntry(nodeID), nil
	}
	// Step 2: list rules per tool.
	listCmd, parser := commandFor(tool)
	res, err := sshrun.Run(cctx, m.deps, l.node, l.cred, listCmd, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, fmt.Errorf("list firewall: %w (stderr: %s)", err, truncate(res.Stderr, 200))
	}
	status, rules := parser(res.Stdout)
	status.SampledAt = time.Now().UTC()
	entry := &cacheEntry{at: status.SampledAt, status: status, rules: rules}
	m.store(nodeID, entry)
	return entry, nil
}

func (m *Manager) unsupportedEntry(nodeID uint64) *cacheEntry {
	now := time.Now().UTC()
	entry := &cacheEntry{
		at: now,
		status: Status{
			Tool:      ToolUnsupported,
			Active:    false,
			Reason:    "no firewall front-end detected (ufw / firewalld / iptables); install one to manage rules",
			SampledAt: now,
		},
	}
	m.store(nodeID, entry)
	return entry
}

func commandFor(tool Tool) (string, func(string) (Status, []Rule)) {
	switch tool {
	case ToolUFW:
		return "ufw status verbose 2>/dev/null", parseUFWStatus
	case ToolFirewalld:
		return "firewall-cmd --list-all 2>/dev/null; firewall-cmd --state 2>/dev/null", parseFirewalldList
	case ToolIPTables:
		return "iptables -L INPUT -n -v --line-numbers 2>/dev/null", parseIPTablesList
	default:
		return ":", func(string) (Status, []Rule) { return Status{}, nil }
	}
}

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
	defer m.mu.Unlock()
	m.cache[nodeID] = c
}

func (m *Manager) invalidate(nodeID uint64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.cache, nodeID)
}

// AddRule executes the tool-specific add command and invalidates the cache.
// Writes are always audited.
func (m *Manager) AddRule(ctx context.Context, userID, nodeID uint64, claims AuditClaims, spec RuleSpec) error {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	status, _, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if status.Tool == ToolUnsupported {
		return errors.New("no firewall tool available on this node")
	}
	cmd, err := buildAddCommand(status.Tool, spec)
	if err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, m.cfg.SSHTimeout)
	if err != nil {
		return fmt.Errorf("add rule: %w (stderr: %s)", err, truncate(res.Stderr, 200))
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditFirewallChange, "add "+cmd)
	return nil
}

// DeleteRule removes rule at the positional index. firewalld doesn't support
// this — operator must specify by service/port; we error with a hint.
func (m *Manager) DeleteRule(ctx context.Context, userID, nodeID uint64, claims AuditClaims, index int) error {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	status, _, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	cmd := buildDelete(status.Tool, index)
	if cmd == "" {
		return errors.New("firewalld: delete by index is not supported; remove the corresponding service/port manually")
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, m.cfg.SSHTimeout)
	if err != nil {
		return fmt.Errorf("delete rule: %w (stderr: %s)", err, truncate(res.Stderr, 200))
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditFirewallChange, "delete "+cmd)
	return nil
}

// SetEnabled flips the firewall on or off (ufw/firewalld only; iptables has
// no concept of enable/disable — that's controlled by systemctl).
func (m *Manager) SetEnabled(ctx context.Context, userID, nodeID uint64, claims AuditClaims, on bool) error {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	status, _, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	var cmd string
	switch status.Tool {
	case ToolUFW:
		if on {
			cmd = "ufw --force enable"
		} else {
			cmd = "ufw --force disable"
		}
	case ToolFirewalld:
		if on {
			cmd = "systemctl start firewalld"
		} else {
			cmd = "systemctl stop firewalld"
		}
	case ToolIPTables:
		return errors.New("iptables has no enable/disable; manage the service that loads its rules")
	default:
		return errors.New("no firewall tool available")
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, m.cfg.SSHTimeout)
	if err != nil {
		return fmt.Errorf("set enabled: %w (stderr: %s)", err, truncate(res.Stderr, 200))
	}
	m.invalidate(nodeID)
	action := "enable"
	if !on {
		action = "disable"
	}
	m.recordAudit(claims, nodeID, model.AuditFirewallChange, action+" "+string(status.Tool))
	return nil
}

func buildAddCommand(tool Tool, spec RuleSpec) (string, error) {
	if spec.Port == "" {
		return "", errors.New("port required")
	}
	switch tool {
	case ToolUFW:
		return buildUFWAdd(spec), nil
	case ToolFirewalld:
		return buildFirewalldAdd(spec), nil
	case ToolIPTables:
		return buildIPTablesAdd(spec), nil
	default:
		return "", errors.New("unsupported firewall tool")
	}
}

// ---- helpers ----

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

// AuditClaims carries the bits we need for audit row writes — keeps the
// handler from needing to import internal/auth here.
type AuditClaims struct {
	UserID   uint64
	Username string
	ClientIP string
}

func (m *Manager) recordAudit(c AuditClaims, nodeID uint64, kind model.AuditEventKind, payload string) {
	if m.audit == nil {
		return
	}
	nid := nodeID
	m.audit.Log(model.AuditLog{
		Kind:     kind,
		UserID:   c.UserID,
		Username: c.Username,
		NodeID:   &nid,
		ClientIP: c.ClientIP,
		Payload:  payload,
	})
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
