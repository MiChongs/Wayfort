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
	Enabled           bool
	CacheTTL          time.Duration // default 5s
	SSHTimeout        time.Duration // default 10s
	InstallTimeout    time.Duration // default 300s — streamed package install
	ConntrackMax      int           // default 500 — cap conntrack rows
	DefaultArmSeconds int           // default 60 — auto-rollback window
	SSHPortGuard      bool          // default true — never lock out current SSH
}

// armState tracks a pending safe-apply rollback for a node (in-memory; the
// host-side watchdog is the real safety net — this just serialises arming and
// lets commit/rollback find the job ref).
type armState struct {
	token     string
	snapID    string
	via       string
	jobRef    string
	expiresAt time.Time
}

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
	armed  map[uint64]*armState
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
	if cfg.InstallTimeout <= 0 {
		cfg.InstallTimeout = 300 * time.Second
	}
	if cfg.ConntrackMax <= 0 {
		cfg.ConntrackMax = 500
	}
	if cfg.DefaultArmSeconds <= 0 {
		cfg.DefaultArmSeconds = 60
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
		armed:  map[uint64]*armState{},
	}
	// Startup observability — the absence of this log on boot tells the
	// operator immediately that the firewall subsystem isn't wired into
	// their gateway binary. The plan calls for this specifically.
	if m.logger != nil {
		m.logger.Info("firewall subsystem ready",
			zap.Bool("enabled", cfg.Enabled),
			zap.Duration("cache_ttl", cfg.CacheTTL),
			zap.Duration("ssh_timeout", cfg.SSHTimeout))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

// Status returns just the high-level state (tool/active/policy/count).
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
	// Step 1: detect tools (including nft + ip6tables).
	probe, err := sshrun.Run(cctx, m.deps, l.node, l.cred, probeScript, m.cfg.SSHTimeout)
	if err != nil {
		return nil, classifySSHError(err, probe.Stderr, "probe firewall")
	}
	tool := detectTool(probe.Stdout)
	m.debug("firewall probe",
		zap.Uint64("node_id", nodeID),
		zap.String("probe_raw", probe.Stdout),
		zap.String("selected_tool", string(tool)))
	if tool == ToolUnsupported {
		return m.unsupportedEntry(nodeID), nil
	}
	// Step 2: collect rules. iptables fans out across 3 chains × 2 families;
	// others are one or two SSH calls.
	status, rules, err := m.listRules(cctx, l, tool)
	if err != nil {
		return nil, err
	}
	status.Installed = true
	status.SSHPort = int(l.node.Port)
	status.SampledAt = time.Now().UTC()
	entry := &cacheEntry{at: status.SampledAt, status: status, rules: rules}
	m.store(nodeID, entry)
	return entry, nil
}

// probeScript probes every supported front-end binary at once. POSIX-safe
// shell — runs on bash / sh / dash / busybox identically.
const probeScript = `printf 'ufw=%s\nfirewalld=%s\nnft=%s\niptables=%s\nip6tables=%s\n' ` +
	`"$(command -v ufw 2>/dev/null)" ` +
	`"$(command -v firewall-cmd 2>/dev/null)" ` +
	`"$(command -v nft 2>/dev/null)" ` +
	`"$(command -v iptables 2>/dev/null)" ` +
	`"$(command -v ip6tables 2>/dev/null)"`

func (m *Manager) listRules(ctx context.Context, l *nodeAndCred, tool Tool) (Status, []Rule, error) {
	switch tool {
	case ToolUFW:
		res, err := sshrun.Run(ctx, m.deps, l.node, l.cred, "ufw status verbose 2>&1", m.cfg.SSHTimeout)
		if err != nil && res.Stdout == "" {
			return Status{}, nil, classifySSHError(err, res.Stderr, "list ufw")
		}
		if e := classifyToolOutput(res.Stdout + " " + res.Stderr); e != nil {
			return Status{}, nil, e
		}
		s, r := parseUFWStatus(res.Stdout)
		return s, r, nil
	case ToolFirewalld:
		res, err := sshrun.Run(ctx, m.deps, l.node, l.cred,
			"firewall-cmd --list-all 2>&1; firewall-cmd --state 2>&1", m.cfg.SSHTimeout)
		if err != nil && res.Stdout == "" {
			return Status{}, nil, classifySSHError(err, res.Stderr, "list firewalld")
		}
		if e := classifyToolOutput(res.Stdout + " " + res.Stderr); e != nil {
			return Status{}, nil, e
		}
		s, r := parseFirewalldList(res.Stdout)
		return s, r, nil
	case ToolNftables:
		res, err := sshrun.Run(ctx, m.deps, l.node, l.cred, "nft -j -a list ruleset 2>&1", m.cfg.SSHTimeout)
		if err != nil && res.Stdout == "" {
			return Status{}, nil, classifySSHError(err, res.Stderr, "list nft")
		}
		if e := classifyToolOutput(res.Stdout + " " + res.Stderr); e != nil {
			return Status{}, nil, e
		}
		s, r, perr := parseNftables(res.Stdout)
		if perr != nil {
			return Status{}, nil, fmt.Errorf("%w: %v", ErrParse, perr)
		}
		return s, r, nil
	case ToolIPTables:
		return m.listIPTables(ctx, l)
	default:
		return Status{}, nil, ErrNoTool
	}
}

// listIPTables fans out to iptables + ip6tables × {INPUT, FORWARD, OUTPUT}.
// We merge per-chain rules into one slice; Chain + Family on each Rule lets
// the UI render proper groups. INPUT-v4's policy is the coarse "Status.Policy".
func (m *Manager) listIPTables(ctx context.Context, l *nodeAndCred) (Status, []Rule, error) {
	chains := []string{"INPUT", "FORWARD", "OUTPUT"}
	binaries := []struct {
		bin    string
		family Family
	}{
		{"iptables", FamilyV4},
		{"ip6tables", FamilyV6},
	}
	var merged []Rule
	var status Status
	status.Tool = ToolIPTables
	status.Active = true
	for _, b := range binaries {
		for _, chain := range chains {
			cmd := fmt.Sprintf("%s -L %s -n -v -x --line-numbers 2>&1", b.bin, chain)
			res, err := sshrun.Run(ctx, m.deps, l.node, l.cred, cmd, m.cfg.SSHTimeout)
			if err != nil && res.Stdout == "" {
				// ip6tables may legitimately not exist on this host — only
				// fail the whole call if iptables itself failed.
				if b.bin == "iptables" {
					return Status{}, nil, classifySSHError(err, res.Stderr, "iptables -L "+chain)
				}
				continue
			}
			if e := classifyToolOutput(res.Stdout + " " + res.Stderr); e != nil {
				if b.bin == "iptables" {
					return Status{}, nil, e
				}
				continue
			}
			s, r := parseIPTablesList(res.Stdout, chain, b.family)
			if b.family == FamilyV4 && chain == "INPUT" && s.Policy != "" {
				status.Policy = s.Policy
			}
			merged = append(merged, r...)
		}
	}
	status.RuleCount = len(merged)
	return status, merged, nil
}

// runFW runs one command against the node, classifying tool-output permission
// errors first (some tools exit 0 on them), then transport errors. Returns
// stdout (falling back to stderr when stdout is empty). Shared by the new
// mutators / install / safe-apply paths.
func (m *Manager) runFW(ctx context.Context, l *nodeAndCred, cmd, op string, to time.Duration) (string, error) {
	if to <= 0 {
		to = m.cfg.SSHTimeout
	}
	cctx, cancel := context.WithTimeout(ctx, to)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, l.node, l.cred, cmd, to)
	if e := classifyToolOutput(res.Stdout + " " + res.Stderr); e != nil {
		return res.Stdout, e
	}
	if err != nil && res.Stdout == "" {
		return res.Stderr, classifySSHError(err, res.Stderr, op)
	}
	out := res.Stdout
	if out == "" {
		out = res.Stderr
	}
	return out, nil
}

func (m *Manager) unsupportedEntry(nodeID uint64) *cacheEntry {
	now := time.Now().UTC()
	entry := &cacheEntry{
		at: now,
		status: Status{
			Tool:      ToolUnsupported,
			Active:    false,
			Reason:    "no firewall front-end detected (ufw / firewalld / nft / iptables); install one to manage rules",
			SampledAt: now,
		},
	}
	m.store(nodeID, entry)
	return entry
}

// Diagnose runs a focused set of probes that surface every observation the
// manager makes when it tries to read firewall state. It deliberately
// doesn't write or escalate — it's the "why isn't this working" endpoint.
func (m *Manager) Diagnose(ctx context.Context, userID, nodeID uint64) (*Diagnostics, error) {
	loaded, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	d := &Diagnostics{SampledAt: started.UTC()}

	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()

	// uid probe — `id -u` is POSIX and works under every common shell.
	if uidRes, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, "id -u 2>/dev/null", m.cfg.SSHTimeout); err == nil {
		if uid, e := atoiSafe(strings.TrimSpace(uidRes.Stdout)); e == nil {
			d.UID = uid
			d.IsRoot = uid == 0
		}
	} else {
		d.LastError = appendErr(d.LastError, fmt.Sprintf("id -u: %v", err))
	}

	// sudo availability — only check the binary exists. We do NOT auto-wrap
	// firewall commands with sudo elsewhere; this is observation only.
	if sudoRes, _ := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred,
		"command -v sudo 2>/dev/null", m.cfg.SSHTimeout); strings.TrimSpace(sudoRes.Stdout) != "" {
		d.SudoAvailable = true
		// Pull the NOPASSWD allowlist for diagnostic display. `sudo -n -l`
		// fails with no error if no entries exist, which is fine.
		if listRes, _ := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred,
			"sudo -n -l 2>/dev/null", m.cfg.SSHTimeout); listRes.Stdout != "" {
			for _, line := range strings.Split(listRes.Stdout, "\n") {
				low := strings.ToLower(line)
				if !strings.Contains(low, "nopasswd") {
					continue
				}
				for _, t := range []string{"ufw", "firewall-cmd", "nft", "iptables", "ip6tables"} {
					if strings.Contains(low, t) {
						d.SudoNopasswdTools = appendUnique(d.SudoNopasswdTools, t)
					}
				}
			}
		}
	}

	// Tool probe — same shape as the production path; surface raw for the UI.
	probeRes, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, probeScript, m.cfg.SSHTimeout)
	if err != nil {
		d.LastError = appendErr(d.LastError, fmt.Sprintf("probe: %v", err))
	}
	d.ProbeRaw = probeRes.Stdout
	for _, line := range strings.Split(probeRes.Stdout, "\n") {
		line = strings.TrimSpace(line)
		k, v, ok := strings.Cut(line, "=")
		if !ok || v == "" {
			continue
		}
		d.ToolsFound = append(d.ToolsFound, k+"="+v)
	}
	d.SelectedTool = detectTool(probeRes.Stdout)

	d.ElapsedMs = time.Since(started).Milliseconds()
	return d, nil
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
		return ErrNoTool
	}
	cmd, err := buildAddCommand(status.Tool, spec)
	if err != nil {
		return err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd+" 2>&1", m.cfg.SSHTimeout)
	if err != nil {
		return classifySSHError(err, res.Stderr+res.Stdout, "add rule")
	}
	if e := classifyToolOutput(res.Stdout + " " + res.Stderr); e != nil {
		return e
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditFirewallChange, "add "+cmd)
	return nil
}

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
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd+" 2>&1", m.cfg.SSHTimeout)
	if err != nil {
		return classifySSHError(err, res.Stderr+res.Stdout, "delete rule")
	}
	if e := classifyToolOutput(res.Stdout + " " + res.Stderr); e != nil {
		return e
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditFirewallChange, "delete "+cmd)
	return nil
}

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
	case ToolNftables:
		return errors.New("nftables has no enable/disable; manage the service (systemctl start/stop nftables) that loads its rules")
	case ToolIPTables:
		return errors.New("iptables has no enable/disable; manage the service that loads its rules")
	default:
		return ErrNoTool
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, loaded.node, loaded.cred, cmd+" 2>&1", m.cfg.SSHTimeout)
	if err != nil {
		return classifySSHError(err, res.Stderr+res.Stdout, "set enabled")
	}
	if e := classifyToolOutput(res.Stdout + " " + res.Stderr); e != nil {
		return e
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
	case ToolNftables:
		return buildNftablesAdd(spec), nil
	default:
		return "", ErrNoTool
	}
}

// ---- error classification ----------------------------------------------

// classifySSHError maps a raw sshrun error onto one of the package sentinels
// so handlers can pick the right HTTP status. The stderr text is preserved
// in the wrapped error for operator diagnosis.
func classifySSHError(err error, stderr, op string) error {
	if err == nil {
		return nil
	}
	msg := strings.ToLower(stderr)
	switch {
	case strings.Contains(msg, "permission denied") || strings.Contains(msg, "need to be root") ||
		strings.Contains(msg, "operation not permitted") || strings.Contains(msg, "you need root"):
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

// classifyToolOutput inspects the command's stdout+stderr for canonical
// permission-denied messages that the tool exited 0 on (some ufw versions
// do exactly this). Returns nil when no flag found.
func classifyToolOutput(out string) error {
	low := strings.ToLower(out)
	if strings.Contains(low, "you need to be root to run this script") ||
		strings.Contains(low, "operation not permitted") {
		return fmt.Errorf("%w: %s", ErrPermissionDenied, truncate(out, 200))
	}
	return nil
}

func atoiSafe(s string) (int, error) {
	if s == "" {
		return 0, errors.New("empty")
	}
	var n int
	for _, r := range s {
		if r < '0' || r > '9' {
			return 0, errors.New("not numeric")
		}
		n = n*10 + int(r-'0')
	}
	return n, nil
}

func appendErr(existing, add string) string {
	if existing == "" {
		return add
	}
	return existing + "; " + add
}

func appendUnique(xs []string, x string) []string {
	for _, v := range xs {
		if v == x {
			return xs
		}
	}
	return append(xs, x)
}

func (m *Manager) debug(msg string, fields ...zap.Field) {
	if m.logger == nil {
		return
	}
	m.logger.Debug(msg, fields...)
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
