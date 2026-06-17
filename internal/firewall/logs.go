package firewall

import (
	"context"

	"github.com/michongs/wayfort/internal/sshrun"
)

// logs.go follows the firewall's kernel log lines (blocked/allowed packets) and
// streams them to the caller. It prefers journalctl's kernel follow, falling
// back to tailing the common log files. The grep keeps the firehose to
// firewall-relevant lines (UFW prefixes, nft/iptables packet logs, firewalld).

const firewallLogCmd = `sudo -n sh -c '` + fwLogInner + `' 2>&1 || sh -c '` + fwLogInner + `' 2>&1`

const fwLogInner = `if command -v journalctl >/dev/null 2>&1; then ` +
	`journalctl -kf -n 200 --no-pager 2>/dev/null | grep --line-buffered -iE "UFW |nftables|IN=.*OUT=|DPT=|firewalld" ; ` +
	`else tail -Fn 200 /var/log/ufw.log /var/log/kern.log /var/log/messages 2>/dev/null; fi`

// LogsStream follows firewall log lines until ctx is cancelled (the SSE handler
// cancels on client disconnect). Read-only (ActionConnect).
func (m *Manager) LogsStream(ctx context.Context, userID, nodeID uint64, emit func(string)) error {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	// dialTimeout only bounds the SSH dial; the follow command itself runs until
	// ctx is cancelled.
	return sshrun.RunStream(ctx, m.deps, l.node, l.cred, firewallLogCmd, m.cfg.SSHTimeout, emit)
}
