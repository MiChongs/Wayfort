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

func TestResolveNetworkPreset_Empty(t *testing.T) {
	// No preset → unchanged.
	in := RdpOptions{Security: SecTLS}
	if got := in.ResolveNetworkPreset(); got != in {
		t.Errorf("empty preset should be a no-op, got %+v", got)
	}
	// Unknown preset → unchanged (but keeps the preset string).
	in = RdpOptions{NetworkPreset: "bogus"}
	if got := in.ResolveNetworkPreset(); got != in {
		t.Errorf("unknown preset should be a no-op, got %+v", got)
	}
}

func TestResolveNetworkPreset_WAN(t *testing.T) {
	got := RdpOptions{NetworkPreset: "wan"}.ResolveNetworkPreset()
	if got.ConnectionTypeOrDefault() != ConnTypeWAN {
		t.Errorf("connection_type: got %d want %d (WAN)", got.ConnectionTypeOrDefault(), ConnTypeWAN)
	}
	if got.ColorDepth == nil || *got.ColorDepth != 16 {
		t.Errorf("color_depth: got %v want 16", got.ColorDepth)
	}
	if got.BulkCompression == nil || !*got.BulkCompression {
		t.Errorf("bulk_compression: got %v want true", got.BulkCompression)
	}
	if got.DisableWallpaper == nil || !*got.DisableWallpaper {
		t.Errorf("disable_wallpaper: got %v want true", got.DisableWallpaper)
	}
	if got.AllowDesktopComposition == nil || *got.AllowDesktopComposition {
		t.Errorf("desktop_composition: got %v want false", got.AllowDesktopComposition)
	}
}

func TestResolveNetworkPreset_LAN(t *testing.T) {
	got := RdpOptions{NetworkPreset: "lan"}.ResolveNetworkPreset()
	if got.ConnectionTypeOrDefault() != ConnTypeLAN {
		t.Errorf("connection_type: got %d want %d (LAN)", got.ConnectionTypeOrDefault(), ConnTypeLAN)
	}
	if got.ColorDepth == nil || *got.ColorDepth != 32 {
		t.Errorf("color_depth: got %v want 32", got.ColorDepth)
	}
	if got.BulkCompression == nil || *got.BulkCompression {
		t.Errorf("bulk_compression: got %v want false", got.BulkCompression)
	}
	// Full visuals on a fast link.
	if got.DisableWallpaper == nil || *got.DisableWallpaper {
		t.Errorf("disable_wallpaper: got %v want false", got.DisableWallpaper)
	}
}

func TestResolveNetworkPreset_ExplicitOverrideWins(t *testing.T) {
	// Operator picked "wan" (which would default to 16bpp) but explicitly set
	// 32bpp and forced wallpaper on — both explicit choices must survive.
	cd := uint8(32)
	got := RdpOptions{
		NetworkPreset:    "wan",
		ColorDepth:       &cd,
		DisableWallpaper: boolPtr(false),
	}.ResolveNetworkPreset()
	if got.ColorDepth == nil || *got.ColorDepth != 32 {
		t.Errorf("explicit color_depth lost: got %v want 32", got.ColorDepth)
	}
	if got.DisableWallpaper == nil || *got.DisableWallpaper {
		t.Errorf("explicit disable_wallpaper=false lost: got %v", got.DisableWallpaper)
	}
	// Fields the operator left unset still come from the preset.
	if got.BulkCompression == nil || !*got.BulkCompression {
		t.Errorf("preset bulk_compression not applied: got %v", got.BulkCompression)
	}
}

func TestConnectionTypeOrDefault(t *testing.T) {
	if got := (RdpOptions{}).ConnectionTypeOrDefault(); got != ConnTypeBroadbandLow {
		t.Errorf("unset: got %d want %d", got, ConnTypeBroadbandLow)
	}
	bad := uint8(99)
	if got := (RdpOptions{ConnectionType: &bad}).ConnectionTypeOrDefault(); got != ConnTypeBroadbandLow {
		t.Errorf("invalid: got %d want %d", got, ConnTypeBroadbandLow)
	}
	lan := ConnTypeLAN
	if got := (RdpOptions{ConnectionType: &lan}).ConnectionTypeOrDefault(); got != ConnTypeLAN {
		t.Errorf("valid: got %d want %d", got, ConnTypeLAN)
	}
}

func TestCompressionLevelOrDefault(t *testing.T) {
	if got := (RdpOptions{}).CompressionLevelOrDefault(); got != 2 {
		t.Errorf("unset: got %d want 2", got)
	}
	bad := uint8(9)
	if got := (RdpOptions{CompressionLevel: &bad}).CompressionLevelOrDefault(); got != 2 {
		t.Errorf("invalid: got %d want 2", got)
	}
	zero := uint8(0)
	if got := (RdpOptions{CompressionLevel: &zero}).CompressionLevelOrDefault(); got != 0 {
		t.Errorf("zero (valid): got %d want 0", got)
	}
}

func TestSecurityFlags(t *testing.T) {
	cases := []struct {
		in            RdpSecurity
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
