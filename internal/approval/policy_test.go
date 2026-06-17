package approval

import (
	"testing"

	"github.com/michongs/wayfort/internal/model"
)

func TestRuleEval_Equality(t *testing.T) {
	pc := &PolicyContext{
		Request: model.ApprovalRequest{
			BusinessType: model.ApprovalBizAssetAccess,
			ResourceType: "node",
		},
		Payload: map[string]any{
			"duration_hours": float64(2),
			"environment":    "prod",
		},
		Requester: map[string]any{
			"roles": []any{"operator"},
		},
		Policy: map[string]any{
			"risk_level": "medium",
		},
	}
	cases := []struct {
		name string
		r    rule
		want bool
	}{
		{"eq match", rule{Field: "payload.environment", Op: "eq", Value: "prod"}, true},
		{"eq mismatch", rule{Field: "payload.environment", Op: "eq", Value: "dev"}, false},
		{"ne", rule{Field: "payload.environment", Op: "ne", Value: "dev"}, true},
		{"gt true", rule{Field: "payload.duration_hours", Op: "gt", Value: float64(1)}, true},
		{"gt false", rule{Field: "payload.duration_hours", Op: "gt", Value: float64(5)}, false},
		{"in true", rule{Field: "payload.environment", Op: "in", Value: []any{"prod", "stg"}}, true},
		{"in false", rule{Field: "payload.environment", Op: "in", Value: []any{"dev"}}, false},
		{"exists true", rule{Field: "payload.environment", Op: "exists"}, true},
		{"exists false", rule{Field: "payload.nonexistent", Op: "exists"}, false},
		{"any_match true", rule{Field: "payload.environment", Op: "any_match", Value: "prod|stage"}, true},
		{"policy ref", rule{Field: "policy.risk_level", Op: "eq", Value: "medium"}, true},
		{"request ref", rule{Field: "request.resource_type", Op: "eq", Value: "node"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.r.eval(pc); got != tc.want {
				t.Fatalf("rule(%+v) = %v, want %v", tc.r, got, tc.want)
			}
		})
	}
}

func TestRiskRule_Compute(t *testing.T) {
	pc := &PolicyContext{
		Payload: map[string]any{"duration_hours": float64(48)},
	}
	r := riskRule{
		Base: "medium",
		Promote: []struct {
			To   string `json:"to"`
			When []rule `json:"when"`
		}{
			{To: "high", When: []rule{{Field: "payload.duration_hours", Op: "gt", Value: float64(24)}}},
			{To: "critical", When: []rule{{Field: "payload.duration_hours", Op: "gt", Value: float64(100)}}},
		},
	}
	got := r.compute(pc)
	if got != model.ApprovalRiskHigh {
		t.Fatalf("compute = %v, want high", got)
	}
}

func TestRiskRule_BaseOnlyWhenNoneMatch(t *testing.T) {
	pc := &PolicyContext{Payload: map[string]any{}}
	r := riskRule{
		Base: "low",
		Promote: []struct {
			To   string `json:"to"`
			When []rule `json:"when"`
		}{
			{To: "high", When: []rule{{Field: "payload.missing", Op: "exists"}}},
		},
	}
	if got := r.compute(pc); got != model.ApprovalRiskLow {
		t.Fatalf("compute = %v, want low", got)
	}
}

func TestSelectorMatches_ResourceType(t *testing.T) {
	pc := &PolicyContext{
		Request: model.ApprovalRequest{ResourceType: "node"},
	}
	s := selector{ResourceTypes: []string{"node", "credential"}}
	if !s.matches(pc) {
		t.Fatal("expected match on node")
	}
	s2 := selector{ResourceTypes: []string{"credential"}}
	if s2.matches(pc) {
		t.Fatal("expected no match")
	}
}

func TestSelectorMatches_MatchAllAndAny(t *testing.T) {
	pc := &PolicyContext{
		Request: model.ApprovalRequest{ResourceType: "node"},
		Payload: map[string]any{
			"environment": "prod",
			"tag":         "db",
		},
	}
	// all must match
	s := selector{
		MatchAll: []rule{
			{Field: "payload.environment", Op: "eq", Value: "prod"},
			{Field: "payload.tag", Op: "eq", Value: "db"},
		},
	}
	if !s.matches(pc) {
		t.Fatal("match_all should pass")
	}
	// one of the match_any must match
	s = selector{
		MatchAny: []rule{
			{Field: "payload.tag", Op: "eq", Value: "web"},
			{Field: "payload.tag", Op: "eq", Value: "db"},
		},
	}
	if !s.matches(pc) {
		t.Fatal("match_any should pass")
	}
}

func TestAutoApprove_EmptyMeansNever(t *testing.T) {
	pc := &PolicyContext{Policy: map[string]any{"risk_level": "low"}}
	rs := ruleSet{}
	if ok, _ := rs.eval(pc); ok {
		t.Fatal("empty rule set must not auto-approve")
	}
}

func TestAutoApprove_AllConditionsMustMatch(t *testing.T) {
	pc := &PolicyContext{
		Policy: map[string]any{"risk_level": "low"},
		Requester: map[string]any{
			"is_admin": true,
		},
	}
	rs := ruleSet{
		When: []rule{
			{Field: "policy.risk_level", Op: "eq", Value: "low"},
			{Field: "requester.is_admin", Op: "eq", Value: true},
		},
	}
	ok, _ := rs.eval(pc)
	if !ok {
		t.Fatal("expected auto-approve")
	}

	// flipping any one breaks it
	rs.When[1].Value = false
	ok, _ = rs.eval(pc)
	if ok {
		t.Fatal("expected no auto-approve")
	}
}

func TestLookupField_NestedPath(t *testing.T) {
	pc := &PolicyContext{
		Payload: map[string]any{
			"outer": map[string]any{
				"inner": "value",
			},
		},
	}
	v, ok := lookupField(pc, "payload.outer.inner")
	if !ok || v != "value" {
		t.Fatalf("lookupField returned %v, ok=%v", v, ok)
	}
}
