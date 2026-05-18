package desktop

import "testing"

func TestParseRdpOptions_Empty(t *testing.T) {
	got := ParseRdpOptions("")
	if got != (RdpOptions{}) {
		t.Errorf("expected zero value, got %+v", got)
	}
}

func TestParseRdpOptions_Structured(t *testing.T) {
	raw := `{"rdp":{"security":"tls","tls_sec_level":3,"ignore_cert":false,"disable_wallpaper":true,"tcp_connect_timeout_ms":5000}}`
	got := ParseRdpOptions(raw)
	if got.Security != SecTLS {
		t.Errorf("security: got %q want tls", got.Security)
	}
	if got.TlsSecLevel == nil || *got.TlsSecLevel != 3 {
		t.Errorf("tls_sec_level: got %v want 3", got.TlsSecLevel)
	}
	if got.IgnoreCert == nil || *got.IgnoreCert != false {
		t.Errorf("ignore_cert: got %v want false", got.IgnoreCert)
	}
	if got.DisableWallpaper == nil || *got.DisableWallpaper != true {
		t.Errorf("disable_wallpaper: got %v want true", got.DisableWallpaper)
	}
	if got.TcpConnectTimeoutMS == nil || *got.TcpConnectTimeoutMS != 5000 {
		t.Errorf("tcp_connect_timeout_ms: got %v want 5000", got.TcpConnectTimeoutMS)
	}
}

func TestParseRdpOptions_LegacyFlat(t *testing.T) {
	raw := `{"security":"nla","domain":"WORKGROUP","ignore-cert":"true","keyboard":"en-us"}`
	got := ParseRdpOptions(raw)
	if got.Security != SecNLA {
		t.Errorf("security: got %q want nla", got.Security)
	}
	if got.Domain != "WORKGROUP" {
		t.Errorf("domain: got %q want WORKGROUP", got.Domain)
	}
	if got.IgnoreCert == nil || *got.IgnoreCert != true {
		t.Errorf("ignore_cert: got %v want true", got.IgnoreCert)
	}
	if got.Keyboard != "en-us" {
		t.Errorf("keyboard: got %q want en-us", got.Keyboard)
	}
}

func TestParseRdpOptions_LegacyBoolIgnoreCert(t *testing.T) {
	// Some old data has a real bool here, not a string. Accept both.
	raw := `{"security":"tls","ignore-cert":false}`
	got := ParseRdpOptions(raw)
	if got.IgnoreCert == nil || *got.IgnoreCert != false {
		t.Errorf("ignore_cert: got %v want false", got.IgnoreCert)
	}
}

func TestParseRdpOptions_Invalid(t *testing.T) {
	got := ParseRdpOptions("not json {")
	if got != (RdpOptions{}) {
		t.Errorf("expected zero value on invalid input, got %+v", got)
	}
}

func TestSecurityFlags(t *testing.T) {
	cases := []struct {
		in           RdpSecurity
		nla, tls, rdp bool
	}{
		{SecAny, true, true, true},
		{"", true, true, true},
		{SecNLA, true, false, false},
		{SecTLS, false, true, false},
		{SecRDP, false, false, true},
	}
	for _, c := range cases {
		nla, tls, rdp := RdpOptions{Security: c.in}.SecurityFlags()
		if nla != c.nla || tls != c.tls || rdp != c.rdp {
			t.Errorf("%q: got (%v,%v,%v) want (%v,%v,%v)", c.in, nla, tls, rdp, c.nla, c.tls, c.rdp)
		}
	}
}
