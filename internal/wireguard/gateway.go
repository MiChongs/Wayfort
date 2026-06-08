package wireguard

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// gateway.go turns a node into a WireGuard gateway: enabling (and persisting)
// IPv4 forwarding, and configuring NAT/MASQUERADE so peer traffic can egress.
// NAT is preferably expressed as the interface's PostUp/PostDown rules (so it is
// torn down with the interface) — that path lives in iface.go via natRules. The
// direct path here (EnableGateway) is the explicit, confirm-gated alternative
// that writes live iptables rules for an existing setup.

// GatewayStatus is the gateway view for the UI.
type GatewayStatus struct {
	IPForward          bool      `json:"ip_forward"`
	IPForwardPersisted bool      `json:"ip_forward_persisted"`
	NATEnabled         bool      `json:"nat_enabled"`
	EgressIface        string    `json:"egress_iface"`
	EgressCandidates   []string  `json:"egress_candidates"`
	Rules              []string  `json:"rules"`
	SampledAt          time.Time `json:"sampled_at"`
}

const sysctlPersistFile = "/etc/sysctl.d/99-jumpserver-wg.conf"

// natRules returns the PostUp/PostDown lines that set up MASQUERADE NAT for an
// interface, using wg-quick's %i interface placeholder so they bind to whichever
// interface the conf belongs to. egress must be validated before calling.
func natRules(egress string) (postUp, postDown []string) {
	postUp = []string{
		"iptables -A FORWARD -i %i -j ACCEPT",
		"iptables -A FORWARD -o %i -j ACCEPT",
		fmt.Sprintf("iptables -t nat -A POSTROUTING -o %s -j MASQUERADE", egress),
	}
	postDown = []string{
		"iptables -D FORWARD -i %i -j ACCEPT",
		"iptables -D FORWARD -o %i -j ACCEPT",
		fmt.Sprintf("iptables -t nat -D POSTROUTING -o %s -j MASQUERADE", egress),
	}
	return
}

// enableForwardingRaw enables net.ipv4.ip_forward at runtime and, when persist
// is set, writes it to a dedicated sysctl.d drop-in (idempotent — the drop-in is
// rewritten, not appended). Mirrors internal/kernel's sysctl persist pattern.
func (m *Manager) enableForwardingRaw(ctx context.Context, node *model.Node, cred *model.Credential, persist bool) error {
	cmd := "sudo -n sysctl -w net.ipv4.ip_forward=1 2>&1 || sysctl -w net.ipv4.ip_forward=1 2>&1"
	if persist {
		inner := fmt.Sprintf(`sysctl -w net.ipv4.ip_forward=1; printf 'net.ipv4.ip_forward = 1\n' > %s`, sysctlPersistFile)
		cmd = fmt.Sprintf("sudo -n sh -c '%s' 2>&1 || sh -c '%s' 2>&1", inner, inner)
	}
	_, err := m.runWG(ctx, node, cred, cmd, "enable forwarding", m.cfg.SSHTimeout)
	return err
}

// EnableForwarding enables (and optionally persists) IPv4 forwarding. Gated by
// wireguard:manage at the route.
func (m *Manager) EnableForwarding(ctx context.Context, userID, nodeID uint64, claims AuditClaims, persist bool) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if err := m.enableForwardingRaw(ctx, node, cred, persist); err != nil {
		return err
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard enable ip_forward (persist=%v)", persist))
	return nil
}

// EnableGateway configures (or removes) live MASQUERADE NAT for egress, and on
// enable also turns on IPv4 forwarding. This writes live iptables rules + best
// effort persistence, so it is a destructive op that requires confirm=true.
func (m *Manager) EnableGateway(ctx context.Context, userID, nodeID uint64, claims AuditClaims, egress string, enable, confirm bool) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !confirm {
		return ErrConfirmRequired
	}
	if !validEgressIface(egress) {
		return ErrBadEgress
	}
	q := shellQuote(egress)
	var inner string
	if enable {
		inner = fmt.Sprintf(`sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1
printf 'net.ipv4.ip_forward = 1\n' > %s 2>/dev/null || true
iptables -t nat -C POSTROUTING -o %s -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -o %s -j MASQUERADE
( iptables-save > /etc/iptables/rules.v4 2>/dev/null ) || ( netfilter-persistent save 2>/dev/null ) || ( service iptables save 2>/dev/null ) || true`,
			sysctlPersistFile, q, q)
	} else {
		inner = fmt.Sprintf(`iptables -t nat -D POSTROUTING -o %s -j MASQUERADE 2>/dev/null || true
( iptables-save > /etc/iptables/rules.v4 2>/dev/null ) || ( netfilter-persistent save 2>/dev/null ) || ( service iptables save 2>/dev/null ) || true`, q)
	}
	cmd := fmt.Sprintf("sudo -n sh -c '%s' 2>&1 || sh -c '%s' 2>&1", inner, inner)
	if _, err := m.runWG(ctx, node, cred, cmd, "configure NAT", m.cfg.SSHTimeout); err != nil {
		return err
	}
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard %s NAT egress=%s", enableWord(enable), egress))
	return nil
}

const gatewayScript = `echo "FWD=$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)"
echo "PERSIST=$(grep -rsl 'net.ipv4.ip_forward[^=]*=[^0]*1' /etc/sysctl.conf /etc/sysctl.d 2>/dev/null | head -1)"
echo "DEFDEV=$(ip route show default 2>/dev/null | awk '/default/{print $5; exit}')"
echo "DEVS=$(ls /sys/class/net 2>/dev/null | tr '\n' ',')"
echo "===NAT==="
(sudo -n iptables -t nat -S POSTROUTING 2>/dev/null || iptables -t nat -S POSTROUTING 2>/dev/null)`

// GatewayStatus reports forwarding + NAT state for the UI. Read-only.
func (m *Manager) GatewayStatus(ctx context.Context, userID, nodeID uint64) (*GatewayStatus, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	out, err := m.runWG(ctx, node, cred, gatewayScript, "gateway status", m.cfg.SSHTimeout)
	if err != nil {
		return nil, err
	}
	return parseGateway(out), nil
}

func parseGateway(out string) *GatewayStatus {
	gw := &GatewayStatus{SampledAt: time.Now().UTC()}
	inNAT := false
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "===NAT===" {
			inNAT = true
			continue
		}
		if inNAT {
			if strings.Contains(line, "MASQUERADE") {
				gw.Rules = append(gw.Rules, strings.TrimSpace(line))
				gw.NATEnabled = true
			}
			continue
		}
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch k {
		case "FWD":
			gw.IPForward = v == "1"
		case "PERSIST":
			gw.IPForwardPersisted = strings.TrimSpace(v) != ""
		case "DEFDEV":
			gw.EgressIface = strings.TrimSpace(v)
		case "DEVS":
			for _, d := range strings.Split(v, ",") {
				d = strings.TrimSpace(d)
				if d == "" || d == "lo" || strings.HasPrefix(d, "wg") {
					continue
				}
				gw.EgressCandidates = append(gw.EgressCandidates, d)
			}
		}
	}
	return gw
}

func enableWord(b bool) string {
	if b {
		return "enable"
	}
	return "disable"
}
