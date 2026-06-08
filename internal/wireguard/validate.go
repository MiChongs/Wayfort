package wireguard

import (
	"encoding/base64"
	"net/netip"
	"strconv"
	"strings"
)

// validate.go is the first line of command-injection defence: every
// user-controllable value that ends up in an SSH command is checked against a
// strict whitelist here before it is shell-quoted. Multi-line content (conf /
// preshared keys) never goes through interpolation at all — it travels as a
// base64 literal over stdin (see config_file.go).

// validCIDR reports whether s is a valid IP prefix like "10.8.0.1/24".
func validCIDR(s string) bool {
	p, err := netip.ParsePrefix(strings.TrimSpace(s))
	return err == nil && p.IsValid()
}

// validHostIP reports whether s is a bare IP address (no prefix).
func validHostIP(s string) bool {
	a, err := netip.ParseAddr(strings.TrimSpace(s))
	return err == nil && a.IsValid()
}

func validPort(p int) bool { return p >= 1 && p <= 65535 }

// validMTU allows 0 (use kernel default) or a sane tunnel MTU range.
func validMTU(m int) bool { return m == 0 || (m >= 1280 && m <= 1500) }

// validKeepalive allows 0 (disabled) up to 65535 seconds.
func validKeepalive(k int) bool { return k >= 0 && k <= 65535 }

// validWGKey reports whether s is a canonical Curve25519/PSK key: 44 base64
// chars decoding to exactly 32 bytes. Used for private keys, public keys and
// preshared keys alike.
func validWGKey(s string) bool {
	s = strings.TrimSpace(s)
	if len(s) != 44 {
		return false
	}
	b, err := base64.StdEncoding.DecodeString(s)
	return err == nil && len(b) == 32
}

// validAllowedIPs requires a non-empty list of valid CIDRs.
func validAllowedIPs(list []string) bool {
	if len(list) == 0 {
		return false
	}
	for _, c := range list {
		if !validCIDR(c) {
			return false
		}
	}
	return true
}

// validEndpoint accepts "host:port" where host is an IP (v4, or v6 in brackets)
// or an RFC1123-ish hostname, and port is in range. Any shell metacharacter in
// the host makes it invalid — there is no path for injection.
func validEndpoint(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	// netip handles "1.2.3.4:51820" and "[::1]:51820".
	if ap, err := netip.ParseAddrPort(s); err == nil {
		return ap.IsValid()
	}
	// hostname:port
	i := strings.LastIndexByte(s, ':')
	if i <= 0 || i == len(s)-1 {
		return false
	}
	host, portStr := s[:i], s[i+1:]
	port, err := strconv.Atoi(portStr)
	if err != nil || !validPort(port) {
		return false
	}
	return validHostname(host)
}

// validHostname enforces a conservative RFC1123 label set (letters, digits,
// dot, hyphen) — deliberately excludes anything a shell would interpret.
func validHostname(h string) bool {
	if h == "" || len(h) > 253 {
		return false
	}
	for _, r := range h {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '-') {
			return false
		}
	}
	// Must not start/end with a separator.
	if strings.HasPrefix(h, ".") || strings.HasPrefix(h, "-") ||
		strings.HasSuffix(h, ".") || strings.HasSuffix(h, "-") {
		return false
	}
	return true
}

// validEgressIface reuses the interface-name charset for the NAT egress device
// (e.g. eth0, ens3, enp0s3). Same constraints as a WireGuard interface name.
func validEgressIface(s string) bool { return validIface(s) }
