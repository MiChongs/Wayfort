package firewall

import (
	"context"
	"strconv"
	"strings"
)

// exposure.go cross-references listening sockets (`ss`) with the firewall rules
// to answer the operator's real question: "which of my open ports are actually
// reachable from the internet?" Each listener gets a verdict — open (reachable
// from anywhere = danger), restricted (only specific sources), blocked
// (firewalled off), or local (loopback only).

type listener struct {
	proto   string
	addr    string
	port    int
	process string
	pid     int
}

const ssScript = `sudo -n sh -c 'ss -H -tlnp 2>/dev/null; echo @@UDP@@; ss -H -ulnp 2>/dev/null' 2>/dev/null || ` +
	`sh -c 'ss -H -tlnp 2>/dev/null; echo @@UDP@@; ss -H -ulnp 2>/dev/null' 2>/dev/null`

// ExposureList is the standalone read endpoint (the SSE snapshot also carries
// exposure). Read-only.
func (m *Manager) ExposureList(ctx context.Context, userID, nodeID uint64) ([]ExposurePort, error) {
	l, err := m.gateAndLoad(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	status, rules, err := m.snapshot(ctx, userID, nodeID)
	if err != nil {
		return nil, err
	}
	return m.computeExposure(ctx, l, rules, status), nil
}

// computeExposure lists listeners and assigns a verdict from the rule set. Best
// effort — returns nil on failure (the UI just omits the matrix).
func (m *Manager) computeExposure(ctx context.Context, l *nodeAndCred, rules []Rule, st Status) []ExposurePort {
	out, err := m.runFW(ctx, l, ssScript, "ss listeners", m.cfg.SSHTimeout)
	if err != nil || strings.TrimSpace(out) == "" {
		return nil
	}
	listeners := parseSS(out)
	denyDefault := defaultDenyIn(st)
	res := make([]ExposurePort, 0, len(listeners))
	seen := map[string]bool{}
	for _, ls := range listeners {
		key := ls.proto + ":" + strconv.Itoa(ls.port)
		if seen[key] {
			continue
		}
		seen[key] = true
		ep := ExposurePort{
			Proto:      ls.proto,
			Port:       ls.port,
			ListenAddr: ls.addr,
			Process:    ls.process,
			PID:        ls.pid,
		}
		ep.Verdict, ep.AllowedFrom, ep.RuleIndex = verdictForPort(ls, rules, denyDefault)
		res = append(res, ep)
	}
	return res
}

func parseSS(out string) []listener {
	var res []listener
	proto := "tcp"
	for _, raw := range strings.Split(out, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if line == "@@UDP@@" {
			proto = "udp"
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		// ss -H columns: State Recv-Q Send-Q Local:Port Peer:Port [users:((...))]
		local := fields[3]
		addr, port, ok := splitAddrPort(local)
		if !ok {
			continue
		}
		ls := listener{proto: proto, addr: addr, port: port}
		// process info: users:(("sshd",pid=789,fd=3))
		if i := strings.Index(line, "users:(("); i >= 0 {
			ls.process, ls.pid = parseSSUsers(line[i:])
		}
		res = append(res, ls)
	}
	return res
}

// splitAddrPort splits ss's "addr:port" where addr may be IPv4, [::]/[::1],
// or "*". Returns the address (normalised) and numeric port.
func splitAddrPort(s string) (string, int, bool) {
	i := strings.LastIndex(s, ":")
	if i < 0 {
		return "", 0, false
	}
	addr, portStr := s[:i], s[i+1:]
	port, err := strconv.Atoi(portStr)
	if err != nil {
		return "", 0, false
	}
	addr = strings.Trim(addr, "[]")
	return addr, port, true
}

func parseSSUsers(s string) (string, int) {
	// s starts at users:(("sshd",pid=789,fd=3))
	name := ""
	if a := strings.Index(s, `"`); a >= 0 {
		if b := strings.Index(s[a+1:], `"`); b >= 0 {
			name = s[a+1 : a+1+b]
		}
	}
	pid := 0
	if p := strings.Index(s, "pid="); p >= 0 {
		rest := s[p+4:]
		end := strings.IndexAny(rest, ",)")
		if end < 0 {
			end = len(rest)
		}
		pid, _ = strconv.Atoi(strings.TrimSpace(rest[:end]))
	}
	return name, pid
}

func isLoopback(addr string) bool {
	return addr == "127.0.0.1" || strings.HasPrefix(addr, "127.") || addr == "::1"
}

// verdictForPort decides the exposure of a listener given the rules + default
// policy. allowedFrom is populated for the "restricted" case.
func verdictForPort(ls listener, rules []Rule, denyDefault bool) (ExposureVerdict, []string, int) {
	if isLoopback(ls.addr) {
		return ExposureLocal, nil, 0
	}
	var anyAllow bool
	var restricted []string
	ruleIdx := 0
	for _, r := range rules {
		if r.Direction == "out" {
			continue
		}
		if !portMatches(r.Port, ls.port) {
			continue
		}
		if strings.EqualFold(r.Action, "ALLOW") {
			if isAnywhereSource(r.Source) {
				anyAllow = true
				if ruleIdx == 0 {
					ruleIdx = r.Index
				}
			} else {
				restricted = append(restricted, r.Source)
				if ruleIdx == 0 {
					ruleIdx = r.Index
				}
			}
		}
	}
	switch {
	case anyAllow:
		return ExposureOpen, nil, ruleIdx
	case len(restricted) > 0:
		return ExposureRestricted, restricted, ruleIdx
	case denyDefault:
		return ExposureBlocked, nil, 0
	default:
		// Listening on a public addr with a default-allow policy and no specific
		// rule → reachable from anywhere.
		return ExposureOpen, nil, 0
	}
}

func isAnywhereSource(src string) bool {
	s := strings.TrimSpace(strings.ToLower(src))
	return s == "" || s == "any" || s == "anywhere" || s == "0.0.0.0/0" || s == "::/0"
}

// portMatches reports whether a rule's port spec ("22" / "80,443" / "8000:9000")
// covers the given port.
func portMatches(spec string, port int) bool {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return true // rule with no port = matches all
	}
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if i := strings.IndexAny(part, ":-"); i >= 0 {
			lo, _ := strconv.Atoi(part[:i])
			hi, _ := strconv.Atoi(part[i+1:])
			if lo <= port && port <= hi {
				return true
			}
			continue
		}
		if n, err := strconv.Atoi(part); err == nil && n == port {
			return true
		}
	}
	return false
}

func defaultDenyIn(s Status) bool {
	p := strings.ToLower(s.Policy + " " + s.DefaultIn)
	return strings.Contains(p, "deny") || strings.Contains(p, "drop") || strings.Contains(p, "reject")
}
