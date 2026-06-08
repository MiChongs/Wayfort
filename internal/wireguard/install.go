package wireguard

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
)

// install.go handles getting WireGuard onto a node: a single-round-trip probe of
// the distro / package manager / kernel module, and a streamed install that
// emits output line-by-line so the UI shows live progress (never blocks).

// DistroProbe is what the install pre-check returns to the UI.
type DistroProbe struct {
	OSID       string    `json:"os_id"`
	PkgManager string    `json:"pkg_manager"`
	Installed  bool      `json:"installed"`     // wg present
	WGQuick    bool      `json:"wg_quick"`      // wg-quick present
	KernelMod  string    `json:"kernel_module"` // loaded|available|userspace|none
	CanSudo    bool      `json:"can_sudo"`      // `sudo -n true` succeeds
	Kernel     string    `json:"kernel"`
	CmdPreview string    `json:"cmd_preview"` // the install command we'd run
	SampledAt  time.Time `json:"sampled_at"`
}

const probeScript = `echo "OS=$( . /etc/os-release 2>/dev/null; echo "$ID" )"
echo "WG=$(command -v wg >/dev/null 2>&1 && echo 1 || echo 0)"
echo "WGQ=$(command -v wg-quick >/dev/null 2>&1 && echo 1 || echo 0)"
for p in apt-get dnf yum apk pacman zypper; do command -v "$p" >/dev/null 2>&1 && { echo "PM=$p"; break; }; done
echo "SUDO=$(sudo -n true 2>/dev/null && echo 1 || echo 0)"
echo "MOD=$( (lsmod 2>/dev/null | grep -q '^wireguard' && echo loaded) || (modinfo wireguard >/dev/null 2>&1 && echo available) || (command -v wireguard-go >/dev/null 2>&1 && echo userspace) || echo none )"
echo "KVER=$(uname -r)"`

// Probe inspects the node so the UI can show what an install would do. Read-only
// (ActionConnect).
func (m *Manager) Probe(ctx context.Context, userID, nodeID uint64) (*DistroProbe, error) {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	out, err := m.runWG(ctx, node, cred, probeScript, "probe", m.cfg.SSHTimeout)
	if err != nil {
		return nil, err
	}
	p := parseProbe(out)
	p.SampledAt = time.Now().UTC()
	p.CmdPreview = installPreview(p.PkgManager)
	return p, nil
}

func parseProbe(out string) *DistroProbe {
	p := &DistroProbe{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch k {
		case "OS":
			p.OSID = v
		case "WG":
			p.Installed = v == "1"
		case "WGQ":
			p.WGQuick = v == "1"
		case "PM":
			p.PkgManager = v
		case "SUDO":
			p.CanSudo = v == "1"
		case "MOD":
			p.KernelMod = v
		case "KVER":
			p.Kernel = v
		}
	}
	return p
}

// installPreview returns a human-readable preview of the install command for the
// detected package manager (the actual install runs the streaming script).
func installPreview(pm string) string {
	switch pm {
	case "apt-get":
		return "apt-get update && apt-get install -y wireguard wireguard-tools"
	case "dnf":
		return "dnf install -y wireguard-tools"
	case "yum":
		return "yum install -y epel-release; yum install -y wireguard-tools"
	case "apk":
		return "apk add --no-cache wireguard-tools"
	case "pacman":
		return "pacman -Sy --noconfirm wireguard-tools"
	case "zypper":
		return "zypper --non-interactive install wireguard-tools"
	default:
		return ""
	}
}

// installScript detects the package manager on the host and installs
// wireguard-tools, preferring sudo -n with an unprivileged fallback. It never
// uses `set -e` so the terminal `===DONE rc=N===` marker is always emitted (the
// streamer parses it for the audit record + the UI shows success/failure).
const installScript = `if command -v wg >/dev/null 2>&1 && command -v wg-quick >/dev/null 2>&1; then echo "WireGuard already installed."; echo "===DONE rc=0==="; exit 0; fi
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  (sudo -n apt-get update && sudo -n apt-get install -y wireguard wireguard-tools) || (apt-get update && apt-get install -y wireguard wireguard-tools)
elif command -v dnf >/dev/null 2>&1; then
  sudo -n dnf install -y wireguard-tools || dnf install -y wireguard-tools
elif command -v yum >/dev/null 2>&1; then
  (sudo -n yum install -y epel-release || yum install -y epel-release || true); sudo -n yum install -y wireguard-tools || yum install -y wireguard-tools
elif command -v apk >/dev/null 2>&1; then
  sudo -n apk add --no-cache wireguard-tools || apk add --no-cache wireguard-tools
elif command -v pacman >/dev/null 2>&1; then
  sudo -n pacman -Sy --noconfirm wireguard-tools || pacman -Sy --noconfirm wireguard-tools
elif command -v zypper >/dev/null 2>&1; then
  sudo -n zypper --non-interactive install wireguard-tools || zypper --non-interactive install wireguard-tools
else
  echo "未找到受支持的包管理器 (apt/dnf/yum/apk/pacman/zypper)。"; echo "===DONE rc=2==="; exit 2
fi
rc=$?
(sudo -n modprobe wireguard 2>/dev/null || modprobe wireguard 2>/dev/null || true)
echo "===DONE rc=$rc==="
exit $rc`

// Install streams wireguard-tools installation, emitting each output line. The
// emit callback feeds the SSE Lines handler. On completion the status cache is
// invalidated so the next read reflects the new install, and the action is
// audited with the captured return code.
func (m *Manager) Install(ctx context.Context, userID, nodeID uint64, claims AuditClaims, emit func(string)) error {
	node, cred, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	// Wrap in sh -c so the multi-line script runs under one shell with stderr
	// merged into the streamed stdout. The script contains no single quotes.
	cmd := "sh -c '" + installScript + "' 2>&1"
	rc := -1
	wrap := func(line string) {
		if strings.HasPrefix(line, "===DONE rc=") {
			_, _ = fmt.Sscanf(line, "===DONE rc=%d===", &rc)
		}
		emit(line)
	}
	err = sshrun.RunStream(ctx, m.deps, node, cred, cmd, m.cfg.InstallTimeout, wrap)
	m.invalidate(nodeID)
	m.recordAudit(claims, nodeID, fmt.Sprintf("wireguard install (rc=%d)", rc))
	return err
}
