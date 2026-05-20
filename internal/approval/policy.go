package approval

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// PolicyDecision is what the policy engine returns for a fresh request.
// Plan / stages / template id all come from the matched template; risk and
// auto_approved are computed from the runtime context.
type PolicyDecision struct {
	TemplateID       *uint64
	TemplateName     string
	Stages           []StageSpec
	RiskLevel        model.ApprovalRiskLevel
	AutoApproved     bool
	AutoApproveReason string
	// MaxDurationSec caps the issued grant when non-zero.
	MaxDurationSec   int
	// DefaultTimeoutSec is per-task timeout; the workflow uses it to set
	// ApprovalTask.ExpiresAt.
	DefaultTimeoutSec int
}

// StageSpec is the runtime representation of one stage inside a template.
// Approvers can be a static list of user IDs, a list of role names, or both
// (the union is taken). The engine resolves role names to concrete user IDs
// via the supplied ApproverLookup when the stage is spawned.
type StageSpec struct {
	Mode       model.ApprovalStageMode `json:"mode"`
	UserIDs    []uint64                `json:"user_ids,omitempty"`
	RoleNames  []string                `json:"role_names,omitempty"`
	QuorumN    int                     `json:"quorum_n,omitempty"`
	TimeoutSec int                     `json:"timeout_sec,omitempty"`
}

// PolicyContext bundles every input the policy engine needs to evaluate a
// request. It's deliberately a flat map rather than a typed struct so future
// fields (HR signal, CMDB tags, asset criticality, requester risk score…)
// don't force a schema migration on every integration.
type PolicyContext struct {
	Request   model.ApprovalRequest `json:"request"`
	Payload   map[string]any        `json:"payload"`
	Requester map[string]any        `json:"requester"`
	Resource  map[string]any        `json:"resource"`
	// Policy is populated mid-evaluation with already-computed fields
	// (risk_level after the risk rule runs) so auto_approve can reference
	// it.
	Policy map[string]any `json:"policy"`
}

// templateBody is the JSON shape every template's Selector / Stages /
// RiskRule / AutoApprove column unmarshals into.
type templateBody struct {
	Selector    selector      `json:"selector"`
	Stages      []StageSpec   `json:"stages"`
	RiskRule    riskRule      `json:"risk_rule"`
	AutoApprove ruleSet       `json:"auto_approve"`
}

type selector struct {
	ResourceTypes []string `json:"resource_types,omitempty"`
	MatchAll      []rule   `json:"match_all,omitempty"`
	MatchAny      []rule   `json:"match_any,omitempty"`
}

type riskRule struct {
	Base    string `json:"base"`
	Promote []struct {
		To   string `json:"to"`
		When []rule `json:"when"`
	} `json:"promote,omitempty"`
}

type ruleSet struct {
	When []rule `json:"when,omitempty"`
}

// rule is one predicate. op = eq | ne | gt | gte | lt | lte | in | not_in |
// contains | any_match | exists. value is the right-hand side; for `in`/
// `not_in` it must be a JSON array; for `any_match` it's a pipe-separated
// alternation string.
type rule struct {
	Field string      `json:"field"`
	Op    string      `json:"op"`
	Value interface{} `json:"value,omitempty"`
}

// PolicyEngine selects a template, computes risk, and decides whether the
// request can be auto-approved. It is stateless; the templates it considers
// come from the repo on every call so admin edits take effect immediately.
type PolicyEngine struct {
	repo *repo.ApprovalRepo
}

// NewPolicyEngine wires the engine to the approval repo. The engine never
// caches templates — admin-driven changes need to take effect across the
// fleet without restart, and the table is small.
func NewPolicyEngine(r *repo.ApprovalRepo) *PolicyEngine { return &PolicyEngine{repo: r} }

// Evaluate picks the highest-priority template that matches the request,
// computes risk, and decides on auto-approval. Returns (nil, nil) when no
// template matches — the service layer treats that as a configuration error
// and rejects the request with a structured 422.
func (p *PolicyEngine) Evaluate(ctx context.Context, pc *PolicyContext) (*PolicyDecision, error) {
	if pc == nil {
		return nil, errors.New("policy: nil context")
	}
	templates, err := p.repo.ListTemplatesForBiz(ctx, pc.Request.BusinessType)
	if err != nil {
		return nil, fmt.Errorf("policy: list templates: %w", err)
	}
	if pc.Policy == nil {
		pc.Policy = map[string]any{}
	}
	for _, tpl := range templates {
		body, err := parseTemplateBody(&tpl)
		if err != nil {
			return nil, fmt.Errorf("policy: parse template %q: %w", tpl.Name, err)
		}
		if !body.Selector.matches(pc) {
			continue
		}
		risk := body.RiskRule.compute(pc)
		pc.Policy["risk_level"] = string(risk)
		autoApproved, reason := body.AutoApprove.eval(pc)
		dec := &PolicyDecision{
			TemplateID:        &tpl.ID,
			TemplateName:      tpl.Name,
			Stages:            body.Stages,
			RiskLevel:         risk,
			AutoApproved:      autoApproved,
			AutoApproveReason: reason,
			MaxDurationSec:    tpl.MaxDurationSec,
			DefaultTimeoutSec: tpl.DefaultTimeoutSec,
		}
		return dec, nil
	}
	return nil, nil
}

func parseTemplateBody(tpl *model.ApprovalTemplate) (*templateBody, error) {
	body := &templateBody{}
	// Each column carries its own JSON object; an empty column means "no
	// matcher" (matches everything for the selector, "low" for the risk
	// rule, "never auto-approve" for the auto_approve rule).
	if s := strings.TrimSpace(tpl.Selector); s != "" {
		if err := json.Unmarshal([]byte(s), &body.Selector); err != nil {
			return nil, fmt.Errorf("selector: %w", err)
		}
	}
	if s := strings.TrimSpace(tpl.Stages); s != "" {
		if err := json.Unmarshal([]byte(s), &body.Stages); err != nil {
			return nil, fmt.Errorf("stages: %w", err)
		}
	}
	if s := strings.TrimSpace(tpl.RiskRule); s != "" {
		if err := json.Unmarshal([]byte(s), &body.RiskRule); err != nil {
			return nil, fmt.Errorf("risk_rule: %w", err)
		}
	}
	if s := strings.TrimSpace(tpl.AutoApprove); s != "" {
		if err := json.Unmarshal([]byte(s), &body.AutoApprove); err != nil {
			return nil, fmt.Errorf("auto_approve: %w", err)
		}
	}
	return body, nil
}

// ----- selector -----

func (s selector) matches(pc *PolicyContext) bool {
	if len(s.ResourceTypes) > 0 {
		// resource_type can be empty when the request didn't target a
		// concrete resource (audit_view, break_glass) — those should be
		// matched by a catch-all selector instead.
		hit := false
		for _, rt := range s.ResourceTypes {
			if rt == pc.Request.ResourceType {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	for _, r := range s.MatchAll {
		if !r.eval(pc) {
			return false
		}
	}
	if len(s.MatchAny) > 0 {
		hit := false
		for _, r := range s.MatchAny {
			if r.eval(pc) {
				hit = true
				break
			}
		}
		if !hit {
			return false
		}
	}
	return true
}

// ----- risk rule -----

func (r riskRule) compute(pc *PolicyContext) model.ApprovalRiskLevel {
	base := model.ApprovalRiskMedium
	if r.Base != "" {
		base = model.ApprovalRiskLevel(r.Base)
	}
	current := base
	for _, p := range r.Promote {
		all := true
		for _, c := range p.When {
			if !c.eval(pc) {
				all = false
				break
			}
		}
		if all && riskRank(model.ApprovalRiskLevel(p.To)) > riskRank(current) {
			current = model.ApprovalRiskLevel(p.To)
		}
	}
	return current
}

func riskRank(l model.ApprovalRiskLevel) int {
	switch l {
	case model.ApprovalRiskLow:
		return 1
	case model.ApprovalRiskMedium:
		return 2
	case model.ApprovalRiskHigh:
		return 3
	case model.ApprovalRiskCritical:
		return 4
	}
	return 0
}

// ----- auto-approve -----

func (a ruleSet) eval(pc *PolicyContext) (bool, string) {
	if len(a.When) == 0 {
		return false, ""
	}
	for _, c := range a.When {
		if !c.eval(pc) {
			return false, ""
		}
	}
	return true, "auto_approve.when matched"
}

// ----- rule evaluator -----

func (c rule) eval(pc *PolicyContext) bool {
	lhs, ok := lookupField(pc, c.Field)
	if c.Op == "exists" {
		return ok
	}
	switch c.Op {
	case "eq":
		return jsonEqual(lhs, c.Value)
	case "ne":
		return !jsonEqual(lhs, c.Value)
	case "gt":
		ln, rn, ok := bothNum(lhs, c.Value)
		return ok && ln > rn
	case "gte":
		ln, rn, ok := bothNum(lhs, c.Value)
		return ok && ln >= rn
	case "lt":
		ln, rn, ok := bothNum(lhs, c.Value)
		return ok && ln < rn
	case "lte":
		ln, rn, ok := bothNum(lhs, c.Value)
		return ok && ln <= rn
	case "in":
		return contains(c.Value, lhs)
	case "not_in":
		return !contains(c.Value, lhs)
	case "contains":
		// Either lhs is a string containing rhs, or lhs is an array
		// containing rhs.
		if lhsStr, ok := lhs.(string); ok {
			if rhsStr, ok := c.Value.(string); ok {
				return strings.Contains(lhsStr, rhsStr)
			}
		}
		return contains(lhs, c.Value)
	case "any_match":
		// rhs is a pipe-separated alternation of substrings; lhs is a
		// string or array-of-strings. Used for "command in deny-list"
		// checks where the deny-list is encoded inline.
		needles, ok := c.Value.(string)
		if !ok {
			return false
		}
		parts := strings.Split(needles, "|")
		switch v := lhs.(type) {
		case string:
			for _, p := range parts {
				if p != "" && strings.Contains(v, p) {
					return true
				}
			}
		case []any:
			for _, item := range v {
				if s, ok := item.(string); ok {
					for _, p := range parts {
						if p != "" && strings.Contains(s, p) {
							return true
						}
					}
				}
			}
		}
		return false
	}
	return false
}

func lookupField(pc *PolicyContext, path string) (any, bool) {
	if path == "" {
		return nil, false
	}
	parts := strings.SplitN(path, ".", 2)
	root := parts[0]
	var rest string
	if len(parts) == 2 {
		rest = parts[1]
	}
	var src any
	switch root {
	case "request":
		// Walk the struct via JSON round-trip so dotted paths like
		// "request.business_type" work without a hand-rolled reflect
		// switch.
		b, _ := json.Marshal(pc.Request)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		src = m
	case "payload":
		src = pc.Payload
	case "requester":
		src = pc.Requester
	case "resource":
		src = pc.Resource
	case "policy":
		src = pc.Policy
	default:
		return nil, false
	}
	if rest == "" {
		return src, src != nil
	}
	return walk(src, strings.Split(rest, "."))
}

func walk(node any, path []string) (any, bool) {
	for _, key := range path {
		m, ok := node.(map[string]any)
		if !ok {
			return nil, false
		}
		v, present := m[key]
		if !present {
			return nil, false
		}
		node = v
	}
	return node, true
}

func jsonEqual(a, b any) bool {
	// json.Number / float / int / string / bool round-tripping: marshal both
	// sides and compare. It's slow but selectors run once per request — not
	// hot.
	ba, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	return string(ba) == string(bb)
}

func bothNum(a, b any) (float64, float64, bool) {
	af, ok1 := toFloat(a)
	bf, ok2 := toFloat(b)
	if !ok1 || !ok2 {
		return 0, 0, false
	}
	return af, bf, true
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case float32:
		return float64(n), true
	case int:
		return float64(n), true
	case int32:
		return float64(n), true
	case int64:
		return float64(n), true
	case uint:
		return float64(n), true
	case uint32:
		return float64(n), true
	case uint64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

func contains(haystack, needle any) bool {
	arr, ok := haystack.([]any)
	if !ok {
		// Allow []string convenience for inline DSL authors.
		ss, ok := haystack.([]string)
		if !ok {
			return false
		}
		for _, s := range ss {
			if jsonEqual(s, needle) {
				return true
			}
		}
		return false
	}
	for _, item := range arr {
		if jsonEqual(item, needle) {
			return true
		}
	}
	return false
}
