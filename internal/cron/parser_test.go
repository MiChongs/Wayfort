package cron

import "testing"

func TestParseUserCron(t *testing.T) {
	in := "# a comment\n0 3 * * * /usr/bin/backup.sh --full\n@reboot /opt/start.sh\n\n*/5 * * * * echo hi\n"
	e := parseUserCron(in)
	if len(e) != 3 {
		t.Fatalf("want 3, got %d (%+v)", len(e), e)
	}
	if e[0].Schedule != "0 3 * * *" || e[0].Command != "/usr/bin/backup.sh --full" {
		t.Errorf("e0: %+v", e[0])
	}
	if e[1].Schedule != "@reboot" || e[1].Command != "/opt/start.sh" {
		t.Errorf("e1: %+v", e[1])
	}
	// Index is the 1-based original line number (comment line 1 skipped → backup is line 2).
	if e[0].Index != 2 {
		t.Errorf("index: %d", e[0].Index)
	}
}

func TestParseTimers(t *testing.T) {
	in := "Mon 2026-06-08 00:00 UTC 5h left  Sun 2026-06-07 logrotate.timer logrotate.service\n" +
		"n/a  n/a  apt-daily.timer apt-daily.service\n"
	ts := parseTimers(in)
	if len(ts) != 2 || ts[0].Unit != "logrotate.timer" || ts[0].Activates != "logrotate.service" {
		t.Fatalf("got %+v", ts)
	}
}

func TestValidEntryTimer(t *testing.T) {
	if !validEntry("0 3 * * * /usr/bin/backup.sh") || !validTimer("logrotate.timer") {
		t.Error("want valid")
	}
	if validEntry("") || validEntry("# comment") || validEntry("0 3 * * * x\nrm -rf /") {
		t.Error("entry want invalid")
	}
	for _, x := range []string{"", "logrotate", "logrotate.service", "x;rm.timer"} {
		if validTimer(x) {
			t.Errorf("timer want invalid: %q", x)
		}
	}
}
