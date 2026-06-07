package systemd

import "testing"

func TestValidUnitName(t *testing.T) {
	ok := []string{"nginx.service", "ssh.service", "getty@tty1.service", "foo-bar_baz.service", "user@1000.service"}
	for _, n := range ok {
		if !validUnitName(n) {
			t.Errorf("want valid: %q", n)
		}
	}
	bad := []string{"", "nginx", "-nginx.service", "a b.service", "nginx.service; rm -rf /", "x$(id).service", "foo`whoami`.service", "a|b.service"}
	for _, n := range bad {
		if validUnitName(n) {
			t.Errorf("want invalid: %q", n)
		}
	}
}

func TestParseListUnits(t *testing.T) {
	in := "nginx.service   loaded active   running A high performance web server\n" +
		"ssh.service     loaded active   running OpenBSD Secure Shell server\n" +
		"foo.service     loaded failed   failed  Foo daemon\n"
	units := parseListUnits(in)
	if len(units) != 3 {
		t.Fatalf("want 3, got %d", len(units))
	}
	if units[0].Name != "nginx.service" || units[0].Active != "active" || units[0].Sub != "running" {
		t.Errorf("nginx: %+v", units[0])
	}
	if units[0].Description != "A high performance web server" {
		t.Errorf("desc lost: %q", units[0].Description)
	}
	if units[2].Active != "failed" {
		t.Errorf("foo: %+v", units[2])
	}
}

func TestParseListUnitsGlyph(t *testing.T) {
	// Some systemctl builds prefix failed rows with ● even under --plain.
	in := "● foo.service loaded failed failed Foo daemon\n"
	units := parseListUnits(in)
	if len(units) != 1 || units[0].Name != "foo.service" || units[0].Active != "failed" {
		t.Fatalf("got %+v", units)
	}
}

func TestParseUnitFiles(t *testing.T) {
	in := "nginx.service   enabled  enabled\n" +
		"ssh.service     enabled  enabled\n" +
		"foo.service     disabled disabled\n" +
		"bar.service     static   -\n"
	m := parseUnitFiles(in)
	if m["nginx.service"] != "enabled" || m["foo.service"] != "disabled" || m["bar.service"] != "static" {
		t.Fatalf("got %+v", m)
	}
}

func TestDetailFromShow(t *testing.T) {
	raw := parseShow("Id=nginx.service\nDescription=Nginx\nLoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=1234\nMemoryCurrent=10485760\nTasksCurrent=5\nActiveEnterTimestamp=Mon 2024-06-07 09:00:00 UTC\n")
	d := detailFromShow(raw)
	if d.Unit.Name != "nginx.service" || d.Unit.Active != "active" || d.Unit.Enabled != "enabled" {
		t.Errorf("unit: %+v", d.Unit)
	}
	if d.MainPID != 1234 || d.MemoryBytes != 10485760 || d.TasksCurrent != 5 {
		t.Errorf("metrics: pid=%d mem=%d tasks=%d", d.MainPID, d.MemoryBytes, d.TasksCurrent)
	}
	if d.ActiveSince == "" || d.Properties["Description"] != "Nginx" {
		t.Errorf("props: %+v", d.Properties)
	}
}

func TestParseCounterSentinel(t *testing.T) {
	if got := parseCounter("18446744073709551615"); got != 0 {
		t.Errorf("u64-max sentinel should be 0, got %d", got)
	}
	if got := parseCounter("[not set]"); got != 0 {
		t.Errorf("[not set] should be 0, got %d", got)
	}
	if got := parseCounter("2048"); got != 2048 {
		t.Errorf("got %d", got)
	}
}

func TestParseVersion(t *testing.T) {
	if got := parseVersion("systemd 249 (249.11-0ubuntu3.12)\n+PAM +AUDIT ...\n"); got != "249" {
		t.Errorf("got %q", got)
	}
}

func TestFilterUnits(t *testing.T) {
	units := []Unit{
		{Name: "a.service", Active: "active", Enabled: "enabled"},
		{Name: "b.service", Active: "failed", Sub: "failed", Enabled: "disabled"},
		{Name: "c.service", Active: "inactive", Enabled: "enabled"},
	}
	if got := filterUnits(units, "running"); len(got) != 1 || got[0].Name != "a.service" {
		t.Errorf("running: %+v", got)
	}
	if got := filterUnits(units, "failed"); len(got) != 1 || got[0].Name != "b.service" {
		t.Errorf("failed: %+v", got)
	}
	if got := filterUnits(units, "enabled"); len(got) != 2 {
		t.Errorf("enabled: %+v", got)
	}
	if got := filterUnits(units, ""); len(got) != 3 {
		t.Errorf("all: %+v", got)
	}
}

func TestSplitSections(t *testing.T) {
	in := "Id=nginx.service\nActiveState=active\n===JOURNAL===\nlog line 1\nlog line 2\n===END===\n"
	sec := splitSections(in)
	if !contains(sec[""], "Id=nginx.service") {
		t.Errorf("pre-marker: %q", sec[""])
	}
	if !contains(sec["JOURNAL"], "log line 1") {
		t.Errorf("journal: %q", sec["JOURNAL"])
	}
	if _, ok := sec["END"]; ok {
		t.Error("END marker should be dropped")
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
