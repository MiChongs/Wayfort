package firewall

import (
	"context"
	"strconv"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/model"
)

// fail2ban.go manages the fail2ban intrusion-prevention layer alongside the
// firewall: jail status, banned IPs, and ban/unban. All fail2ban-client calls
// run inside one `sudo -n sh -c` (it needs root) with an unprivileged fallback.

const f2bStatusScript = `sudo -n sh -c '` + f2bInner + `' 2>&1 || sh -c '` + f2bInner + `' 2>&1`

const f2bInner = `if ! command -v fail2ban-client >/dev/null 2>&1; then echo __NO_F2B__; exit 0; fi
echo "ACTIVE=$(systemctl is-active fail2ban 2>/dev/null || echo unknown)"
S=$(fail2ban-client status 2>/dev/null)
echo "$S"
echo "===JAILS==="
for j in $(echo "$S" | sed -n "s/.*Jail list:[[:space:]]*//p" | tr "," " "); do echo "@@JAIL@@ $j"; fail2ban-client status "$j" 2>/dev/null; done`

// F2BStatus returns the full fail2ban view: jails + banned IPs. Read-only.
func (m *Manager) F2BStatus(ctx context.Context, userID, nodeID uint64) (*F2BStatus, error) {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	return m.f2bSnapshot(ctx, l), nil
}

func (m *Manager) f2bSnapshot(ctx context.Context, l *nodeAndCred) *F2BStatus {
	out, err := m.runFW(ctx, l, f2bStatusScript, "fail2ban status", m.cfg.SSHTimeout)
	st := &F2BStatus{SampledAt: time.Now().UTC()}
	if err != nil || strings.TrimSpace(out) == "__NO_F2B__" {
		st.Reason = "目标主机未安装 fail2ban。"
		return st
	}
	parseF2B(out, st)
	st.Installed = true
	return st
}

// f2bSummary is the lightweight summary embedded in the main status SSE: just
// whether it's installed + the jail count (banned counts are in the dedicated
// view). Returns nil when fail2ban isn't present.
func (m *Manager) f2bSummary(ctx context.Context, l *nodeAndCred) *F2BSummary {
	st := m.f2bSnapshot(ctx, l)
	if !st.Installed {
		return nil
	}
	total := 0
	for _, j := range st.Jails {
		total += j.Banned
	}
	return &F2BSummary{Installed: true, BannedTotal: total, JailCount: len(st.Jails)}
}

func parseF2B(out string, st *F2BStatus) {
	var cur *F2BJail
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "ACTIVE=") {
			st.Running = strings.TrimSpace(strings.TrimPrefix(line, "ACTIVE=")) == "active"
			continue
		}
		if strings.HasPrefix(line, "@@JAIL@@ ") {
			name := strings.TrimSpace(strings.TrimPrefix(line, "@@JAIL@@ "))
			st.Jails = append(st.Jails, F2BJail{Name: name})
			cur = &st.Jails[len(st.Jails)-1]
			continue
		}
		if cur == nil {
			continue
		}
		switch {
		case strings.Contains(line, "Currently banned:"):
			cur.Banned = lastInt(line)
		case strings.Contains(line, "Total banned:"):
			cur.Total = lastInt(line)
		case strings.Contains(line, "Banned IP list:"):
			ips := strings.TrimSpace(line[strings.Index(line, "Banned IP list:")+len("Banned IP list:"):])
			cur.BannedIPs = strings.Fields(ips)
		}
	}
}

func lastInt(line string) int {
	f := strings.Fields(line)
	for i := len(f) - 1; i >= 0; i-- {
		if n, err := strconv.Atoi(f[i]); err == nil {
			return n
		}
	}
	return 0
}

// F2BBan / F2BUnban add or remove a ban. Gated by firewall:manage.
func (m *Manager) F2BBan(ctx context.Context, userID, nodeID uint64, claims AuditClaims, jail, ip string) error {
	return m.f2bAction(ctx, userID, nodeID, claims, jail, ip, "banip")
}
func (m *Manager) F2BUnban(ctx context.Context, userID, nodeID uint64, claims AuditClaims, jail, ip string) error {
	return m.f2bAction(ctx, userID, nodeID, claims, jail, ip, "unbanip")
}

func (m *Manager) f2bAction(ctx context.Context, userID, nodeID uint64, claims AuditClaims, jail, ip, verb string) error {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return err
	}
	if !validIdent(jail) || !validSource(ip) || ip == "" {
		return ErrBadArg
	}
	qj, qi := shellQuote(jail), shellQuote(ip)
	cmd := "sudo -n fail2ban-client set " + qj + " " + verb + " " + qi + " 2>&1 || fail2ban-client set " + qj + " " + verb + " " + qi + " 2>&1"
	if _, err := m.runFW(ctx, l, cmd, "fail2ban "+verb, m.cfg.SSHTimeout); err != nil {
		return err
	}
	m.recordAudit(claims, nodeID, model.AuditFirewallChange, "f2b "+verb+" jail="+jail+" ip="+ip)
	return nil
}
