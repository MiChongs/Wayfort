package logs

import "testing"

func TestValidUnit(t *testing.T) {
	for _, s := range []string{"nginx.service", "ssh", "getty@tty1.service"} {
		if !validUnit(s) {
			t.Errorf("want valid: %q", s)
		}
	}
	for _, s := range []string{"", "-x", "a b", "x;rm", "a|b", "$(id)"} {
		if validUnit(s) {
			t.Errorf("want invalid: %q", s)
		}
	}
}

func TestValidPath(t *testing.T) {
	for _, s := range []string{"/var/log/syslog", "/var/log/nginx/access.log"} {
		if !validPath(s) {
			t.Errorf("want valid: %q", s)
		}
	}
	for _, s := range []string{"", "var/log/x", "/var/log/../etc/passwd", "/var/log/x;rm", "/var/log/x y"} {
		if validPath(s) {
			t.Errorf("want invalid: %q", s)
		}
	}
}

func TestBuildCmd(t *testing.T) {
	c, err := buildCmd("journal", "nginx.service", 100, false)
	if err != nil || c != "journalctl -u 'nginx.service' -n 100 --no-hostname 2>&1" {
		t.Fatalf("journal tail: %q err=%v", c, err)
	}
	c, _ = buildCmd("journal", "nginx.service", 100, true)
	if c != "journalctl -u 'nginx.service' -n 100 -f --no-hostname 2>&1" {
		t.Errorf("journal follow: %q", c)
	}
	c, _ = buildCmd("file", "/var/log/syslog", 50, false)
	if c != "tail -n 50 '/var/log/syslog' 2>&1" {
		t.Errorf("file tail: %q", c)
	}
	c, _ = buildCmd("file", "/var/log/syslog", 50, true)
	if c != "tail -F -n 50 '/var/log/syslog' 2>&1" {
		t.Errorf("file follow: %q", c)
	}
	if _, err := buildCmd("journal", "bad unit;rm", 10, false); err == nil {
		t.Error("expected bad ref")
	}
	if _, err := buildCmd("nope", "x", 10, false); err == nil {
		t.Error("expected bad source")
	}
}

func TestParseFileList(t *testing.T) {
	in := "__HASJOURNAL__\n===FILES===\n/var/log/syslog|2048|2026-06-08 10:00:00\n/var/log/auth.log|512|2026-06-08 09:00:00\n===END===\n"
	hasJournal, files := parseFileList(in)
	if !hasJournal {
		t.Error("want journal")
	}
	if len(files) != 2 || files[0].Path != "/var/log/syslog" || files[0].SizeKb != 2 {
		t.Fatalf("files: %+v", files)
	}
	if files[1].Modified != "2026-06-08 09:00:00" {
		t.Errorf("mtime: %q", files[1].Modified)
	}
}
