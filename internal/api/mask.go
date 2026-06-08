package api

import "strings"

// mask.go holds small, dependency-free PII maskers used when an identifier is
// surfaced for display/forensics (watermark, audit) rather than for contacting
// the user. Masking is fixed-width so it neither leaks the original length nor
// the full value. All maskers are rune-safe.

// maskEmail keeps the first character of the local part and the whole domain:
// "zhang.wei@corp.com" → "z***@corp.com". A single-char local part becomes
// "*@domain". A string without an "@" is masked as a generic identifier.
func maskEmail(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	at := strings.LastIndex(s, "@")
	if at <= 0 {
		return maskGeneric(s)
	}
	local := []rune(s[:at])
	if len(local) <= 1 {
		return "*" + s[at:]
	}
	return string(local[0]) + "***" + s[at:]
}

// maskPhone keeps the first three and last four digits: "13812345678" →
// "138****5678". Shorter strings fall back to keeping the first and last rune,
// and very short ones are fully masked.
func maskPhone(s string) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	switch {
	case len(r) == 0:
		return ""
	case len(r) <= 4:
		return strings.Repeat("*", len(r))
	case len(r) < 7:
		return string(r[0]) + strings.Repeat("*", len(r)-2) + string(r[len(r)-1])
	default:
		return string(r[:3]) + "****" + string(r[len(r)-4:])
	}
}

// maskGeneric masks the middle of an arbitrary identifier, keeping the first
// and last rune ("alice" → "a***e"). Two-or-fewer runes are fully masked.
func maskGeneric(s string) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= 2 {
		return strings.Repeat("*", len(r))
	}
	return string(r[0]) + "***" + string(r[len(r)-1])
}
