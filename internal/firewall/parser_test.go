package firewall

import "testing"

func TestDetectTool(t *testing.T) {
	cases := []struct {
		probe string
		want  Tool
	}{
		{"ufw=/usr/sbin/ufw\nfirewalld=\niptables=/sbin/iptables\n", ToolUFW},
		{"ufw=\nfirewalld=/usr/bin/firewall-cmd\niptables=/sbin/iptables\n", ToolFirewalld},
		{"ufw=\nfirewalld=\niptables=/sbin/iptables\n", ToolIPTables},
		{"ufw=\nfirewalld=\niptables=\n", ToolUnsupported},
		{"", ToolUnsupported},
	}
	for _, c := range cases {
		got := detectTool(c.probe)
		if got != c.want {
			t.Errorf("detectTool(%q) = %q, want %q", c.probe, got, c.want)
		}
	}
}

func TestParseUFWStatus(t *testing.T) {
	out := `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
80,443/tcp                 ALLOW IN    Anywhere
3389/tcp                   DENY  IN    10.0.0.0/8
`
	status, rules := parseUFWStatus(out)
	if !status.Active {
		t.Error("expected active")
	}
	if status.Tool != ToolUFW {
		t.Errorf("Tool = %q", status.Tool)
	}
	if status.Policy == "" {
		t.Error("policy not parsed")
	}
	if len(rules) != 3 {
		t.Fatalf("rules = %d; want 3", len(rules))
	}
	if rules[0].Port != "22" || rules[0].Protocol != "tcp" || rules[0].Action != "ALLOW" {
		t.Errorf("first rule: %+v", rules[0])
	}
	if rules[2].Source != "10.0.0.0/8" || rules[2].Action != "DENY" {
		t.Errorf("third rule: %+v", rules[2])
	}
}

func TestParseIPTablesList(t *testing.T) {
	out := `Chain INPUT (policy DROP 0 packets, 0 bytes)
num   pkts bytes target     prot opt in   out  source       destination
1      12   720 ACCEPT     tcp  --  *    *    0.0.0.0/0    0.0.0.0/0    tcp dpt:22
2       0     0 DROP       all  --  *    *    10.0.0.0/8   0.0.0.0/0
3       5   240 ACCEPT     tcp  --  *    *    0.0.0.0/0    0.0.0.0/0    tcp dpts:8000:9000
`
	status, rules := parseIPTablesList(out)
	if status.Policy != "DROP" {
		t.Errorf("policy = %q", status.Policy)
	}
	if len(rules) != 3 {
		t.Fatalf("rules = %d; want 3", len(rules))
	}
	if rules[0].Port != "22" {
		t.Errorf("rule 1 port = %q", rules[0].Port)
	}
	if rules[1].Protocol != "any" {
		t.Errorf("rule 2 protocol = %q", rules[1].Protocol)
	}
	if rules[2].Port != "8000:9000" {
		t.Errorf("rule 3 port = %q", rules[2].Port)
	}
}

func TestBuildAddCommands(t *testing.T) {
	spec := RuleSpec{Action: "ALLOW", Port: "22", Protocol: "tcp", Source: "10.0.0.0/8"}
	if got := buildUFWAdd(spec); got != "ufw allow in proto tcp from 10.0.0.0/8 to any port 22" {
		t.Errorf("ufw add: %q", got)
	}
	if got := buildIPTablesAdd(spec); got == "" {
		t.Error("iptables add empty")
	}
	if got := buildFirewalldAdd(spec); got == "" {
		t.Error("firewalld add empty")
	}
}
