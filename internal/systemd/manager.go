package systemd

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

// Config controls per-node caching of the unit snapshot. Mutations are always
// synchronous; reads are deduplicated within CacheTTL.
type Config struct {
	Enabled    bool
	CacheTTL   time.Duration // default 5s
	SSHTimeout time.Duration // default 12s — list-units can be chatty
}

// Manager fetches and controls systemd units over SSH on managed nodes.
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
	units  []Unit
}

// Deps groups the wiring values main.go passes at startup.
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
		cfg.SSHTimeout = 12 * time.Second
	}
	m := &Manager{
		cfg:    cfg,
		logger: deps.Logger,
		nodes:  deps.Nodes,
		creds:  deps.Creds,
		asset:  deps.Asset,
		audit:  deps.Audit,
		deps:   deps.SSH,
		cache:  map[uint64]*cacheEntry{},
	}
	if m.logger != nil {
		m.logger.Info("systemd subsystem ready",
			zap.Bool("enabled", cfg.Enabled),
			zap.Duration("cache_ttl", cfg.CacheTTL),
			zap.Duration("ssh_timeout", cfg.SSHTimeout))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

// Status returns the high-level systemd state of the node.
func (m *Manager) Status(ctx context.Context, userID, nodeID uint64) (*Status, error) {
	s, _, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	return &s, nil
}

// ListUnits returns the service units, optionally filtered by
// "running" / "failed" / "enabled" (anything else = all).
func (m *Manager) ListUnits(ctx context.Context, userID, nodeID uint64, filter string) ([]Unit, error) {
	_, units, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	return filterUnits(units, filter), nil
}

func filterUnits(units []Unit, filter string) []Unit {
	switch filter {
	case "running":
		out := make([]Unit, 0, len(units))
		for _, u := range units {
			if u.Active == "active" {
				out = append(out, u)
			}
		}
		return out
	case "failed":
		out := make([]Unit, 0)
		for _, u := range units {
			if u.Active == "failed" || u.Sub == "failed" {
				out = append(out, u)
			}
		}
		return out
	case "enabled":
		out := make([]Unit, 0, len(units))
		for _, u := range units {
			if u.Enabled == "enabled" {
				out = append(out, u)
			}
		}
		return out
	default:
		return units
	}
}

func (m *Manager) snapshot(ctx context.Context, userID, nodeID uint64) (Status, []Unit, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return Status{}, nil, err
	}
	if c := m.cached(nodeID); c != nil {
		return c.status, c.units, nil
	}
	key := fmt.Sprintf("snapshot:%d", nodeID)
	v, err, _ := m.flight.Do(key, func() (any, error) {
		return m.collect(ctx, nodeID, loaded)
	})
	if err != nil {
		return Status{}, nil, err
	}
	e := v.(*cacheEntry)
	return e.status, e.units, nil
}

// listScript fetches version, system state, live units and unit files in one
// round-trip. A missing systemctl short-circuits with a sentinel marker so we
// can return a clean "unavailable" status rather than a parse failure.
const listScript = `LC_ALL=C
command -v systemctl >/dev/null 2>&1 || { echo '__NOSYSTEMD__'; exit 0; }
echo '===VER==='
systemctl --version 2>/dev/null | head -1
echo '===STATE==='
systemctl is-system-running 2>/dev/null
echo '===UNITS==='
systemctl list-units --type=service --all --no-legend --no-pager --plain 2>/dev/null
echo '===FILES==='
systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null
echo '===END==='
`

func (m *Manager) collect(ctx context.Context, nodeID uint64, l *nodeAndCred) (*cacheEntry, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, l.node, l.cred, listScript, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, res.Stderr, "list units")
	}
	if strings.Contains(res.Stdout, "__NOSYSTEMD__") {
		entry := &cacheEntry{
			at: time.Now().UTC(),
			status: Status{
				Available: false,
				Reason:    "节点上未找到 systemctl —— 该主机可能不是 systemd 发行版（如 Alpine/OpenRC 或容器）",
				SampledAt: time.Now().UTC(),
			},
		}
		m.store(nodeID, entry)
		return entry, nil
	}

	sections := splitSections(res.Stdout)
	units := parseListUnits(sections["UNITS"])
	files := parseUnitFiles(sections["FILES"])
	for i := range units {
		if st, ok := files[units[i].Name]; ok {
			units[i].Enabled = st
		}
	}

	status := Status{
		Available:  true,
		Version:    parseVersion(sections["VER"]),
		State:      strings.TrimSpace(firstLine(sections["STATE"])),
		TotalUnits: len(units),
		SampledAt:  time.Now().UTC(),
	}
	for _, u := range units {
		if u.Active == "active" {
			status.RunningUnits++
		}
		if u.Active == "failed" || u.Sub == "failed" {
			status.FailedUnits++
		}
	}
	entry := &cacheEntry{at: status.SampledAt, status: status, units: units}
	m.store(nodeID, entry)
	return entry, nil
}

// Detail returns the expanded view (curated `systemctl show` + journal tail).
func (m *Manager) Detail(ctx context.Context, userID, nodeID uint64, unit string, journalLines int) (*Detail, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !validUnitName(unit) {
		return nil, ErrBadUnit
	}
	if journalLines <= 0 || journalLines > 1000 {
		journalLines = 200
	}
	q := shellQuote(unit)
	script := fmt.Sprintf(`LC_ALL=C
systemctl show %s --no-pager 2>/dev/null
echo '===JOURNAL==='
journalctl -u %s -n %d --no-pager --no-hostname 2>&1
echo '===END==='
`, q, q, journalLines)
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, script, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, res.Stderr, "show unit")
	}
	sections := splitSections(res.Stdout)
	raw := parseShow(sections[""]) // properties precede the first ===JOURNAL=== marker
	if len(raw) == 0 {
		// `systemctl show` always emits properties; an empty map means the
		// unit name didn't resolve.
		return nil, fmt.Errorf("%w: %s", ErrBadUnit, unit)
	}
	d := detailFromShow(raw)
	d.Journal = strings.TrimSpace(sections["JOURNAL"])
	d.SampledAt = time.Now().UTC()
	return &d, nil
}

// JournalTail returns a fresh tail of one unit's logs.
func (m *Manager) JournalTail(ctx context.Context, userID, nodeID uint64, unit string, lines int) (*Journal, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if !validUnitName(unit) {
		return nil, ErrBadUnit
	}
	if lines <= 0 || lines > 2000 {
		lines = 300
	}
	q := shellQuote(unit)
	script := fmt.Sprintf("LC_ALL=C\njournalctl -u %s -n %d --no-pager --no-hostname 2>&1", q, lines)
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, script, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classifySSHError(err, res.Stderr, "journal")
	}
	return &Journal{
		Unit:      unit,
		Lines:     lines,
		Text:      strings.TrimRight(res.Stdout, "\n"),
		SampledAt: time.Now().UTC(),
	}, nil
}

// Action runs a whitelisted control verb against a unit and audits it.
func (m *Manager) Action(ctx context.Context, userID, nodeID uint64, claims AuditClaims, unit string, verb Verb) error {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validUnitName(unit) {
		return ErrBadUnit
	}
	if !ValidVerb(verb) {
		return ErrBadVerb
	}
	cmd := fmt.Sprintf("systemctl %s %s 2>&1", string(verb), shellQuote(unit))
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd, m.cfg.SSHTimeout)
	if err != nil {
		return classifySSHError(err, res.Stderr+res.Stdout, string(verb))
	}
	if e := classifyToolOutput(res.Stdout + " " + res.Stderr); e != nil {
		return e
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditServiceAction, fmt.Sprintf("%s %s", verb, unit))
	return nil
}

// ---- cache + plumbing ---------------------------------------------------

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
		Kind:     kind,
		UserID:   c.UserID,
		Username: c.Username,
		NodeID:   &nid,
		ClientIP: c.ClientIP,
		Payload:  payload,
	})
}

// classifySSHError maps a raw sshrun error onto a package sentinel so handlers
// can pick the right HTTP status, preserving stderr for diagnosis.
func classifySSHError(err error, stderr, op string) error {
	if err == nil {
		return nil
	}
	msg := strings.ToLower(stderr)
	switch {
	case strings.Contains(msg, "permission denied") || strings.Contains(msg, "must be root") ||
		strings.Contains(msg, "access denied") || strings.Contains(msg, "interactive authentication required") ||
		strings.Contains(msg, "operation not permitted"):
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

// classifyToolOutput catches permission failures that systemctl exits 0 on.
func classifyToolOutput(out string) error {
	low := strings.ToLower(out)
	if strings.Contains(low, "interactive authentication required") ||
		strings.Contains(low, "access denied") ||
		strings.Contains(low, "permission denied") {
		return fmt.Errorf("%w: %s", ErrPermissionDenied, truncate(out, 200))
	}
	return nil
}

// splitSections slices marker-delimited output (===NAME===). Text before the
// first marker is keyed "". The trailing END marker is dropped.
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

func firstLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		t := strings.TrimSpace(line)
		if t != "" {
			return t
		}
	}
	return ""
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}
