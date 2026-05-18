package firewall

import "testing"

func TestDetectTool(t *testing.T) {
	cases := []struct {
		probe string
		want  Tool
	}{
		{"ufw=/usr/sbin/ufw\nfirewalld=\nnft=\niptables=/sbin/iptables\nip6tables=\n", ToolUFW},
		{"ufw=\nfirewalld=/usr/bin/firewall-cmd\nnft=\niptables=/sbin/iptables\nip6tables=\n", ToolFirewalld},
		// nft beats iptables when both are present.
		{"ufw=\nfirewalld=\nnft=/usr/sbin/nft\niptables=/sbin/iptables\nip6tables=\n", ToolNftables},
		{"ufw=\nfirewalld=\nnft=\niptables=/sbin/iptables\nip6tables=\n", ToolIPTables},
		{"ufw=\nfirewalld=\nnft=\niptables=\nip6tables=\n", ToolUnsupported},
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
	status, rules := parseIPTablesList(out, "INPUT", FamilyV4)
	if status.Policy != "DROP" {
		t.Errorf("policy = %q", status.Policy)
	}
	if len(rules) != 3 {
		t.Fatalf("rules = %d; want 3", len(rules))
	}
	if rules[0].Port != "22" || rules[0].Chain != "INPUT" || rules[0].Family != FamilyV4 {
		t.Errorf("rule 1: %+v", rules[0])
	}
	if rules[1].Protocol != "any" {
		t.Errorf("rule 2 protocol = %q", rules[1].Protocol)
	}
	if rules[2].Port != "8000:9000" {
		t.Errorf("rule 3 port = %q", rules[2].Port)
	}
}

func TestParseIPTablesList_OutputChain(t *testing.T) {
	out := `Chain OUTPUT (policy ACCEPT 100 packets, 12K bytes)
num   pkts bytes target     prot opt in   out  source       destination
1      10   500 ACCEPT     tcp  --  *    *    0.0.0.0/0    0.0.0.0/0    tcp dpt:443
`
	status, rules := parseIPTablesList(out, "OUTPUT", FamilyV4)
	if status.Policy != "" {
		// Policy is only stamped for INPUT.
		t.Errorf("policy should be empty for OUTPUT chain, got %q", status.Policy)
	}
	if len(rules) != 1 {
		t.Fatalf("rules = %d; want 1", len(rules))
	}
	if rules[0].Direction != "out" {
		t.Errorf("expected direction=out for OUTPUT chain, got %q", rules[0].Direction)
	}
	if rules[0].Chain != "OUTPUT" {
		t.Errorf("chain = %q", rules[0].Chain)
	}
}

func TestParseNftables(t *testing.T) {
	// A minimal-but-realistic ruleset response. Contains a table, a chain,
	// and three rules: ALLOW tcp/22, DROP from 10.0.0.0/8, REJECT inbound
	// IPv6 ssh.
	out := `{
  "nftables": [
    {"metainfo": {"version": "1.0.6", "release_name": "Lester Gooch #5", "json_schema_version": 1}},
    {"table": {"family": "inet", "name": "filter", "handle": 1}},
    {"chain": {"family": "inet", "table": "filter", "name": "input", "handle": 1, "type": "filter", "hook": "input", "prio": 0, "policy": "accept"}},
    {"rule": {"family": "inet", "table": "filter", "chain": "input", "handle": 4,
      "expr": [
        {"match": {"op": "==", "left": {"payload": {"protocol": "tcp", "field": "dport"}}, "right": 22}},
        {"accept": null}
      ]}},
    {"rule": {"family": "inet", "table": "filter", "chain": "input", "handle": 5,
      "expr": [
        {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}}, "right": "10.0.0.0/8"}},
        {"drop": null}
      ]}},
    {"rule": {"family": "ip6", "table": "filter", "chain": "input", "handle": 6,
      "expr": [
        {"match": {"op": "==", "left": {"payload": {"protocol": "tcp", "field": "dport"}}, "right": 22}},
        {"reject": {}}
      ]}}
  ]
}`
	status, rules, err := parseNftables(out)
	if err != nil {
		t.Fatalf("parseNftables: %v", err)
	}
	if status.Tool != ToolNftables {
		t.Errorf("Tool = %q", status.Tool)
	}
	if len(rules) != 3 {
		t.Fatalf("rules = %d; want 3", len(rules))
	}
	if rules[0].Port != "22" || rules[0].Action != "ALLOW" || rules[0].Protocol != "tcp" {
		t.Errorf("rule 0: %+v", rules[0])
	}
	if rules[0].Index != 4 {
		t.Errorf("rule 0 handle = %d; want 4", rules[0].Index)
	}
	if rules[1].Source != "10.0.0.0/8" || rules[1].Action != "DENY" {
		t.Errorf("rule 1: %+v", rules[1])
	}
	if rules[2].Family != FamilyV6 || rules[2].Action != "REJECT" {
		t.Errorf("rule 2: %+v", rules[2])
	}
}

func TestParseNftables_Malformed(t *testing.T) {
	_, _, err := parseNftables("not json at all")
	if err == nil {
		t.Error("expected error on malformed json")
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
	if got := buildNftablesAdd(spec); got == "" {
		t.Error("nft add empty")
	}
}

func TestBuildNftablesAdd(t *testing.T) {
	got := buildNftablesAdd(RuleSpec{Action: "ALLOW", Port: "22", Protocol: "tcp"})
	want := "nft add rule inet filter input tcp dport 22 accept"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
	got2 := buildNftablesAdd(RuleSpec{Action: "DENY", Port: "80", Protocol: "tcp", Source: "10.0.0.0/8"})
	want2 := "nft add rule inet filter input ip saddr 10.0.0.0/8 tcp dport 80 drop"
	if got2 != want2 {
		t.Errorf("got %q want %q", got2, want2)
	}
}

func TestBuildDelete(t *testing.T) {
	if got := buildDelete(ToolUFW, 3); got != "ufw --force delete 3" {
		t.Errorf("ufw del: %q", got)
	}
	if got := buildDelete(ToolIPTables, 5); got != "iptables -D INPUT 5" {
		t.Errorf("iptables del: %q", got)
	}
	if got := buildDelete(ToolNftables, 4); got != "nft delete rule inet filter input handle 4" {
		t.Errorf("nft del: %q", got)
	}
	if got := buildDelete(ToolFirewalld, 1); got != "" {
		t.Errorf("firewalld del should be empty: %q", got)
	}
}
