// Package wireguard exposes a read-mostly WireGuard control surface for the SSH
// ops dock: it parses `wg show all dump` over the pooled SSH connection into a
// structured per-interface / per-peer view (handshake freshness, transfer
// totals, endpoints, allowed IPs) and can bring an interface up/down via
// wg-quick. Reads require ActionConnect on the node; the up/down mutation is
// gated by network:manage at the route.
package wireguard

import (
	"context"
	"errors"
	"fmt"
	"strconv"
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

var (
	ErrDisabled         = errors.New("wireguard subsystem disabled")
	ErrUnauthorized     = errors.New("not authorized for node")
	ErrUnreachable      = errors.New("node unreachable")
	ErrPermissionDenied = errors.New("permission denied")
	ErrBadIface         = errors.New("invalid interface name")

	// Validation errors (validate.go is the first line of injection defence).
	ErrBadCIDR       = errors.New("invalid address/CIDR")
	ErrBadPort       = errors.New("invalid listen port")
	ErrBadMTU        = errors.New("invalid MTU")
	ErrBadKeepalive  = errors.New("invalid persistent keepalive")
	ErrBadKey        = errors.New("invalid WireGuard key")
	ErrBadAllowedIPs = errors.New("invalid allowed IPs")
	ErrBadEndpoint   = errors.New("invalid endpoint")
	ErrBadEgress     = errors.New("invalid egress interface")

	// Lifecycle / state errors.
	ErrNotInstalled      = errors.New("wireguard-tools not installed on node")
	ErrUnsupportedPkgMgr = errors.New("no supported package manager detected")
	ErrConfNotFound      = errors.New("interface config file not found")
	ErrConfExists        = errors.New("interface config already exists")
	ErrPeerNotFound      = errors.New("peer not found in interface config")
	ErrPeerExists        = errors.New("peer already exists in interface config")
	ErrSubnetFull        = errors.New("no free address available in interface subnet")
	ErrConfParse         = errors.New("failed to parse interface config")
	ErrConfConflict      = errors.New("interface config changed on disk since read")
	ErrConfirmRequired   = errors.New("destructive operation requires confirm=true")
)

type Config struct {
	Enabled           bool
	SSHTimeout        time.Duration // default 10s — short status/mutation commands
	InstallTimeout    time.Duration // default 300s — streamed package install
	CacheTTL          time.Duration // default 5s — Status cache window
	ConfDir           string        // default "/etc/wireguard"
	DefaultListenPort int           // default 51820 — fallback for new interfaces
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

// Peer is one WireGuard peer as reported by `wg show <if> dump`.
type Peer struct {
	PublicKey       string   `json:"public_key"`
	Endpoint        string   `json:"endpoint"`
	AllowedIPs      []string `json:"allowed_ips"`
	LatestHandshake int64    `json:"latest_handshake"` // unix seconds; 0 = never
	TransferRx      int64    `json:"transfer_rx"`      // bytes
	TransferTx      int64    `json:"transfer_tx"`      // bytes
	Keepalive       string   `json:"keepalive"`
}

type Iface struct {
	Name       string `json:"name"`
	PublicKey  string `json:"public_key"`
	ListenPort int    `json:"listen_port"`
	Peers      []Peer `json:"peers"`
	// Enriched metadata (from the conf file + systemctl), all optional so the
	// status payload stays backward compatible.
	Addresses []string `json:"addresses,omitempty"` // [Interface] Address CIDRs
	MTU       int      `json:"mtu,omitempty"`
	DNS       []string `json:"dns,omitempty"`
	Up        bool     `json:"up"`        // present in the kernel (wg show hit)
	Autostart bool     `json:"autostart"` // systemctl is-enabled wg-quick@<name>
	HasConf   bool     `json:"has_conf"`  // /etc/wireguard/<name>.conf exists
}

type Status struct {
	Available bool      `json:"available"`
	Reason    string    `json:"reason,omitempty"`
	Installed bool      `json:"installed"`     // `wg` command present on the host
	KernelMod bool      `json:"kernel_module"` // wireguard module loaded/available, or wireguard-go
	Ifaces    []Iface   `json:"ifaces"`
	SampledAt time.Time `json:"sampled_at"`
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
	at     time.Time
	status Status
}

func NewManager(cfg Config, deps Deps) *Manager {
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 10 * time.Second
	}
	if cfg.InstallTimeout <= 0 {
		cfg.InstallTimeout = 300 * time.Second
	}
	if cfg.CacheTTL <= 0 {
		cfg.CacheTTL = 5 * time.Second
	}
	if cfg.ConfDir == "" {
		cfg.ConfDir = "/etc/wireguard"
	}
	if cfg.DefaultListenPort <= 0 {
		cfg.DefaultListenPort = 51820
	}
	m := &Manager{cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds, asset: deps.Asset, audit: deps.Audit, deps: deps.SSH, cache: map[uint64]*cacheEntry{}}
	if m.logger != nil {
		m.logger.Info("wireguard subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

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

// runWG runs a single command against the node with the standard timeout and
// error classification: it inspects the combined output for permission errors
// first (sudo -n failures surface there, not as an exit error), then classifies
// the transport error. Returns the stdout (falling back to stderr when stdout
// is empty, since many wg-quick errors land on stderr).
func (m *Manager) runWG(ctx context.Context, node *model.Node, cred *model.Credential, cmd, op string, to time.Duration) (string, error) {
	if to <= 0 {
		to = m.cfg.SSHTimeout
	}
	cctx, cancel := context.WithTimeout(ctx, to)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, node, cred, cmd, to)
	if e := classifyOutput(res.Stdout + " " + res.Stderr); e != nil {
		return res.Stdout, e
	}
	if err != nil && res.Stdout == "" {
		return res.Stderr, classify(err, op)
	}
	out := res.Stdout
	if out == "" {
		out = res.Stderr
	}
	return out, nil
}

// statusScript builds the aggregated status probe: a single SSH round-trip that
// returns the live `wg show all dump`, every interface conf (for
// Address/MTU/DNS + conf-only interfaces that aren't up), each unit's autostart
// state, and the kernel-module situation. `wg show` needs root to read private
// keys / handshakes, so each privileged read prefers `sudo -n` and falls back
// to unprivileged. confDir is operator config (not user input) and is embedded
// raw so the *.conf glob expands. Section markers let parseStatus split it.
func statusScript(confDir string) string {
	return `if ! command -v wg >/dev/null 2>&1; then echo "__NO_WG__"; exit 0; fi
echo "===DUMP==="
(sudo -n wg show all dump 2>/dev/null || wg show all dump 2>/dev/null)
echo "===CONF==="
for f in ` + confDir + `/*.conf; do [ -e "$f" ] || continue; echo "@@FILE@@ $f"; (sudo -n cat "$f" 2>/dev/null || cat "$f" 2>/dev/null); echo "@@ENDFILE@@"; done
echo "===ENABLED==="
for f in ` + confDir + `/*.conf; do [ -e "$f" ] || continue; n=$(basename "$f" .conf); printf '%s %s\n' "$n" "$(systemctl is-enabled wg-quick@$n 2>/dev/null || echo unknown)"; done
echo "===MOD==="
( (lsmod 2>/dev/null | grep -q '^wireguard' && echo loaded) || (modinfo wireguard >/dev/null 2>&1 && echo available) || (command -v wireguard-go >/dev/null 2>&1 && echo userspace) || echo none )
echo "===END==="`
}

func (m *Manager) Status(ctx context.Context, userID, nodeID uint64) (*Status, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	if c := m.cached(nodeID); c != nil {
		s := c.status
		return &s, nil
	}
	v, err, _ := m.flight.Do(fmt.Sprintf("wg-status:%d", nodeID), func() (any, error) {
		s, err := m.collectStatus(ctx, node, cred)
		if err != nil {
			return nil, err
		}
		entry := &cacheEntry{at: time.Now().UTC(), status: *s}
		m.store(nodeID, entry)
		return entry, nil
	})
	if err != nil {
		return nil, err
	}
	s := v.(*cacheEntry).status
	return &s, nil
}

// collectStatus runs the on-host status probe and parses it into a Status. The
// caller handles gating + caching; this is the SSH-bound part wrapped by
// singleflight. (Task 2 enriches this with the aggregated metadata script.)
func (m *Manager) collectStatus(ctx context.Context, node *model.Node, cred *model.Credential) (*Status, error) {
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, node, cred, statusScript(m.cfg.ConfDir), m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classify(err, "wg show")
	}
	return parseStatus(res.Stdout), nil
}

// SetInterface brings a WireGuard interface up or down via wg-quick.
func (m *Manager) SetInterface(ctx context.Context, userID, nodeID uint64, claims AuditClaims, name string, up bool) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validIface(name) {
		return ErrBadIface
	}
	verb := "up"
	if !up {
		verb = "down"
	}
	q := shellQuote(name)
	cmd := fmt.Sprintf("sudo -n wg-quick %s %s 2>&1 || wg-quick %s %s 2>&1", verb, q, verb, q)
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, node, cred, cmd, m.cfg.SSHTimeout)
	if e := classifyOutput(res.Stdout + " " + res.Stderr); e != nil {
		return e
	}
	if err != nil {
		return classify(err, "wg-quick")
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard %s %s", verb, name))
	return nil
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
		Kind: model.AuditNetworkAction, UserID: c.UserID, Username: c.Username,
		NodeID: &nid, ClientIP: c.ClientIP, Payload: payload,
	})
}

// parseDump parses `wg show all dump`. Interface lines have 5 tab-separated
// fields (name, privkey, pubkey, listen-port, fwmark); peer lines have 8–9
// (name, pubkey, psk, endpoint, allowed-ips, handshake, rx, tx, keepalive).
// Both are keyed by the interface name in column 0.
func parseDump(raw string) []Iface {
	order := []string{}
	byName := map[string]*Iface{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < 5 {
			continue
		}
		name := f[0]
		ifc := byName[name]
		if ifc == nil {
			ifc = &Iface{Name: name}
			byName[name] = ifc
			order = append(order, name)
		}
		if len(f) == 5 {
			ifc.PublicKey = f[2]
			ifc.ListenPort = atoi(f[3])
			continue
		}
		p := Peer{
			PublicKey:       f[1],
			Endpoint:        dashEmpty(f[3]),
			AllowedIPs:      splitList(f[4]),
			LatestHandshake: atoi64(f[5]),
			TransferRx:      atoi64(f[6]),
			TransferTx:      atoi64(f[7]),
		}
		if len(f) >= 9 {
			p.Keepalive = dashEmpty(f[8])
		}
		ifc.Peers = append(ifc.Peers, p)
	}
	out := make([]Iface, 0, len(order))
	for _, n := range order {
		out = append(out, *byName[n])
	}
	return out
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
		strings.Contains(low, "must be run as root") || strings.Contains(low, "a password is required") {
		return fmt.Errorf("%w: %s", ErrPermissionDenied, strings.TrimSpace(truncate(out, 160)))
	}
	return nil
}

// validIface enforces the kernel interface-name limit (IFNAMSIZ-1 = 15) and a
// safe charset, so a name is always shell-safe and usable by wg-quick.
func validIface(name string) bool {
	if name == "" || len(name) > 15 {
		return false
	}
	for _, r := range name {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func splitList(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" || s == "(none)" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func dashEmpty(s string) string {
	if s == "(none)" || s == "off" {
		return ""
	}
	return s
}

func atoi(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

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
