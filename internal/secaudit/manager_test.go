package secaudit

import "testing"

func TestSshdVal(t *testing.T) {
	in := "permitrootlogin yes\npasswordauthentication no\n"
	if v, ok := sshdVal(in, "PermitRootLogin"); !ok || v != "yes" {
		t.Errorf("root: %q ok=%v", v, ok)
	}
	if v, ok := sshdVal(in, "passwordauthentication"); !ok || v != "no" {
		t.Errorf("pw: %q ok=%v", v, ok)
	}
	if _, ok := sshdVal(in, "nope"); ok {
		t.Error("missing key should be !ok")
	}
}

func TestBuildReport(t *testing.T) {
	sec := map[string]string{
		"SSHD":     "permitrootlogin yes\npasswordauthentication yes\n",
		"LISTEN":   "7\n",
		"SUID":     "/usr/bin/sudo\n/usr/bin/passwd\n",
		"WW":       "/etc/badfile\n",
		"FAIL2BAN": "__NOFAIL2BAN__\n",
		"LASTB":    "150\n",
		"EMPTYPW":  "ghost\n",
	}
	r := buildReport(sec)
	// danger: ssh_root(-20) + empty_pw(-20); warn: ssh_pw(-8) + world_writable(-8) + fail2ban(-8) + failed_logins(-8) = 100-40-32 = 28
	if r.Score != 28 {
		t.Errorf("score: %d", r.Score)
	}
	byID := map[string]Check{}
	for _, c := range r.Checks {
		byID[c.ID] = c
	}
	if byID["ssh_root"].Status != StatusDanger || byID["ssh_root"].Fix == "" {
		t.Errorf("ssh_root: %+v", byID["ssh_root"])
	}
	if byID["empty_pw"].Status != StatusDanger || len(byID["empty_pw"].Items) != 1 {
		t.Errorf("empty_pw: %+v", byID["empty_pw"])
	}
	if byID["suid"].Status != StatusInfo || len(byID["suid"].Items) != 2 {
		t.Errorf("suid: %+v", byID["suid"])
	}
	if byID["failed_logins"].Status != StatusWarn {
		t.Errorf("failed_logins: %+v", byID["failed_logins"])
	}
}

func TestBuildReportClean(t *testing.T) {
	sec := map[string]string{
		"SSHD":     "permitrootlogin no\npasswordauthentication no\n",
		"LISTEN":   "3\n",
		"SUID":     "/usr/bin/sudo\n",
		"WW":       "",
		"FAIL2BAN": "Status\n|- Number of jail:\t1\n",
		"LASTB":    "2\n",
		"EMPTYPW":  "",
	}
	r := buildReport(sec)
	if r.Score != 100 {
		t.Errorf("clean score should be 100, got %d", r.Score)
	}
}
