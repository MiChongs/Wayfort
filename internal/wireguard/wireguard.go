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
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
	"go.uber.org/zap"
)

var (
	ErrDisabled         = errors.New("wireguard subsystem disabled")
	ErrUnauthorized     = errors.New("not authorized for node")
	ErrUnreachable      = errors.New("node unreachable")
	ErrPermissionDenied = errors.New("permission denied")
	ErrBadIface         = errors.New("invalid interface name")
)

type Config struct {
	Enabled    bool
	SSHTimeout time.Duration // default 10s
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
}

type Status struct {
	Available bool      `json:"available"`
	Reason    string    `json:"reason,omitempty"`
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
}

func NewManager(cfg Config, deps Deps) *Manager {
	if cfg.SSHTimeout <= 0 {
		cfg.SSHTimeout = 10 * time.Second
	}
	m := &Manager{cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds, asset: deps.Asset, audit: deps.Audit, deps: deps.SSH}
	if m.logger != nil {
		m.logger.Info("wireguard subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

// statusScript prefers a passwordless-sudo dump (wg show needs root to read
// private keys / handshakes) and falls back to an unprivileged dump. A sentinel
// distinguishes "wg not installed" from "no interfaces / insufficient rights".
const statusScript = `if ! command -v wg >/dev/null 2>&1; then echo "__NO_WG__"; else (sudo -n wg show all dump 2>/dev/null || wg show all dump 2>/dev/null); fi`

func (m *Manager) Status(ctx context.Context, userID, nodeID uint64) (*Status, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	cctx, cancel := context.WithTimeout(ctx, m.cfg.SSHTimeout)
	defer cancel()
	res, err := sshrun.Run(cctx, m.deps, node, cred, statusScript, m.cfg.SSHTimeout)
	if err != nil && res.Stdout == "" {
		return nil, classify(err, "wg show")
	}
	out := strings.TrimSpace(res.Stdout)
	if out == "__NO_WG__" {
		return &Status{Available: false, Reason: "目标主机未安装 WireGuard（未找到 wg 命令）。", SampledAt: time.Now().UTC()}, nil
	}
	ifaces := parseDump(out)
	if len(ifaces) == 0 {
		return &Status{Available: false, Reason: "未发现 WireGuard 接口，或当前 SSH 用户无权读取（需 root / sudo NOPASSWD）。", SampledAt: time.Now().UTC()}, nil
	}
	return &Status{Available: true, Ifaces: ifaces, SampledAt: time.Now().UTC()}, nil
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

func validIface(name string) bool {
	if name == "" || len(name) > 32 {
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
