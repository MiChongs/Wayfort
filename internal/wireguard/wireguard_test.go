package wireguard

import (
	"encoding/base64"
	"strings"
	"testing"
)

// key32 returns a syntactically valid 44-char WireGuard key (32 bytes base64).
func key32(seed byte) string {
	b := make([]byte, 32)
	for i := range b {
		b[i] = seed + byte(i)
	}
	return base64.StdEncoding.EncodeToString(b)
}

func TestValidators(t *testing.T) {
	k := key32(1)
	if !validIface("wg0") || !validIface("wg-home") {
		t.Error("valid iface names rejected")
	}
	for _, bad := range []string{"", "wg0; rm -rf /", "this-name-is-way-too-long", "wg$(id)"} {
		if validIface(bad) {
			t.Errorf("iface %q should be invalid", bad)
		}
	}
	if !validCIDR("10.8.0.1/24") || !validCIDR("fd00::1/64") {
		t.Error("valid CIDRs rejected")
	}
	for _, bad := range []string{"10.8.0.1", "not-a-cidr", "10.8.0.0/33"} {
		if validCIDR(bad) {
			t.Errorf("CIDR %q should be invalid", bad)
		}
	}
	if !validPort(51820) || validPort(0) || validPort(70000) {
		t.Error("port validation wrong")
	}
	if !validMTU(0) || !validMTU(1420) || validMTU(900) || validMTU(1600) {
		t.Error("MTU validation wrong")
	}
	if !validWGKey(k) || validWGKey("short") || validWGKey(strings.Repeat("A", 44)+"x") {
		t.Error("WG key validation wrong")
	}
	if !validAllowedIPs([]string{"10.8.0.2/32", "192.168.1.0/24"}) || validAllowedIPs(nil) || validAllowedIPs([]string{"bad"}) {
		t.Error("allowed-ips validation wrong")
	}
	if !validEndpoint("1.2.3.4:51820") || !validEndpoint("vpn.example.com:51820") || !validEndpoint("[2001:db8::1]:51820") {
		t.Error("valid endpoints rejected")
	}
	for _, bad := range []string{"1.2.3.4", "host:notaport", "ho st:51820", "a;b:51820"} {
		if validEndpoint(bad) {
			t.Errorf("endpoint %q should be invalid", bad)
		}
	}
}

func TestParseRenderConfRoundTrip(t *testing.T) {
	priv := key32(2)
	pub := key32(3)
	psk := key32(4)
	src := strings.Join([]string{
		"[Interface]",
		"PrivateKey = " + priv,
		"Address = 10.8.0.1/24, fd00::1/64",
		"ListenPort = 51820",
		"MTU = 1420",
		"DNS = 1.1.1.1, 8.8.8.8",
		"PostUp = iptables -A FORWARD -i %i -j ACCEPT",
		"",
		"# Name = phone",
		"[Peer]",
		"PublicKey = " + pub,
		"PresharedKey = " + psk,
		"AllowedIPs = 10.8.0.2/32",
		"PersistentKeepalive = 25",
	}, "\n")

	cfg, err := parseConf("wg0", src)
	if err != nil {
		t.Fatalf("parseConf: %v", err)
	}
	if cfg.PrivateKey != priv || cfg.ListenPort != 51820 || cfg.MTU != 1420 {
		t.Fatalf("interface fields wrong: %+v", cfg)
	}
	if len(cfg.Address) != 2 || cfg.Address[0] != "10.8.0.1/24" {
		t.Fatalf("address parse wrong: %+v", cfg.Address)
	}
	if len(cfg.DNS) != 2 || len(cfg.PostUp) != 1 {
		t.Fatalf("dns/postup parse wrong: %+v", cfg)
	}
	if len(cfg.Peers) != 1 {
		t.Fatalf("expected 1 peer, got %d", len(cfg.Peers))
	}
	p := cfg.Peers[0]
	if p.PublicKey != pub || p.PresharedKey != psk || p.Comment != "phone" || p.PersistentKeepalive != 25 {
		t.Fatalf("peer fields wrong: %+v", p)
	}
	if len(p.AllowedIPs) != 1 || p.AllowedIPs[0] != "10.8.0.2/32" {
		t.Fatalf("peer allowed-ips wrong: %+v", p.AllowedIPs)
	}

	// Render then re-parse — must be stable.
	out := renderConf(cfg)
	cfg2, err := parseConf("wg0", out)
	if err != nil {
		t.Fatalf("re-parse: %v", err)
	}
	if cfg2.PrivateKey != priv || len(cfg2.Peers) != 1 || cfg2.Peers[0].Comment != "phone" {
		t.Fatalf("round trip lost data: %+v", cfg2)
	}
}

func TestParseConfRejectsGarbage(t *testing.T) {
	if _, err := parseConf("wg0", "no sections here\njust text"); err == nil {
		t.Error("expected ErrConfParse for content without [Interface]")
	}
}

func TestNextFreeIP(t *testing.T) {
	// /24 with the gateway at .1 and .2/.3 taken → expect .4.
	addr, err := nextFreeIP([]string{"10.8.0.1/24"}, []string{"10.8.0.2/32", "10.8.0.3/32"})
	if err != nil {
		t.Fatalf("nextFreeIP: %v", err)
	}
	if addr.String() != "10.8.0.4" {
		t.Fatalf("expected 10.8.0.4, got %s", addr)
	}

	// First allocation skips the gateway (.1) → .2.
	addr, err = nextFreeIP([]string{"10.8.0.1/24"}, nil)
	if err != nil {
		t.Fatalf("nextFreeIP: %v", err)
	}
	if addr.String() != "10.8.0.2" {
		t.Fatalf("expected 10.8.0.2, got %s", addr)
	}

	// A /30 (10.0.0.0/30): hosts .1(gw), .2; .3 is broadcast. With .2 taken → full.
	if _, err := nextFreeIP([]string{"10.0.0.1/30"}, []string{"10.0.0.2/32"}); err == nil {
		t.Error("expected ErrSubnetFull on exhausted /30")
	}

	// No usable address.
	if _, err := nextFreeIP(nil, nil); err == nil {
		t.Error("expected error with no interface address")
	}
}

func TestParseStatus(t *testing.T) {
	priv := key32(5)
	pub := key32(6)
	peerPub := key32(7)
	raw := strings.Join([]string{
		"===DUMP===",
		// interface line: name privkey pubkey listenport fwmark
		"wg0\t" + priv + "\t" + pub + "\t51820\toff",
		// peer line: name pubkey psk endpoint allowed handshake rx tx keepalive
		"wg0\t" + peerPub + "\t(none)\t1.2.3.4:51820\t10.8.0.2/32\t1700000000\t1024\t2048\t25",
		"===CONF===",
		"@@FILE@@ /etc/wireguard/wg0.conf",
		"[Interface]",
		"PrivateKey = " + priv,
		"Address = 10.8.0.1/24",
		"MTU = 1420",
		"DNS = 1.1.1.1",
		"@@ENDFILE@@",
		"@@FILE@@ /etc/wireguard/wg1.conf",
		"[Interface]",
		"PrivateKey = " + key32(8),
		"Address = 10.9.0.1/24",
		"@@ENDFILE@@",
		"===ENABLED===",
		"wg0 enabled",
		"wg1 disabled",
		"===MOD===",
		"loaded",
		"===END===",
	}, "\n")

	st := parseStatus(raw)
	if !st.Installed || !st.KernelMod || !st.Available {
		t.Fatalf("status flags wrong: %+v", st)
	}
	if len(st.Ifaces) != 2 {
		t.Fatalf("expected 2 interfaces (1 up + 1 conf-only), got %d", len(st.Ifaces))
	}
	var wg0, wg1 *Iface
	for i := range st.Ifaces {
		switch st.Ifaces[i].Name {
		case "wg0":
			wg0 = &st.Ifaces[i]
		case "wg1":
			wg1 = &st.Ifaces[i]
		}
	}
	if wg0 == nil || !wg0.Up || !wg0.HasConf || !wg0.Autostart {
		t.Fatalf("wg0 wrong: %+v", wg0)
	}
	if len(wg0.Addresses) != 1 || wg0.Addresses[0] != "10.8.0.1/24" || wg0.MTU != 1420 {
		t.Fatalf("wg0 conf metadata not merged: %+v", wg0)
	}
	if len(wg0.Peers) != 1 || wg0.Peers[0].TransferRx != 1024 {
		t.Fatalf("wg0 peers wrong: %+v", wg0.Peers)
	}
	if wg1 == nil || wg1.Up || !wg1.HasConf || wg1.Autostart {
		t.Fatalf("wg1 (conf-only, disabled) wrong: %+v", wg1)
	}
}

func TestParseStatusNoWG(t *testing.T) {
	st := parseStatus("__NO_WG__")
	if st.Installed || st.Available {
		t.Fatalf("expected not installed: %+v", st)
	}
}

func TestParseProbe(t *testing.T) {
	out := strings.Join([]string{
		"OS=ubuntu",
		"WG=1",
		"WGQ=1",
		"PM=apt-get",
		"SUDO=1",
		"MOD=loaded",
		"KVER=6.1.0",
	}, "\n")
	p := parseProbe(out)
	if p.OSID != "ubuntu" || !p.Installed || !p.WGQuick || p.PkgManager != "apt-get" || !p.CanSudo || p.KernelMod != "loaded" || p.Kernel != "6.1.0" {
		t.Fatalf("probe parse wrong: %+v", p)
	}
}

func TestMaskSecrets(t *testing.T) {
	in := "PrivateKey = " + key32(9) + "\nAddress = 10.8.0.1/24\nPresharedKey = " + key32(10)
	out := maskSecrets(in)
	if strings.Contains(out, key32(9)) || strings.Contains(out, key32(10)) {
		t.Fatalf("secrets not masked: %s", out)
	}
	if !strings.Contains(out, "Address = 10.8.0.1/24") {
		t.Fatalf("non-secret line lost: %s", out)
	}
}
