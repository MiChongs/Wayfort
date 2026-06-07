// Package capture exposes a bounded packet-capture surface for the SSH ops dock:
// list capturable interfaces, run a time/count-bounded tcpdump that returns a
// decoded packet summary, and download the same capture as a .pcap. Captures
// are bounded (timeout + packet count) so they run as ordinary one-shot SSH
// commands — no long-lived streaming session. Packet sniffing is privileged, so
// every operation here is gated by network:manage at the route and audited.
package capture

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
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
	ErrDisabled         = errors.New("capture subsystem disabled")
	ErrUnauthorized     = errors.New("not authorized for node")
	ErrUnreachable      = errors.New("node unreachable")
	ErrPermissionDenied = errors.New("permission denied")
	ErrNoTcpdump        = errors.New("tcpdump not installed")
	ErrBadArg           = errors.New("invalid argument")
)

const (
	maxCount   = 2000
	maxSeconds = 60
)

type Config struct {
	Enabled bool
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

type Interfaces struct {
	HasTcpdump bool     `json:"has_tcpdump"`
	Ifaces     []string `json:"ifaces"`
}

type CaptureResult struct {
	Lines     []string  `json:"lines"`
	Count     int       `json:"count"`
	SampledAt time.Time `json:"sampled_at"`
}

type PcapResult struct {
	Filename string `json:"filename"`
	Base64   string `json:"base64"`
	Bytes    int    `json:"bytes"`
}

type Opts struct {
	Iface   string
	Filter  string
	Count   int
	Seconds int
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
	m := &Manager{cfg: cfg, logger: deps.Logger, nodes: deps.Nodes, creds: deps.Creds, asset: deps.Asset, audit: deps.Audit, deps: deps.SSH}
	if m.logger != nil {
		m.logger.Info("capture subsystem ready", zap.Bool("enabled", cfg.Enabled))
	}
	return m
}

func (m *Manager) Enabled() bool { return m.cfg.Enabled }

const ifaceScript = `if ! command -v tcpdump >/dev/null 2>&1; then echo "__NO_TCPDUMP__"; fi; ls -1 /sys/class/net 2>/dev/null`

func (m *Manager) Interfaces(ctx context.Context, userID, nodeID uint64) (*Interfaces, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	res, err := m.run(ctx, node, cred, ifaceScript, 10*time.Second)
	if err != nil && res.Stdout == "" {
		return nil, classify(err, "interfaces")
	}
	out := &Interfaces{HasTcpdump: true}
	for _, line := range strings.Split(res.Stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if line == "__NO_TCPDUMP__" {
			out.HasTcpdump = false
			continue
		}
		out.Ifaces = append(out.Ifaces, line)
	}
	return out, nil
}

func (m *Manager) buildCmd(o Opts, write bool) (string, time.Duration, error) {
	if !validIface(o.Iface) {
		return "", 0, ErrBadArg
	}
	if o.Filter != "" && !validFilter(o.Filter) {
		return "", 0, ErrBadArg
	}
	count := o.Count
	if count <= 0 || count > maxCount {
		count = 200
	}
	secs := o.Seconds
	if secs <= 0 || secs > maxSeconds {
		secs = 20
	}
	filter := ""
	if o.Filter != "" {
		filter = " " + shellQuote(o.Filter)
	}
	qi := shellQuote(o.Iface)
	// timeout bounds the wait when traffic is sparse; -c bounds the packet count.
	// Exit 124 (timeout) is fine — we keep whatever was captured.
	var td string
	if write {
		td = fmt.Sprintf(`timeout %d sh -c '(sudo -n tcpdump -nn -i %s -c %d -w - %s 2>/dev/null || tcpdump -nn -i %s -c %d -w - %s 2>/dev/null)' | base64 | tr -d '\n'`,
			secs, qi, count, filter, qi, count, filter)
	} else {
		td = fmt.Sprintf(`timeout %d sh -c '(sudo -n tcpdump -nn -tttt -i %s -c %d %s 2>/dev/null || tcpdump -nn -tttt -i %s -c %d %s 2>/dev/null)'`,
			secs, qi, count, filter, qi, count, filter)
	}
	return td, time.Duration(secs+10) * time.Second, nil
}

func (m *Manager) Capture(ctx context.Context, userID, nodeID uint64, claims AuditClaims, o Opts) (*CaptureResult, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	cmd, to, err := m.buildCmd(o, false)
	if err != nil {
		return nil, err
	}
	res, err := m.run(ctx, node, cred, cmd, to)
	if err != nil && res.Stdout == "" {
		return nil, classify(err, "tcpdump")
	}
	lines := []string{}
	for _, l := range strings.Split(strings.TrimRight(res.Stdout, "\n"), "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	m.recordAudit(claims, nodeID, fmt.Sprintf("capture %s filter=%q n=%d", o.Iface, o.Filter, len(lines)))
	return &CaptureResult{Lines: lines, Count: len(lines), SampledAt: time.Now().UTC()}, nil
}

func (m *Manager) Pcap(ctx context.Context, userID, nodeID uint64, claims AuditClaims, o Opts) (*PcapResult, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	cmd, to, err := m.buildCmd(o, true)
	if err != nil {
		return nil, err
	}
	res, err := m.run(ctx, node, cred, cmd, to)
	if err != nil && res.Stdout == "" {
		return nil, classify(err, "tcpdump -w")
	}
	b64 := strings.TrimSpace(res.Stdout)
	raw, derr := base64.StdEncoding.DecodeString(b64)
	if derr != nil || len(raw) == 0 {
		return nil, fmt.Errorf("capture produced no data (no matching traffic, or insufficient privilege for tcpdump)")
	}
	m.recordAudit(claims, nodeID, fmt.Sprintf("pcap %s filter=%q bytes=%d", o.Iface, o.Filter, len(raw)))
	return &PcapResult{Filename: fmt.Sprintf("%s.pcap", o.Iface), Base64: b64, Bytes: len(raw)}, nil
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
		Kind: model.AuditNetworkAction, UserID: c.UserID, Username: c.Username,
		NodeID: &nid, ClientIP: c.ClientIP, Payload: payload,
	})
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

func validIface(s string) bool {
	if s == "" || len(s) > 32 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.' || r == '@') {
			return false
		}
	}
	return true
}

// validFilter allows a conservative BPF charset. shellQuote still neutralises
// shell metacharacters; this rejects the obviously dangerous ones up front.
func validFilter(s string) bool {
	if len(s) > 256 {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == ' ' || r == '.' || r == ':' || r == '/' || r == '(' || r == ')' || r == '[' || r == ']' || r == '-' || r == '_':
		default:
			return false
		}
	}
	return true
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
