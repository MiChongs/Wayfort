package pkg

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
	Enabled       bool
	CacheTTL      time.Duration // default 15s
	SSHTimeout    time.Duration // default 20s (status/search)
	ActionTimeout time.Duration // default 180s (install/upgrade can be slow)
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
	at      time.Time
	status  Status
	updates []Update
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
		cfg.CacheTTL = 15 * time.Second
	}
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 20 * time.Second
	}
	if cfg.ActionTimeout <= 0 {
		cfg.ActionTimeout = 180 * time.Second
	}
	m := &Manager{cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds, asset: deps.Asset, audit: deps.Audit, deps: deps.SSH, cache: map[uint64]*entry{}}
	if m.logger != nil {
		m.logger.Info("pkg subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

func (m *Manager) snapshot(ctx context.Context, userID, nodeID uint64) (*entry, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	m.mu.Lock()
	if c, ok := m.cache[nodeID]; ok && time.Since(c.at) < m.cfg.CacheTTL {
		cp := *c
		m.mu.Unlock()
		return &cp, nil
	}
	m.mu.Unlock()
	v, err, _ := m.flight.Do(fmt.Sprintf("pkg:%d", nodeID), func() (any, error) {
		return m.collect(ctx, nodeID, loaded)
	})
	if err != nil {
		return nil, err
	}
	return v.(*entry), nil
}

func (m *Manager) Status(ctx context.Context, userID, nodeID uint64) (*Status, error) {
	e, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	return &e.status, nil
}

func (m *Manager) Upgradable(ctx context.Context, userID, nodeID uint64) ([]Update, error) {
	e, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	return e.updates, nil
}

func (m *Manager) collect(ctx context.Context, nodeID uint64, l *nodeAndCred) (*entry, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	probe, err := sshrun.Run(cctx, m.deps, l.node, l.cred, detectScript, m.cfg.SSHTimeout)
	if err != nil && probe.Stdout == "" {
		return nil, classifySSHError(err, "detect pkg manager")
	}
	kind := detectManager(probe.Stdout)
	if kind == KindNone {
		e := &entry{at: time.Now(), status: Status{Available: false, Reason: "未检测到受支持的包管理器（apt/dnf/yum/apk/zypper）。", SampledAt: time.Now().UTC()}}
		m.store(nodeID, e)
		return e, nil
	}
	res, err := sshrun.Run(cctx, m.deps, l.node, l.cred, statusScript(kind), m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, "pkg status")
	}
	sec := splitSections(res.Stdout)
	ups := parseUpgradable(kind, sec["UPG"])
	e := &entry{
		at: time.Now(),
		status: Status{
			Manager: kind, Available: true,
			InstalledCount:  parseCount(sec["COUNT"]),
			UpgradableCount: len(ups),
			SecurityCount:   countSecurity(ups),
			SampledAt:       time.Now().UTC(),
		},
		updates: ups,
	}
	m.store(nodeID, e)
	return e, nil
}

// Search runs the manager's search for a query.
func (m *Manager) Search(ctx context.Context, userID, nodeID uint64, query string) ([]Pkg, error) {
	e, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !e.status.Available {
		return nil, ErrNoManager
	}
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	script, err := searchScript(e.status.Manager, query)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, script, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, "pkg search")
	}
	return parseSearch(e.status.Manager, res.Stdout), nil
}

// Info returns expanded detail of one package.
func (m *Manager) Info(ctx context.Context, userID, nodeID uint64, name string) (*Info, error) {
	e, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !e.status.Available {
		return nil, ErrNoManager
	}
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	script, err := infoScript(e.status.Manager, name)
	if err != nil {
		return nil, err
	}
	res, err := m.run(ctx, loaded, script)
	if err != nil {
		return nil, err
	}
	info := parseInfo(e.status.Manager, name, res)
	return &info, nil
}

// Installed lists installed packages (filtered by query substring).
func (m *Manager) Installed(ctx context.Context, userID, nodeID uint64, query string) ([]Pkg, error) {
	e, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !e.status.Available {
		return nil, ErrNoManager
	}
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	res, err := m.run(ctx, loaded, installedScript(e.status.Manager))
	if err != nil {
		return nil, err
	}
	all := parseInstalled(e.status.Manager, res)
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return all, nil
	}
	out := make([]Pkg, 0, 64)
	for _, p := range all {
		if strings.Contains(strings.ToLower(p.Name), q) {
			out = append(out, p)
		}
	}
	return out, nil
}

// Files lists the files a package owns.
func (m *Manager) Files(ctx context.Context, userID, nodeID uint64, name string) ([]string, error) {
	e, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	script, err := filesScript(e.status.Manager, name)
	if err != nil {
		return nil, err
	}
	res, err := m.run(ctx, loaded, script)
	if err != nil {
		return nil, err
	}
	return splitNonEmptyLines(res), nil
}

// History returns recent package-manager transactions.
func (m *Manager) History(ctx context.Context, userID, nodeID uint64) ([]string, error) {
	e, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	res, err := m.run(ctx, loaded, historyScript(e.status.Manager))
	if err != nil {
		return nil, err
	}
	return splitNonEmptyLines(res), nil
}

// Hold pins/unpins a package version (package:manage).
func (m *Manager) Hold(ctx context.Context, userID, nodeID uint64, claims AuditClaims, name string, hold bool) error {
	e, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	cmd, err := holdCommand(e.status.Manager, name, hold)
	if err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, m.cfg.SSHTimeout)
	if err != nil {
		return classifyWrite(err, res.Stderr+res.Stdout, "hold")
	}
	if e := classifyOutput(res.Stdout + " " + res.Stderr); e != nil {
		return e
	}
	verb := "hold"
	if !hold {
		verb = "unhold"
	}
	m.recordAudit(claims, nodeID, fmt.Sprintf("pkg %s %s", verb, name))
	return nil
}

// run is a small read helper used by Info/Installed/Files/History.
func (m *Manager) run(ctx context.Context, l *nodeAndCred, script string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, l.node, l.cred, script, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return "", classifySSHError(err, "pkg query")
	}
	return res.Stdout, nil
}

// Do runs a write action (install/remove/upgrade/upgrade-all/update) and audits.
func (m *Manager) Do(ctx context.Context, userID, nodeID uint64, claims AuditClaims, verb Verb, name string) (*ActionResult, error) {
	e, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !e.status.Available {
		return nil, ErrNoManager
	}
	if !ValidVerb(verb) {
		return nil, ErrBadVerb
	}
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	cmd, err := actionCommand(e.status.Manager, verb, name)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.ActionTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, m.cfg.ActionTimeout)
	out := res.Stdout
	if out == "" {
		out = res.Stderr
	}
	if err != nil && out == "" {
		return nil, classifyWrite(err, res.Stderr, string(verb))
	}
	if e := classifyOutput(out); e != nil {
		return nil, e
	}
	m.invalidate(nodeID)
	payload := string(verb)
	if name != "" {
		payload += " " + name
	}
	m.recordAudit(claims, nodeID, "pkg "+payload)
	return &ActionResult{OK: err == nil, Output: strings.TrimRight(out, "\n")}, nil
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

func (m *Manager) store(nodeID uint64, e *entry) {
	m.mu.Lock()
	m.cache[nodeID] = e
	m.mu.Unlock()
}
func (m *Manager) invalidate(nodeID uint64) {
	m.mu.Lock()
	delete(m.cache, nodeID)
	m.mu.Unlock()
}

func (m *Manager) recordAudit(c AuditClaims, nodeID uint64, payload string) {
	if m.audit == nil {
		return
	}
	nid := nodeID
	m.audit.Log(model.AuditLog{Kind: model.AuditPackageAction, UserID: c.UserID, Username: c.Username, NodeID: &nid, ClientIP: c.ClientIP, Payload: payload})
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
	if e := classifyOutput(out); e != nil {
		return e
	}
	return classifySSHError(err, op)
}

func classifyOutput(out string) error {
	low := strings.ToLower(out)
	if strings.Contains(low, "permission denied") || strings.Contains(low, "are you root") ||
		strings.Contains(low, "operation not permitted") || strings.Contains(low, "superuser") {
		return fmt.Errorf("%w: %s", ErrPermissionDenied, truncate(out, 200))
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
