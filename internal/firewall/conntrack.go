package firewall

import (
	"context"
	"strconv"
	"strings"
	"time"
)

// conntrack.go surfaces the kernel's live connection-tracking table so the
// operator sees real traffic, not just rules. Prefers the `conntrack` tool,
// falling back to /proc/net/nf_conntrack (or the legacy ip_conntrack).

const conntrackScript = `sudo -n sh -c 'if command -v conntrack >/dev/null 2>&1; then conntrack -L 2>/dev/null; else cat /proc/net/nf_conntrack 2>/dev/null || cat /proc/net/ip_conntrack 2>/dev/null; fi' 2>&1 || ` +
	`sh -c 'if command -v conntrack >/dev/null 2>&1; then conntrack -L 2>/dev/null; else cat /proc/net/nf_conntrack 2>/dev/null || cat /proc/net/ip_conntrack 2>/dev/null; fi' 2>&1`

// Conntrack returns a one-shot snapshot of active connections (read-only).
func (m *Manager) Conntrack(ctx context.Context, userID, nodeID uint64) (*ConntrackSnapshot, error) {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	return m.conntrack(ctx, l)
}

func (m *Manager) conntrack(ctx context.Context, l *nodeAndCred) (*ConntrackSnapshot, error) {
	out, err := m.runFW(ctx, l, conntrackScript, "conntrack", m.cfg.SSHTimeout)
	if err != nil {
		return nil, err
	}
	return parseConntrack(out, m.cfg.ConntrackMax), nil
}

func parseConntrack(out string, max int) *ConntrackSnapshot {
	snap := &ConntrackSnapshot{SampledAt: time.Now().UTC()}
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		c, ok := parseConntrackLine(line)
		if !ok {
			continue
		}
		snap.Total++
		if len(snap.Connections) < max {
			snap.Connections = append(snap.Connections, c)
		} else {
			snap.Truncated = true
		}
	}
	return snap
}

var ctProtos = map[string]bool{"tcp": true, "udp": true, "icmp": true, "icmpv6": true, "sctp": true, "dccp": true}

// parseConntrackLine handles both `conntrack -L` and /proc/net/nf_conntrack
// formats by scanning tokens: the L4 proto is the first known protocol word, the
// state is the first ALL-CAPS token, and src/dst/sport/dport/bytes come from the
// first occurrence of each key=value.
func parseConntrackLine(line string) (Conn, bool) {
	fields := strings.Fields(line)
	var c Conn
	for _, f := range fields {
		if c.Proto == "" && ctProtos[strings.ToLower(f)] {
			c.Proto = strings.ToLower(f)
			continue
		}
		if c.State == "" && isCTState(f) {
			c.State = f
			continue
		}
		k, v, ok := strings.Cut(f, "=")
		if !ok {
			continue
		}
		switch k {
		case "src":
			if c.Src == "" {
				c.Src = v
			}
		case "dst":
			if c.Dst == "" {
				c.Dst = v
			}
		case "sport":
			if c.SPort == 0 {
				c.SPort, _ = strconv.Atoi(v)
			}
		case "dport":
			if c.DPort == 0 {
				c.DPort, _ = strconv.Atoi(v)
			}
		case "bytes":
			if c.Bytes == 0 {
				c.Bytes, _ = strconv.ParseInt(v, 10, 64)
			}
		case "packets":
			if c.Pkts == 0 {
				c.Pkts, _ = strconv.ParseInt(v, 10, 64)
			}
		}
	}
	if c.Proto == "" || c.Src == "" {
		return Conn{}, false
	}
	return c, true
}

// isCTState reports whether a token looks like a conntrack TCP state (all upper,
// has an underscore or is a known single word).
func isCTState(s string) bool {
	switch s {
	case "ESTABLISHED", "TIME_WAIT", "CLOSE_WAIT", "CLOSE", "SYN_SENT", "SYN_RECV",
		"FIN_WAIT", "LAST_ACK", "LISTEN", "NONE", "UNREPLIED", "ASSURED":
		return true
	}
	return false
}
