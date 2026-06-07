package settings

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/config"
)

// TestEveryManagedKeyResolves guards the single biggest risk: a registry key
// whose dotted path doesn't actually match a config.Config mapstructure tag.
// flatten() walks the struct by tag, so a typo surfaces here as an error.
func TestEveryManagedKeyResolves(t *testing.T) {
	cfg := &config.Config{}
	for _, s := range Specs() {
		if _, err := flatten(cfg, s); err != nil {
			t.Errorf("spec %q does not resolve against config.Config: %v", s.Key, err)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	cfg := &config.Config{}
	cases := []struct {
		key string
		raw string
		get func(*config.Config) any
		exp any
	}{
		{"desktop.webrtc.enabled", `true`, func(c *config.Config) any { return c.Desktop.WebRTC.Enabled }, true},
		{"auth.lockout.threshold", `9`, func(c *config.Config) any { return c.Auth.Lockout.Threshold }, 9},
		{"auth.access_ttl", `"2h30m"`, func(c *config.Config) any { return c.Auth.AccessTTL }, 2*time.Hour + 30*time.Minute},
		{"ai.default_permission_mode", `"bypass"`, func(c *config.Config) any { return c.AI.DefaultPermissionMode }, "bypass"},
		{"anonymous.cpu", `1.5`, func(c *config.Config) any { return c.Anonymous.CPU }, 1.5},
		{"anonymous.memory_mb", `256`, func(c *config.Config) any { return c.Anonymous.MemoryMB }, int64(256)},
		{"notify.smtp.password", `"s3cr3t"`, func(c *config.Config) any { return c.Notify.SMTP.Password }, "s3cr3t"},
	}
	for _, tc := range cases {
		spec, ok := SpecByKey(tc.key)
		if !ok {
			t.Fatalf("missing spec %q", tc.key)
		}
		if err := apply(cfg, spec, json.RawMessage(tc.raw)); err != nil {
			t.Fatalf("apply %q: %v", tc.key, err)
		}
		got := tc.get(cfg)
		if !reflect.DeepEqual(got, tc.exp) {
			t.Errorf("%q: got %#v want %#v", tc.key, got, tc.exp)
		}
		// flatten should reproduce a JSON-stable view.
		if _, err := flatten(cfg, spec); err != nil {
			t.Errorf("flatten %q: %v", tc.key, err)
		}
	}
}

func TestStringListAndMap(t *testing.T) {
	cfg := &config.Config{}
	list, _ := SpecByKey("ai.ssh_exec_readonly_allow")
	if err := apply(cfg, list, json.RawMessage(`["ss","ip a"]`)); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cfg.AI.SSHExecReadOnlyAllow, []string{"ss", "ip a"}) {
		t.Errorf("stringlist mismatch: %#v", cfg.AI.SSHExecReadOnlyAllow)
	}
	m, _ := SpecByKey("protocols.dbcli.images")
	if err := apply(cfg, m, json.RawMessage(`{"mysql":"mysql:8.0"}`)); err != nil {
		t.Fatal(err)
	}
	if cfg.Protocols.DBCLI.Images["mysql"] != "mysql:8.0" {
		t.Errorf("stringmap mismatch: %#v", cfg.Protocols.DBCLI.Images)
	}
}

func TestValidateRange(t *testing.T) {
	spec, _ := SpecByKey("auth.lockout.threshold")
	if err := validateValue(spec, json.RawMessage(`0`)); err == nil {
		t.Error("expected range error for 0 below min")
	}
	if err := validateValue(spec, json.RawMessage(`5`)); err != nil {
		t.Errorf("5 should be valid: %v", err)
	}
	dur, _ := SpecByKey("auth.access_ttl")
	if err := validateValue(dur, json.RawMessage(`"banana"`)); err == nil {
		t.Error("expected duration parse error")
	}
	en, _ := SpecByKey("ai.default_permission_mode")
	if err := validateValue(en, json.RawMessage(`"nope"`)); err == nil {
		t.Error("expected enum membership error")
	}
}
