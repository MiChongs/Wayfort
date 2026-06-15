package api

import (
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// AgentDownloadHandler serves the prebuilt reverse-connect gateway-agent binary
// and a copy-paste install script, so an operator inside an isolated network can
// fetch the agent over the single outbound HTTPS hop they're allowed (the same
// hop the tunnel later uses). It is intentionally UNAUTHENTICATED: the binary is
// not a secret — enrollment is gated by the one-time token and the
// pending→activate human check (security-architecture.md §4/§14). Binaries are
// produced by scripts/build-agent.sh and staged in DistDir (cfg.agent.dist_dir).
type AgentDownloadHandler struct {
	// DistDir holds files named gateway-agent-<os>-<arch> (e.g.
	// gateway-agent-linux-amd64). Empty disables the endpoints.
	DistDir string
	// PublicHost / AgentAddr describe the agent面 the install script points
	// --server at. PublicHost empty → derive the host from the request.
	PublicHost string
	AgentAddr  string
	Logger     *zap.Logger
}

// allowedAgentTargets whitelists the os/arch combinations we serve, so the
// os/arch query can never traverse out of DistDir.
var allowedAgentTargets = map[string]bool{
	"linux/amd64":   true,
	"linux/arm64":   true,
	"windows/amd64": true,
	"darwin/amd64":  true,
	"darwin/arm64":  true,
}

// agentBinaryName resolves a validated os/arch to its staged file name, or ""
// if the combination isn't on the whitelist.
func agentBinaryName(osName, arch string) string {
	if !allowedAgentTargets[osName+"/"+arch] {
		return ""
	}
	name := "gateway-agent-" + osName + "-" + arch
	if osName == "windows" {
		name += ".exe"
	}
	return name
}

// Binary streams the gateway-agent binary for the requested os/arch (defaults
// linux/amd64). Returns 503 — with a message telling the operator how to build
// it — when the feature is unconfigured or the binary hasn't been staged.
func (h *AgentDownloadHandler) Binary(c *gin.Context) {
	if h.DistDir == "" {
		c.String(http.StatusServiceUnavailable, "agent download not configured (set agent.dist_dir)")
		return
	}
	osName := strings.ToLower(c.DefaultQuery("os", "linux"))
	arch := strings.ToLower(c.DefaultQuery("arch", "amd64"))
	name := agentBinaryName(osName, arch)
	if name == "" {
		c.String(http.StatusBadRequest, "unsupported os/arch: %s/%s", osName, arch)
		return
	}
	path := filepath.Join(h.DistDir, name)
	if _, err := os.Stat(path); err != nil {
		c.String(http.StatusServiceUnavailable,
			"gateway-agent %s/%s is not staged on this server.\n"+
				"Build it with:  scripts/build-agent.sh   (outputs to %s)\n",
			osName, arch, h.DistDir)
		return
	}
	c.FileAttachment(path, "gateway-agent")
}

// Script returns a POSIX shell installer the operator pipes into sh. The gateway
// bakes the absolute download URL and the --server URL into the script so the
// only argument the operator supplies is the enrollment token:
//
//	curl -fsSL https://<gateway>/dl/gateway-agent.sh | sh -s -- --token <OTT>
//
// The script detects the host architecture, downloads the matching binary,
// installs it next to itself, and runs `gateway-agent enroll`. Extra args (e.g.
// --name edge-1) pass straight through.
func (h *AgentDownloadHandler) Script(c *gin.Context) {
	if h.DistDir == "" {
		c.String(http.StatusServiceUnavailable, "# agent download not configured (set agent.dist_dir)\n")
		return
	}
	dlBase := agentRequestOrigin(c)
	server := agentServerURL(h.PublicHost, h.AgentAddr, c.Request.Host)
	c.Header("Content-Type", "text/x-shellscript; charset=utf-8")
	c.String(http.StatusOK, installScript(dlBase, server))
}

// agentRequestOrigin reconstructs the scheme://host the request arrived on,
// honouring a fronting reverse proxy's X-Forwarded-Proto.
func agentRequestOrigin(c *gin.Context) string {
	scheme := "http"
	if proto := c.GetHeader("X-Forwarded-Proto"); proto != "" {
		scheme = proto
	} else if c.Request.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + c.Request.Host
}

// agentServerURL builds the wss://host:port the agent dials for enroll/tunnel.
// publicHost wins when set; otherwise the host is taken from the request and the
// port from the agent listener address (default 8443).
func agentServerURL(publicHost, agentAddr, reqHost string) string {
	host := publicHost
	if host == "" {
		host = hostOnly(reqHost)
	}
	port := portOf(agentAddr)
	if port == "" {
		port = "8443"
	}
	return "wss://" + host + ":" + port
}

// hostOnly strips an optional :port from a host[:port] string.
func hostOnly(hostport string) string {
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		return h
	}
	return hostport
}

// portOf extracts the port from an address like ":8443" or "0.0.0.0:8443".
func portOf(addr string) string {
	if addr == "" {
		return ""
	}
	if _, p, err := net.SplitHostPort(addr); err == nil {
		return p
	}
	if p, ok := strings.CutPrefix(addr, ":"); ok {
		return p
	}
	return ""
}

// installScript renders the POSIX installer with the gateway's download base and
// agent server URL baked in. Uses a replacer (not a format string) so the shell
// body can contain % freely.
func installScript(dlBase, server string) string {
	const tmpl = `#!/bin/sh
# JumpServer reverse-connect gateway-agent installer.
# A domain can hold MANY agents (they load-balance + fail over = HA). Run this on
# each host you want to enroll. Second agent on the SAME host: add --state DIR.
#   curl -fsSL DL_BASE/dl/gateway-agent.sh | sh -s -- --token <ENROLL_TOKEN> [--name NAME]
set -eu

DL_BASE="__DL_BASE__"
SERVER="__SERVER__"

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "gateway-agent: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

# Shared binary location so several agents on one host reuse one copy.
if [ -w /usr/local/bin ]; then BIN=/usr/local/bin/gateway-agent; else BIN=./gateway-agent; fi
echo "gateway-agent: downloading linux/$ARCH from $DL_BASE ..." >&2
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$DL_BASE/dl/gateway-agent?os=linux&arch=$ARCH" -o "$BIN"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$BIN" "$DL_BASE/dl/gateway-agent?os=linux&arch=$ARCH"
else
  echo "gateway-agent: need curl or wget to download" >&2; exit 1
fi
chmod +x "$BIN"

echo "gateway-agent: enrolling against $SERVER ..." >&2
"$BIN" enroll --server "$SERVER" "$@"

cat >&2 <<EOF

gateway-agent installed at $BIN and enrolled (PENDING until an admin activates it).
Run it:           $BIN run --server $SERVER
More agents:      re-run on another host; or on THIS host add a distinct --state DIR.
                  Several agents in one domain load-balance and fail over (HA).
Keep it running:  install a systemd service (Restart=always) per agent.
EOF
`
	return strings.NewReplacer("__DL_BASE__", dlBase, "__SERVER__", server).Replace(tmpl)
}
