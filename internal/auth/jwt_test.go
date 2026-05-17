package auth

import (
	"testing"
	"time"
)

func TestIssueAndParse(t *testing.T) {
	iss := NewIssuer("secret-for-testing-purposes-only-x", time.Minute, time.Hour)
	pair, err := iss.Issue(Claims{UserID: 7, Username: "alice", Admin: true, Step: AuthStepActive})
	if err != nil {
		t.Fatal(err)
	}
	if pair.AccessToken == "" || pair.RefreshToken == "" {
		t.Fatal("missing tokens")
	}
	c, err := iss.Parse(pair.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	if c.UserID != 7 || c.Username != "alice" || !c.Admin {
		t.Fatalf("claims roundtrip: %+v", c)
	}
	if c.ID == "" {
		t.Fatal("missing jti")
	}
}

func TestChallengeToken(t *testing.T) {
	iss := NewIssuer("secret-for-testing-purposes-only-x", time.Minute, time.Hour)
	tok, exp, err := iss.IssueChallenge(42, "bob", []string{"totp"}, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if exp.Before(time.Now()) {
		t.Fatal("challenge already expired")
	}
	c, err := iss.Parse(tok)
	if err != nil {
		t.Fatal(err)
	}
	if c.Step != AuthStepMFARequired || c.UserID != 42 {
		t.Fatalf("bad challenge: %+v", c)
	}
	if len(c.Methods) != 1 || c.Methods[0] != "totp" {
		t.Fatalf("methods missing: %v", c.Methods)
	}
}

func TestRefreshTokenStep(t *testing.T) {
	iss := NewIssuer("secret-for-testing-purposes-only-x", time.Minute, time.Hour)
	pair, _ := iss.Issue(Claims{UserID: 1, Username: "u", Step: AuthStepActive})
	rc, err := iss.Parse(pair.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if rc.Step != AuthStepRefresh {
		t.Fatalf("expected refresh step, got %q", rc.Step)
	}
}
