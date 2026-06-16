package accesscontrol

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// maskSpec is the parsed AccessRule.Spec for a data_masking rule.
type maskSpec struct {
	// Columns are column-name patterns; "*" is a wildcard (e.g. "password",
	// "pass*", "*secret", "*pwd*"). Matching is case-insensitive.
	Columns []string `json:"columns"`
	// Method is how matched values are redacted: "fixed" (default, "******"),
	// "partial" (keep first/last char), or "hash" (sha256 prefix).
	Method string `json:"method"`
}

// MaskPlan is the resolved column-masking instruction for a query result.
type MaskPlan struct {
	patterns []string
	method   string
}

// DataMask returns the column-mask plan for a query (first matching data_masking
// rule), or nil when the feature is unlicensed (fail-open), no rule matches, or
// the rule defines no columns.
func (e *Engine) DataMask(ctx context.Context, in Input) (*MaskPlan, error) {
	if e.Gated(model.RuleDataMasking) {
		return nil, nil
	}
	dec, err := e.Evaluate(ctx, model.RuleDataMasking, in)
	if err != nil || !dec.Matched || dec.Rule == nil {
		return nil, err
	}
	var s maskSpec
	if jerr := json.Unmarshal([]byte(strings.TrimSpace(dec.Rule.Spec)), &s); jerr != nil {
		return nil, nil
	}
	pats := make([]string, 0, len(s.Columns))
	for _, c := range s.Columns {
		if c = strings.TrimSpace(c); c != "" {
			pats = append(pats, c)
		}
	}
	if len(pats) == 0 {
		return nil, nil
	}
	method := strings.ToLower(strings.TrimSpace(s.Method))
	if method == "" {
		method = "fixed"
	}
	return &MaskPlan{patterns: pats, method: method}, nil
}

// ShouldMask reports whether a column name matches any mask pattern.
func (p *MaskPlan) ShouldMask(column string) bool {
	if p == nil {
		return false
	}
	for _, pat := range p.patterns {
		if globMatch(pat, column) {
			return true
		}
	}
	return false
}

// Apply redacts a single cell value per the plan's method. nil stays nil so a
// NULL is not turned into a masked string.
func (p *MaskPlan) Apply(v any) any {
	if p == nil || v == nil {
		return v
	}
	s := fmt.Sprint(v)
	switch p.method {
	case "hash":
		sum := sha256.Sum256([]byte(s))
		return hex.EncodeToString(sum[:])[:12]
	case "partial":
		return partialMask(s)
	default: // "fixed"
		return "******"
	}
}

func partialMask(s string) string {
	r := []rune(s)
	switch {
	case len(r) == 0:
		return ""
	case len(r) <= 2:
		return strings.Repeat("*", len(r))
	default:
		return string(r[0]) + "****" + string(r[len(r)-1])
	}
}

// globMatch is a case-insensitive glob supporting "*" wildcards anywhere.
func globMatch(pattern, name string) bool {
	pat := strings.ToLower(strings.TrimSpace(pattern))
	s := strings.ToLower(name)
	if !strings.Contains(pat, "*") {
		return pat == s
	}
	parts := strings.Split(pat, "*")
	// leading anchor
	if parts[0] != "" {
		if !strings.HasPrefix(s, parts[0]) {
			return false
		}
		s = s[len(parts[0]):]
	}
	// trailing anchor
	last := parts[len(parts)-1]
	// middle segments, in order
	for _, mid := range parts[1 : len(parts)-1] {
		if mid == "" {
			continue
		}
		idx := strings.Index(s, mid)
		if idx < 0 {
			return false
		}
		s = s[idx+len(mid):]
	}
	if last != "" {
		return strings.HasSuffix(s, last)
	}
	return true
}
