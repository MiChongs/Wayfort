package export

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/michongs/wayfort/internal/model"
)

// cefSeverity maps an audit kind to a CEF severity 0–10. Abnormal events
// (failures, deletes, force-offs) score higher so SIEM correlation rules can
// triage on it.
func cefSeverity(ev model.AuditLog) int {
	if ev.IsAbnormal() {
		return 7
	}
	switch ev.Kind {
	case model.AuditLogin, model.AuditSessionStart, model.AuditSessionEnd:
		return 3
	default:
		return 5
	}
}

// FormatCEF renders an audit event as an ArcSight CEF line
// (security-architecture.md §10). The custom string fields cs1/cs2 carry the
// tamper-evidence chain_id + entry_hash so the SIEM can cross-verify a delivered
// event against the gateway's internal integrity report — double non-repudiation.
//
//	CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
func FormatCEF(ev model.AuditLog) string {
	header := fmt.Sprintf("CEF:0|Wayfort|Gateway|1.0|%s|%s|%d|",
		cefEscapeHeader(string(ev.Kind)),
		cefEscapeHeader(string(ev.Kind)),
		cefSeverity(ev),
	)
	ext := cefExtension(ev)
	return header + ext
}

// cefExtension builds the key=value extension, escaping per CEF rules.
func cefExtension(ev model.AuditLog) string {
	pairs := []struct{ k, v string }{
		{"rt", strconv.FormatInt(ev.CreatedAt.UnixMilli(), 10)},
		{"suser", ev.Username},
		{"suid", strconv.FormatUint(ev.UserID, 10)},
		{"src", ev.ClientIP},
		{"act", string(ev.Kind)},
		{"cat", model.AuditCategoryOf(string(ev.Kind))},
		{"externalId", ev.SessionID},
		{"outcome", outcomeOf(ev)},
		{"msg", ev.Payload},
		{"cs1Label", "chainId"},
		{"cs1", ev.ChainID},
		{"cs2Label", "entryHash"},
		{"cs2", ev.EntryHash},
	}
	if ev.NodeID != nil {
		pairs = append(pairs, struct{ k, v string }{"dvchost", strconv.FormatUint(*ev.NodeID, 10)})
	}
	var b strings.Builder
	first := true
	for _, p := range pairs {
		if p.v == "" {
			continue
		}
		if !first {
			b.WriteByte(' ')
		}
		first = false
		b.WriteString(p.k)
		b.WriteByte('=')
		b.WriteString(cefEscapeValue(p.v))
	}
	return b.String()
}

func outcomeOf(ev model.AuditLog) string {
	if ev.IsAbnormal() {
		return "failure"
	}
	return "success"
}

// cefEscapeHeader escapes the pipe + backslash that delimit CEF header fields.
func cefEscapeHeader(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `|`, `\|`)
	return s
}

// cefEscapeValue escapes backslash, equals, and newlines in extension values.
func cefEscapeValue(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `=`, `\=`)
	s = strings.ReplaceAll(s, "\n", `\n`)
	s = strings.ReplaceAll(s, "\r", `\r`)
	return s
}
