package accesscontrol

import (
	"context"
	"testing"

	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/pkg/edition"
)

func TestGlobMatch(t *testing.T) {
	cases := []struct {
		pat, name string
		want      bool
	}{
		{"password", "password", true},
		{"password", "Password", true}, // case-insensitive
		{"pass*", "passwd", true},
		{"*secret", "api_secret", true},
		{"*pwd*", "user_pwd_hash", true},
		{"password", "passphrase", false},
		{"pass*", "xpass", false},
		{"*secret", "secretx", false},
	}
	for _, c := range cases {
		if got := globMatch(c.pat, c.name); got != c.want {
			t.Errorf("globMatch(%q,%q)=%v want %v", c.pat, c.name, got, c.want)
		}
	}
}

func TestMaskApply(t *testing.T) {
	fixed := &MaskPlan{method: "fixed"}
	if fixed.Apply("hunter2") != "******" {
		t.Fatal("fixed mask should be ******")
	}
	if fixed.Apply(nil) != nil {
		t.Fatal("nil stays nil")
	}
	partial := &MaskPlan{method: "partial"}
	if got := partial.Apply("hunter2"); got != "h****2" {
		t.Fatalf("partial mask = %v", got)
	}
	if got := partial.Apply("ab"); got != "**" {
		t.Fatalf("short partial = %v", got)
	}
	hash := &MaskPlan{method: "hash"}
	h1 := hash.Apply("secret")
	if s, ok := h1.(string); !ok || len(s) != 12 {
		t.Fatalf("hash should be 12 hex chars, got %v", h1)
	}
	if hash.Apply("secret") != h1 {
		t.Fatal("hash must be deterministic")
	}
}

func TestDataMaskGatedFailsOpen(t *testing.T) {
	rules := []model.AccessRule{
		{ID: 1, Kind: model.RuleDataMasking, Priority: 50, Active: true, Action: model.ActionAccept, Spec: `{"columns":["password"],"method":"fixed"}`},
	}
	e := eng(rules, model.RuleDataMasking, nil, fakeEdition{}) // unlicensed
	plan, err := e.DataMask(context.Background(), Input{UserID: 1, NodeID: 1})
	if err != nil || plan != nil {
		t.Fatalf("unlicensed data_masking must fail open (nil plan), got %v err=%v", plan, err)
	}
}

func TestDataMaskResolvesPlan(t *testing.T) {
	rules := []model.AccessRule{
		{ID: 1, Kind: model.RuleDataMasking, Priority: 50, Active: true, Action: model.ActionAccept, Spec: `{"columns":["pass*","*secret"],"method":"partial"}`},
	}
	e := eng(rules, model.RuleDataMasking, nil, fakeEdition{edition.FeatureDataMasking: true})
	plan, err := e.DataMask(context.Background(), Input{UserID: 1, NodeID: 1})
	if err != nil || plan == nil {
		t.Fatalf("licensed rule should yield a plan, got %v err=%v", plan, err)
	}
	if !plan.ShouldMask("password") || !plan.ShouldMask("api_secret") {
		t.Fatal("plan should mask matching columns")
	}
	if plan.ShouldMask("username") {
		t.Fatal("plan must not mask non-matching columns")
	}
}
