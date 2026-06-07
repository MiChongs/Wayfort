package nettools

import "testing"

func TestParseAddr(t *testing.T) {
	in := `[{"ifname":"eth0","address":"aa:bb:cc:dd:ee:ff","operstate":"UP","mtu":1500,"addr_info":[{"family":"inet","local":"10.0.0.5"},{"family":"inet6","local":"fe80::1"}]}]`
	ifs := parseAddr(in)
	if len(ifs) != 1 || ifs[0].Name != "eth0" || ifs[0].State != "UP" || ifs[0].MTU != 1500 {
		t.Fatalf("iface: %+v", ifs)
	}
	if len(ifs[0].IPv4) != 1 || ifs[0].IPv4[0] != "10.0.0.5" || ifs[0].IPv6[0] != "fe80::1" {
		t.Errorf("addrs: %+v", ifs[0])
	}
}

func TestParseRoute(t *testing.T) {
	in := `[{"dst":"default","gateway":"10.0.0.1","dev":"eth0","protocol":"dhcp"},{"dst":"10.0.0.0/24","dev":"eth0","prefsrc":"10.0.0.5"}]`
	r := parseRoute(in)
	if len(r) != 2 || r[0].Dst != "default" || r[0].Via != "10.0.0.1" || r[1].Src != "10.0.0.5" {
		t.Fatalf("got %+v", r)
	}
}

func TestParseSS(t *testing.T) {
	in := `tcp ESTAB 0 0 10.0.0.5:22 10.0.0.9:51000 users:(("sshd",pid=1,fd=3))
tcp LISTEN 0 128 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=9,fd=6))`
	c := parseSS(in)
	if len(c) != 2 || c[0].State != "ESTAB" || c[0].Process != "sshd" || c[1].Local != "0.0.0.0:80" || c[1].Process != "nginx" {
		t.Fatalf("got %+v", c)
	}
}

func TestDiagCommand(t *testing.T) {
	if c, err := diagCommand(ToolPing, "example.com"); err != nil || c != "ping -c 4 -W 2 'example.com' 2>&1" {
		t.Errorf("ping: %q err=%v", c, err)
	}
	if c, err := diagCommand(ToolCurl, "https://example.com/health"); err != nil || c != "curl -sS -I --max-time 10 'https://example.com/health' 2>&1" {
		t.Errorf("curl: %q err=%v", c, err)
	}
	if _, err := diagCommand(ToolPing, "bad target; rm -rf /"); err == nil {
		t.Error("ping bad target should error")
	}
	if _, err := diagCommand(ToolCurl, "ftp://x"); err == nil {
		t.Error("curl non-http should error")
	}
	if _, err := diagCommand("nope", "x"); err == nil {
		t.Error("bad tool should error")
	}
}

func TestValidIface(t *testing.T) {
	if !validIface("eth0") || !validIface("br-abc123") {
		t.Error("want valid")
	}
	for _, s := range []string{"", "eth0;rm", "a b", "$(x)"} {
		if validIface(s) {
			t.Errorf("want invalid: %q", s)
		}
	}
}
