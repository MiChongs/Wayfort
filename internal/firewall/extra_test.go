package firewall

import "testing"

func TestValidators(t *testing.T) {
	if !validProto("tcp") || !validProto("any") || validProto("bogus") {
		t.Error("proto validation wrong")
	}
	if !validPortSpec("22") || !validPortSpec("80,443") || !validPortSpec("8000:9000") || validPortSpec("0") || validPortSpec("70000") || validPortSpec("a") {
		t.Error("port spec validation wrong")
	}
	if !validSource("") || !validSource("any") || !validSource("10.0.0.0/8") || !validSource("1.2.3.4") || validSource("not-an-ip") || validSource("1.2.3.4; rm -rf /") {
		t.Error("source validation wrong")
	}
	if !validIdent("sshd") || !validIdent("nginx-http-auth") || validIdent("a b") || validIdent("a;b") {
		t.Error("ident validation wrong")
	}
	s := RuleSpec{Action: "allow", Port: "22"}
	if err := sanitizeSpec(&s); err != nil || s.Action != "ALLOW" || s.Direction != "in" || s.Protocol != "tcp" {
		t.Fatalf("sanitizeSpec wrong: %+v err=%v", s, err)
	}
	bad := RuleSpec{Action: "allow", Protocol: "tcp", Port: ""}
	if err := sanitizeSpec(&bad); err == nil {
		t.Error("tcp without port should be rejected")
	}
}

func TestParseCount(t *testing.T) {
	cases := map[string]int64{"0": 0, "123": 123, "1K": 1000, "2M": 2000000, "1500": 1500}
	for in, want := range cases {
		if got := parseCount(in); got != want {
			t.Errorf("parseCount(%q)=%d want %d", in, got, want)
		}
	}
}

func TestParseDportCounters(t *testing.T) {
	out := `Chain INPUT (policy ACCEPT)
 12 720 ACCEPT tcp -- * * 0.0.0.0/0 0.0.0.0/0 tcp dpt:22
 3 180 ACCEPT tcp -- * * 0.0.0.0/0 0.0.0.0/0 tcp dpt:443`
	m := parseDportCounters(out)
	if m["22"][0] != 12 || m["22"][1] != 720 || m["443"][0] != 3 {
		t.Fatalf("dport counters wrong: %+v", m)
	}
}

func TestParseConntrack(t *testing.T) {
	out := `tcp 6 431999 ESTABLISHED src=10.0.0.2 dst=1.1.1.1 sport=51000 dport=443 packets=10 bytes=2048 [ASSURED]
ipv4 2 udp 17 29 src=10.0.0.2 dst=8.8.8.8 sport=33333 dport=53 packets=2 bytes=120`
	snap := parseConntrack(out, 100)
	if snap.Total != 2 || len(snap.Connections) != 2 {
		t.Fatalf("expected 2 conns, got %d", snap.Total)
	}
	c0 := snap.Connections[0]
	if c0.Proto != "tcp" || c0.DPort != 443 || c0.State != "ESTABLISHED" || c0.Bytes != 2048 {
		t.Fatalf("conn0 wrong: %+v", c0)
	}
	if snap.Connections[1].Proto != "udp" || snap.Connections[1].DPort != 53 {
		t.Fatalf("conn1 wrong: %+v", snap.Connections[1])
	}
}

func TestParseConntrackTruncate(t *testing.T) {
	out := "tcp 6 1 ESTABLISHED src=1.1.1.1 dst=2.2.2.2 sport=1 dport=2\n" +
		"tcp 6 1 ESTABLISHED src=3.3.3.3 dst=4.4.4.4 sport=3 dport=4"
	snap := parseConntrack(out, 1)
	if snap.Total != 2 || len(snap.Connections) != 1 || !snap.Truncated {
		t.Fatalf("truncate wrong: total=%d len=%d trunc=%v", snap.Total, len(snap.Connections), snap.Truncated)
	}
}

func TestParseF2B(t *testing.T) {
	out := `ACTIVE=active
Status
|- Number of jail: 1
` + "`- Jail list:\tsshd" + `
===JAILS===
@@JAIL@@ sshd
Status for the jail: sshd
|- Filter
|  |- Currently failed: 1
|  ` + "`- Total failed:\t5" + `
` + "`- Actions" + `
   |- Currently banned: 2
   |- Total banned: 7
   ` + "`- Banned IP list:\t1.2.3.4 5.6.7.8"
	st := &F2BStatus{}
	parseF2B(out, st)
	if !st.Running || len(st.Jails) != 1 {
		t.Fatalf("f2b parse wrong: running=%v jails=%d", st.Running, len(st.Jails))
	}
	j := st.Jails[0]
	if j.Name != "sshd" || j.Banned != 2 || j.Total != 7 || len(j.BannedIPs) != 2 {
		t.Fatalf("jail parse wrong: %+v", j)
	}
}

func TestExposureVerdict(t *testing.T) {
	rules := []Rule{
		{Index: 1, Action: "ALLOW", Direction: "in", Port: "22", Source: ""},
		{Index: 2, Action: "ALLOW", Direction: "in", Port: "5432", Source: "10.0.0.0/8"},
	}
	// 22 open from anywhere
	if v, _, _ := verdictForPort(listener{addr: "0.0.0.0", port: 22}, rules, true); v != ExposureOpen {
		t.Errorf("port 22 want open, got %s", v)
	}
	// 5432 restricted
	v, from, _ := verdictForPort(listener{addr: "0.0.0.0", port: 5432}, rules, true)
	if v != ExposureRestricted || len(from) != 1 {
		t.Errorf("port 5432 want restricted, got %s from %v", v, from)
	}
	// 9999 not matched, default deny → blocked
	if v, _, _ := verdictForPort(listener{addr: "0.0.0.0", port: 9999}, rules, true); v != ExposureBlocked {
		t.Errorf("port 9999 want blocked, got %s", v)
	}
	// loopback → local
	if v, _, _ := verdictForPort(listener{addr: "127.0.0.1", port: 8080}, rules, true); v != ExposureLocal {
		t.Errorf("loopback want local, got %s", v)
	}
	// default-allow + no rule → open
	if v, _, _ := verdictForPort(listener{addr: "0.0.0.0", port: 9999}, rules, false); v != ExposureOpen {
		t.Errorf("default-allow want open, got %s", v)
	}
}

func TestParseSS(t *testing.T) {
	out := `LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=789,fd=3))
LISTEN 0 128 127.0.0.1:6379 0.0.0.0:* users:(("redis-server",pid=321,fd=6))
@@UDP@@
UNCONN 0 0 0.0.0.0:53 0.0.0.0:* users:(("dnsmasq",pid=111,fd=4))`
	ls := parseSS(out)
	if len(ls) != 3 {
		t.Fatalf("expected 3 listeners, got %d", len(ls))
	}
	if ls[0].port != 22 || ls[0].process != "sshd" || ls[0].pid != 789 {
		t.Fatalf("listener0 wrong: %+v", ls[0])
	}
	if ls[2].proto != "udp" || ls[2].port != 53 {
		t.Fatalf("listener2 wrong: %+v", ls[2])
	}
}

func TestParseFWProbe(t *testing.T) {
	out := "OS=ubuntu\nPM=apt-get\nUFW=1\nNFT=1\nIPT=1\nFWD=0\nF2B=0\nCT=1\nSUDO=1"
	p := parseFWProbe(out)
	if p.OSID != "ubuntu" || p.PkgManager != "apt-get" || !p.HasUFW || !p.HasNft || p.HasFirewalld || !p.HasConntrack || !p.CanSudo {
		t.Fatalf("probe parse wrong: %+v", p)
	}
}
