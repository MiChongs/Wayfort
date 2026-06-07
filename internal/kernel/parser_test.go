package kernel

import "testing"

func TestParseSysctl(t *testing.T) {
	in := "net.ipv4.ip_forward = 1\nvm.swappiness = 60\nkernel.hostname = web01\n"
	s := parseSysctl(in)
	if len(s) != 3 || s[0].Key != "net.ipv4.ip_forward" || s[0].Value != "1" || s[1].Value != "60" {
		t.Fatalf("got %+v", s)
	}
}

func TestParseLsmod(t *testing.T) {
	in := "Module                  Size  Used by\noverlay               151552  18\nbridge                307200  1 br_netfilter\n"
	mods := parseLsmod(in)
	if len(mods) != 2 {
		t.Fatalf("want 2, got %d", len(mods))
	}
	if mods[0].Name != "overlay" || mods[0].SizeKb != 151552/1024 {
		t.Errorf("overlay: %+v", mods[0])
	}
	if mods[1].Name != "bridge" || mods[1].UsedBy != "br_netfilter" {
		t.Errorf("bridge: %+v", mods[1])
	}
}

func TestValidKeyValue(t *testing.T) {
	if !validKey("net.ipv4.tcp_syncookies") || !validValue("1") || !validValue("4096 87380 6291456") {
		t.Error("want valid")
	}
	for _, k := range []string{"", "net.ipv4; rm -rf /", "a$(id)"} {
		if validKey(k) {
			t.Errorf("key want invalid: %q", k)
		}
	}
	for _, v := range []string{"", "1;reboot", "$(whoami)", "a|b"} {
		if validValue(v) {
			t.Errorf("value want invalid: %q", v)
		}
	}
}

func TestParseHost(t *testing.T) {
	h, k, tz := parseHost("web01\nLinux 5.15.0\nAsia/Shanghai\n")
	if h != "web01" || k != "Linux 5.15.0" || tz != "Asia/Shanghai" {
		t.Fatalf("got %q %q %q", h, k, tz)
	}
}
