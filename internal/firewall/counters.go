package firewall

import (
	"context"
	"strconv"
	"strings"
)

// counters.go adds live per-rule hit counters. iptables and nft carry pkts/bytes
// inline (parsed in parser.go). ufw's user-facing `ufw status` has no counters,
// so we read the underlying iptables counters and map them onto ufw rules by
// destination port (best-effort, single-port rules). collectFresh is the SSE
// path: it always re-collects (never the 5s REST cache) so counters move.

// parseCount parses an iptables -v counter that may carry a K/M/G/T suffix
// (1000-based) — or is exact when produced with -x.
func parseCount(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	mult := int64(1)
	switch s[len(s)-1] {
	case 'K', 'k':
		mult = 1000
	case 'M', 'm':
		mult = 1000 * 1000
	case 'G', 'g':
		mult = 1000 * 1000 * 1000
	case 'T', 't':
		mult = 1000 * 1000 * 1000 * 1000
	}
	if mult > 1 {
		s = s[:len(s)-1]
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return int64(f * float64(mult))
	}
	n, _ := strconv.ParseInt(s, 10, 64)
	return n
}

// LiveSnapshot is the public SSE produce: a fresh status+rules+exposure+fail2ban
// snapshot bypassing the read cache so live counters move each tick.
func (m *Manager) LiveSnapshot(ctx context.Context, userID, nodeID uint64) (*Snapshot, error) {
	return m.collectFresh(ctx, userID, nodeID)
}

// collectFresh re-collects status + rules (with counters) + exposure for the SSE
// stream, bypassing the read cache so live numbers update each tick. It still
// warms the cache for REST callers.
func (m *Manager) collectFresh(ctx context.Context, userID, nodeID uint64) (*Snapshot, error) {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	entry, err := m.collect(ctx, nodeID, l)
	if err != nil {
		return nil, err
	}
	snap := &Snapshot{Status: entry.status, Rules: entry.rules}
	if snap.Tool == ToolUFW {
		m.mergeUFWCounters(ctx, l, snap.Rules)
	}
	snap.Exposure = m.computeExposure(ctx, l, snap.Rules, snap.Status)
	snap.Fail2ban = m.f2bSummary(ctx, l)
	return snap, nil
}

// mergeUFWCounters reads the underlying iptables counters and assigns them to
// ufw rules whose port is a single number. Best-effort — failure leaves
// counters at 0 (UI shows "—").
func (m *Manager) mergeUFWCounters(ctx context.Context, l *nodeAndCred, rules []Rule) {
	out, err := m.runFW(ctx, l,
		"sudo -n iptables -L -n -v -x 2>/dev/null || iptables -L -n -v -x 2>/dev/null",
		"ufw counters", m.cfg.SSHTimeout)
	if err != nil || strings.TrimSpace(out) == "" {
		return
	}
	byPort := parseDportCounters(out)
	for i := range rules {
		if c, ok := byPort[rules[i].Port]; ok {
			rules[i].Pkts = c[0]
			rules[i].Bytes = c[1]
		}
	}
}

// parseDportCounters scans `iptables -L -n -v -x` output (no --line-numbers, so
// columns are: pkts bytes target prot opt in out source dest [match…]) and sums
// pkts/bytes per destination port found via a `dpt:<port>` token.
func parseDportCounters(out string) map[string][2]int64 {
	res := map[string][2]int64{}
	for _, raw := range strings.Split(out, "\n") {
		fields := strings.Fields(raw)
		if len(fields) < 9 {
			continue
		}
		pkts, err1 := strconv.ParseInt(fields[0], 10, 64)
		bytes, err2 := strconv.ParseInt(fields[1], 10, 64)
		if err1 != nil || err2 != nil {
			continue
		}
		for _, tok := range fields[8:] {
			if strings.HasPrefix(tok, "dpt:") {
				port := strings.TrimPrefix(tok, "dpt:")
				cur := res[port]
				res[port] = [2]int64{cur[0] + pkts, cur[1] + bytes}
				break
			}
		}
	}
	return res
}
