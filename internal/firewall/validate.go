package firewall

import (
	"net/netip"
	"strconv"
	"strings"
)

// validate.go is the command-injection firewall: every user-controllable value
// that reaches a shell command is checked against a strict whitelist here before
// it is shell-quoted. Multi-line / import content never goes through
// interpolation at all — it travels as a base64 literal over stdin.

func validProto(p string) bool {
	switch strings.ToLower(strings.TrimSpace(p)) {
	case "tcp", "udp", "icmp", "any", "":
		return true
	}
	return false
}

// validPortSpec accepts "" (any), a single port, a comma list ("80,443"), or a
// range ("8000:9000" / "8000-9000"). Every numeric segment must be 1..65535.
func validPortSpec(p string) bool {
	p = strings.TrimSpace(p)
	if p == "" {
		return true
	}
	for _, part := range strings.Split(p, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return false
		}
		// range a:b or a-b
		var lo, hi string
		if i := strings.IndexAny(part, ":-"); i >= 0 {
			lo, hi = part[:i], part[i+1:]
		} else {
			lo, hi = part, part
		}
		if !validPortNum(lo) || !validPortNum(hi) {
			return false
		}
	}
	return true
}

func validPortNum(s string) bool {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	return err == nil && n >= 1 && n <= 65535
}

func validAction(a string) bool {
	switch strings.ToUpper(strings.TrimSpace(a)) {
	case "ALLOW", "DENY", "REJECT":
		return true
	}
	return false
}

func validDirection(d string) bool {
	switch strings.ToLower(strings.TrimSpace(d)) {
	case "in", "out", "":
		return true
	}
	return false
}

// validSource accepts "" / "any" / a bare IP / a CIDR prefix.
func validSource(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || strings.EqualFold(s, "any") || strings.EqualFold(s, "anywhere") {
		return true
	}
	if _, err := netip.ParseAddr(s); err == nil {
		return true
	}
	if _, err := netip.ParsePrefix(s); err == nil {
		return true
	}
	return false
}

func validChain(c string) bool {
	switch strings.ToUpper(strings.TrimSpace(c)) {
	case "INPUT", "FORWARD", "OUTPUT", "":
		return true
	}
	// nft chain names: conservative charset
	return validIdent(c)
}

// validIdent allows a conservative identifier charset (nft chain/table names,
// fail2ban jail names): letters, digits, dash, underscore, dot.
func validIdent(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

func validIndex(i int) bool  { return i >= 1 && i <= 100000 }
func validHandle(h int) bool { return h >= 0 && h <= 1<<31 }

// sanitizeSpec normalises case + defaults and validates every field, returning
// ErrBadSpec on any violation. After this the spec is safe to shell-quote.
func sanitizeSpec(s *RuleSpec) error {
	s.Action = strings.ToUpper(strings.TrimSpace(s.Action))
	s.Direction = strings.ToLower(strings.TrimSpace(s.Direction))
	if s.Direction == "" {
		s.Direction = "in"
	}
	s.Protocol = strings.ToLower(strings.TrimSpace(s.Protocol))
	if s.Protocol == "" {
		s.Protocol = "tcp"
	}
	s.Port = strings.TrimSpace(s.Port)
	s.Source = strings.TrimSpace(s.Source)
	if !validAction(s.Action) || !validDirection(s.Direction) || !validProto(s.Protocol) ||
		!validPortSpec(s.Port) || !validSource(s.Source) {
		return ErrBadSpec
	}
	// icmp/any without a port is fine; tcp/udp require a port.
	if (s.Protocol == "tcp" || s.Protocol == "udp") && s.Port == "" {
		return ErrBadSpec
	}
	return nil
}

// shellQuote single-quotes a string for safe shell interpolation. Defence in
// depth — values are already whitelisted above.
func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
