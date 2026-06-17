package accesscontrol

import (
	"context"
	"testing"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/pkg/edition"
)

type fakeRules struct {
	byKind map[model.AccessRuleKind][]model.AccessRule
}

func (f fakeRules) ListActiveByKind(_ context.Context, kind model.AccessRuleKind) ([]model.AccessRule, error) {
	return f.byKind[kind], nil
}

type fakeGrantees map[uint64]map[model.GranteeType][]uint64

func (f fakeGrantees) GranteesForUser(_ context.Context, uid uint64) (map[model.GranteeType][]uint64, error) {
	return f[uid], nil
}

type fakeEdition map[string]bool

func (f fakeEdition) Has(feat string) bool { return f[feat] }

func eng(rules []model.AccessRule, kind model.AccessRuleKind, g fakeGrantees, ed FeatureChecker) *Engine {
	return NewEngine(fakeRules{byKind: map[model.AccessRuleKind][]model.AccessRule{kind: rules}}, g, ed, nil)
}

func TestPriorityFirstMatch(t *testing.T) {
	rules := []model.AccessRule{
		{ID: 1, Kind: model.RuleUserLogin, Priority: 10, Active: true, Users: "", Action: model.ActionDeny},   // all users
		{ID: 2, Kind: model.RuleUserLogin, Priority: 20, Active: true, Users: "", Action: model.ActionAccept}, // never reached
	}
	d, err := eng(rules, model.RuleUserLogin, nil, nil).Evaluate(context.Background(), model.RuleUserLogin, Input{UserID: 5})
	if err != nil {
		t.Fatal(err)
	}
	if !d.Matched || d.Action != model.ActionDeny || d.Rule.ID != 1 {
		t.Fatalf("want deny by rule 1, got %+v", d)
	}
}

func TestUserDimensionViaGrantees(t *testing.T) {
	// Rule targets group 7; user 5 belongs to group 7.
	rules := []model.AccessRule{
		{ID: 1, Kind: model.RuleUserLogin, Priority: 50, Active: true, Users: `{"group_ids":[7]}`, Action: model.ActionReview},
	}
	g := fakeGrantees{5: {model.GranteeGroup: {7}}}
	d, _ := eng(rules, model.RuleUserLogin, g, nil).Evaluate(context.Background(), model.RuleUserLogin, Input{UserID: 5})
	if !d.Matched || d.Action != model.ActionReview {
		t.Fatalf("want review for group member, got %+v", d)
	}
	// User 6 not in group 7 → no match → accept.
	g2 := fakeGrantees{6: {model.GranteeGroup: {99}}}
	d2, _ := eng(rules, model.RuleUserLogin, g2, nil).Evaluate(context.Background(), model.RuleUserLogin, Input{UserID: 6})
	if d2.Matched {
		t.Fatalf("non-member should not match, got %+v", d2)
	}
}

func TestAccountDimensionCredential(t *testing.T) {
	rules := []model.AccessRule{
		{ID: 1, Kind: model.RuleConnectionMethod, Priority: 50, Active: true, Accounts: `{"credential_ids":[42]}`, Action: model.ActionDeny},
	}
	ed := fakeEdition{edition.FeatureConnectionMethod: true}
	d, _ := eng(rules, model.RuleConnectionMethod, nil, ed).Evaluate(context.Background(), model.RuleConnectionMethod, Input{UserID: 1, CredentialID: 42})
	if !d.Matched || d.Action != model.ActionDeny {
		t.Fatalf("want deny for credential 42, got %+v", d)
	}
	d2, _ := eng(rules, model.RuleConnectionMethod, nil, ed).Evaluate(context.Background(), model.RuleConnectionMethod, Input{UserID: 1, CredentialID: 7})
	if d2.Matched {
		t.Fatalf("other credential should not match, got %+v", d2)
	}
}

func TestXPackGatingFailsOpen(t *testing.T) {
	rules := []model.AccessRule{
		{ID: 1, Kind: model.RuleConnectionMethod, Priority: 50, Active: true, Action: model.ActionDeny}, // all
	}
	// Unlicensed → gated → no enforcement (accept), even though a deny-all rule exists.
	unlicensed := fakeEdition{}
	d, _ := eng(rules, model.RuleConnectionMethod, nil, unlicensed).Evaluate(context.Background(), model.RuleConnectionMethod, Input{UserID: 1})
	if d.Matched || d.Action != model.ActionAccept {
		t.Fatalf("unlicensed X-Pack must fail open, got %+v", d)
	}
	// Licensed → the deny-all fires.
	licensed := fakeEdition{edition.FeatureConnectionMethod: true}
	d2, _ := eng(rules, model.RuleConnectionMethod, nil, licensed).Evaluate(context.Background(), model.RuleConnectionMethod, Input{UserID: 1})
	if !d2.Matched || d2.Action != model.ActionDeny {
		t.Fatalf("licensed deny-all must fire, got %+v", d2)
	}
}

func TestCommunityKindNeverGated(t *testing.T) {
	rules := []model.AccessRule{{ID: 1, Kind: model.RuleCommandFilter, Priority: 50, Active: true, Action: model.ActionAlert}}
	// nil edition + empty edition both: command_filter is Community, always evaluated.
	d, _ := eng(rules, model.RuleCommandFilter, nil, fakeEdition{}).Evaluate(context.Background(), model.RuleCommandFilter, Input{UserID: 1})
	if !d.Matched || d.Action != model.ActionAlert {
		t.Fatalf("community kind must evaluate regardless of edition, got %+v", d)
	}
}

func TestIPRestriction(t *testing.T) {
	rules := []model.AccessRule{
		{ID: 1, Kind: model.RuleUserLogin, Priority: 50, Active: true, IPRule: "10.0.0.0/8, 192.168.1.5", Action: model.ActionAccept},
	}
	in := func(ip string) Input { return Input{UserID: 1, ClientIP: ip} }
	if d, _ := eng(rules, model.RuleUserLogin, nil, nil).Evaluate(context.Background(), model.RuleUserLogin, in("10.2.3.4")); !d.Matched {
		t.Fatal("10.2.3.4 should match 10.0.0.0/8")
	}
	if d, _ := eng(rules, model.RuleUserLogin, nil, nil).Evaluate(context.Background(), model.RuleUserLogin, in("192.168.1.5")); !d.Matched {
		t.Fatal("exact IP should match")
	}
	if d, _ := eng(rules, model.RuleUserLogin, nil, nil).Evaluate(context.Background(), model.RuleUserLogin, in("8.8.8.8")); d.Matched {
		t.Fatal("8.8.8.8 should NOT match")
	}
}

func TestValidityWindow(t *testing.T) {
	past := time.Now().Add(-2 * time.Hour)
	future := time.Now().Add(-1 * time.Hour)
	rules := []model.AccessRule{
		{ID: 1, Kind: model.RuleUserLogin, Priority: 50, Active: true, ValidFrom: &past, ValidTo: &future, Action: model.ActionDeny},
	}
	d, _ := eng(rules, model.RuleUserLogin, nil, nil).Evaluate(context.Background(), model.RuleUserLogin, Input{UserID: 1})
	if d.Matched {
		t.Fatalf("expired-validity rule must not match, got %+v", d)
	}
}
