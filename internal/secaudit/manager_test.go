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

func TestParseHarden(t *testing.T) {
	m := parseHarden("randomize_va_space=2\ntcp_syncookies=1\nrp_filter=0\n")
	if m["randomize_va_space"] != "2" || m["tcp_syncookies"] != "1" || m["rp_filter"] != "0" {
		t.Fatalf("got %+v", m)
	}
}

func byID(r Report) map[string]Check {
	m := map[string]Check{}
	for _, c := range r.Checks {
		m[c.id()] = c
	}
	return m
}

// id() small helper so the test reads cleanly.
func (c Check) id() string { return c.ID }

func TestBuildReportFindings(t *testing.T) {
	sec := map[string]string{
		"SSHD":     "permitrootlogin yes\npasswordauthentication yes\npermitemptypasswords yes\n",
		"LISTEN":   "7\n",
		"SUID":     "/usr/bin/sudo\n/usr/bin/passwd\n",
		"WW":       "/etc/badfile\n",
		"FAIL2BAN": "__NOFAIL2BAN__\n",
		"LASTB":    "150\n",
		"EMPTYPW":  "ghost\n",
		"UID0":     "root\ntoor\n",
		"SELINUX":  "Disabled\n",
		"HARDEN":   "randomize_va_space=0\ntcp_syncookies=0\nrp_filter=0\n",
		"REBOOT":   "__REBOOT_REQUIRED__\n",
		"PASSPOLICY": "PASS_MAX_DAYS 99999\n",
		"UNATTENDED": "",
	}
	r := buildReport(sec)
	m := byID(r)
	if m["ssh_root"].Status != StatusDanger || !m["ssh_root"].Applicable {
		t.Errorf("ssh_root: %+v", m["ssh_root"])
	}
	if m["ssh_emptypw"].Status != StatusDanger {
		t.Errorf("ssh_emptypw: %+v", m["ssh_emptypw"])
	}
	if m["uid0"].Status != StatusDanger || len(m["uid0"].Items) != 2 {
		t.Errorf("uid0: %+v", m["uid0"])
	}
	if m["harden"].Status != StatusWarn || !m["harden"].Applicable {
		t.Errorf("harden: %+v", m["harden"])
	}
	if m["mac"].Status != StatusWarn {
		t.Errorf("mac: %+v", m["mac"])
	}
	if m["reboot"].Status != StatusWarn {
		t.Errorf("reboot: %+v", m["reboot"])
	}
	if m["unattended"].Status != StatusWarn || !m["unattended"].Applicable {
		t.Errorf("unattended: %+v", m["unattended"])
	}
	if r.Score >= 50 {
		t.Errorf("a node this bad should score low, got %d", r.Score)
	}
	// Applicable checks must have a server-side fix command.
	for _, id := range []string{"ssh_root", "ssh_pw", "fail2ban", "harden", "unattended"} {
		if _, ok := fixCommands[id]; !ok {
			t.Errorf("missing fixCommand for %s", id)
		}
	}
}

func TestBuildReportClean(t *testing.T) {
	sec := map[string]string{
		"SSHD":       "permitrootlogin no\npasswordauthentication no\npermitemptypasswords no\n",
		"LISTEN":     "3\n",
		"SUID":       "/usr/bin/sudo\n",
		"WW":         "",
		"FAIL2BAN":   "Status\n|- Number of jail:\t1\n",
		"LASTB":      "2\n",
		"EMPTYPW":    "",
		"UID0":       "root\n",
		"SELINUX":    "Enforcing\n",
		"HARDEN":     "randomize_va_space=2\ntcp_syncookies=1\nrp_filter=1\n",
		"REBOOT":     "needsrestart_rc=0\n",
		"PASSPOLICY": "PASS_MAX_DAYS 90\n",
		"UNATTENDED": "__UNATTENDED_ON__\n",
	}
	r := buildReport(sec)
	if r.Score != 100 {
		for _, c := range r.Checks {
			if c.Status == StatusWarn || c.Status == StatusDanger {
				t.Logf("non-clean: %s = %s (%s)", c.ID, c.Status, c.Detail)
			}
		}
		t.Errorf("clean score should be 100, got %d", r.Score)
	}
}
