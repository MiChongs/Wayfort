package firewall

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/sshrun"
)

// install.go gets a firewall (or fail2ban) onto a node: a single-round-trip
// probe of the distro / package manager / installed tools, and streamed installs
// that emit output line-by-line so the UI shows live progress. Mirrors the
// WireGuard install flow.

const fwProbeScript = `echo "OS=$( . /etc/os-release 2>/dev/null; echo "$ID" )"
for p in apt-get dnf yum apk pacman zypper; do command -v "$p" >/dev/null 2>&1 && { echo "PM=$p"; break; }; done
echo "UFW=$(command -v ufw >/dev/null 2>&1 && echo 1 || echo 0)"
echo "NFT=$(command -v nft >/dev/null 2>&1 && echo 1 || echo 0)"
echo "IPT=$(command -v iptables >/dev/null 2>&1 && echo 1 || echo 0)"
echo "FWD=$(command -v firewall-cmd >/dev/null 2>&1 && echo 1 || echo 0)"
echo "F2B=$(command -v fail2ban-client >/dev/null 2>&1 && echo 1 || echo 0)"
echo "CT=$(command -v conntrack >/dev/null 2>&1 && echo 1 || echo 0)"
echo "SUDO=$(sudo -n true 2>/dev/null && echo 1 || echo 0)"`

// ProbeInstall inspects the node so the UI can offer the right install. Read-only.
func (m *Manager) ProbeInstall(ctx context.Context, userID, nodeID uint64) (*FWProbe, error) {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	out, err := m.runFW(ctx, l, fwProbeScript, "install probe", m.cfg.SSHTimeout)
	if err != nil {
		return nil, err
	}
	p := parseFWProbe(out)
	p.SampledAt = time.Now().UTC()
	p.CmdPreviewUFW = installPreview(p.PkgManager, "ufw")
	p.CmdPreviewNft = installPreview(p.PkgManager, "nftables")
	switch {
	case p.HasUFW:
		p.RecommendedTool = ToolUFW
	case p.HasNft:
		p.RecommendedTool = ToolNftables
	case p.HasFirewalld:
		p.RecommendedTool = ToolFirewalld
	default:
		p.RecommendedTool = ToolUFW // recommend installing ufw (most humane)
	}
	return p, nil
}

func parseFWProbe(out string) *FWProbe {
	p := &FWProbe{}
	for _, line := range strings.Split(out, "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if !ok {
			continue
		}
		switch k {
		case "OS":
			p.OSID = v
		case "PM":
			p.PkgManager = v
		case "UFW":
			p.HasUFW = v == "1"
		case "NFT":
			p.HasNft = v == "1"
		case "IPT":
			p.HasIptables = v == "1"
		case "FWD":
			p.HasFirewalld = v == "1"
		case "F2B":
			p.HasFail2ban = v == "1"
		case "CT":
			p.HasConntrack = v == "1"
		case "SUDO":
			p.CanSudo = v == "1"
		}
	}
	return p
}

func installPreview(pm, pkg string) string {
	switch pm {
	case "apt-get":
		return "apt-get update && apt-get install -y " + pkg
	case "dnf":
		return "dnf install -y " + pkg
	case "yum":
		return "yum install -y " + pkg
	case "apk":
		return "apk add --no-cache " + pkg
	case "pacman":
		return "pacman -Sy --noconfirm " + pkg
	case "zypper":
		return "zypper --non-interactive install " + pkg
	default:
		return ""
	}
}

// installScript builds a multi-distro install for one package, preferring sudo
// -n with an unprivileged fallback. No `set -e` so the terminal marker is always
// emitted. checkBin short-circuits when already installed.
func installScript(pkg, checkBin string) string {
	return `if command -v ` + checkBin + ` >/dev/null 2>&1; then echo "` + pkg + ` 已安装"; echo "===DONE rc=0==="; exit 0; fi
if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; (sudo -n apt-get update && sudo -n apt-get install -y ` + pkg + `) || (apt-get update && apt-get install -y ` + pkg + `)
elif command -v dnf >/dev/null 2>&1; then sudo -n dnf install -y ` + pkg + ` || dnf install -y ` + pkg + `
elif command -v yum >/dev/null 2>&1; then (sudo -n yum install -y epel-release || yum install -y epel-release || true); sudo -n yum install -y ` + pkg + ` || yum install -y ` + pkg + `
elif command -v apk >/dev/null 2>&1; then sudo -n apk add --no-cache ` + pkg + ` || apk add --no-cache ` + pkg + `
elif command -v pacman >/dev/null 2>&1; then sudo -n pacman -Sy --noconfirm ` + pkg + ` || pacman -Sy --noconfirm ` + pkg + `
elif command -v zypper >/dev/null 2>&1; then sudo -n zypper --non-interactive install ` + pkg + ` || zypper --non-interactive install ` + pkg + `
else echo "未找到受支持的包管理器 (apt/dnf/yum/apk/pacman/zypper)。"; echo "===DONE rc=2==="; exit 2; fi
rc=$?; echo "===DONE rc=$rc==="; exit $rc`
}

// InstallUFW / InstallNft / InstallFail2ban stream the relevant install.
func (m *Manager) InstallUFW(ctx context.Context, userID, nodeID uint64, claims AuditClaims, emit func(string)) error {
	return m.install(ctx, userID, nodeID, claims, "ufw", "ufw", emit)
}
func (m *Manager) InstallNft(ctx context.Context, userID, nodeID uint64, claims AuditClaims, emit func(string)) error {
	return m.install(ctx, userID, nodeID, claims, "nftables", "nft", emit)
}
func (m *Manager) InstallFail2ban(ctx context.Context, userID, nodeID uint64, claims AuditClaims, emit func(string)) error {
	return m.install(ctx, userID, nodeID, claims, "fail2ban", "fail2ban-client", emit)
}

func (m *Manager) install(ctx context.Context, userID, nodeID uint64, claims AuditClaims, pkg, checkBin string, emit func(string)) error {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	cmd := "sh -c '" + installScript(pkg, checkBin) + "' 2>&1"
	rc := -1
	wrap := func(line string) {
		if strings.HasPrefix(line, "===DONE rc=") {
			_, _ = fmt.Sscanf(line, "===DONE rc=%d===", &rc)
		}
		emit(line)
	}
	err = sshrun.RunStream(ctx, m.deps, l.node, l.cred, cmd, m.cfg.InstallTimeout, wrap)
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, model.AuditFirewallChange, fmt.Sprintf("install %s (rc=%d)", pkg, rc))
	return err
}
