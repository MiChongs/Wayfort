package desktop

import "encoding/json"

// RdpSecurity selects which RDP security protocol(s) the worker offers
// during negotiation. FreeRDP picks the highest match with the server.
type RdpSecurity string

const (
	// SecAny enables NLA + TLS + RDP Security so libfreerdp negotiates the
	// best mutually-supported option. This is the new default.
	SecAny RdpSecurity = "any"
	// SecNLA forces Network Level Authentication only. Fails fast against
	// servers where NLA is disabled.
	SecNLA RdpSecurity = "nla"
	// SecTLS forces plain TLS without CredSSP. Use this for hosts where
	// NLA is unavailable (old Windows Server / GPO) or where credentials
	// are wrong but TLS-level access is acceptable.
	SecTLS RdpSecurity = "tls"
	// SecRDP forces legacy RDP encryption (XOR / RC4). Last-resort for very
	// old Windows installs that don't speak TLS at all.
	SecRDP RdpSecurity = "rdp"
)

// RdpOptions is the operator-tunable knob set for a single RDP node. Each
// pointer field encodes the tri-state {unset → use worker default, set
// true, set false} — important because most of these are booleans where
// `false` is a real user choice, not "no opinion".
//
// Persisted as JSON inside Node.ProtoOptions under the `rdp` sub-key. See
// ParseRdpOptions for the wire envelope (incl. legacy Guacamole-flat form).
type RdpOptions struct {
	Security       RdpSecurity `json:"security,omitempty"`
	TlsSecLevel    *uint8      `json:"tls_sec_level,omitempty"`
	IgnoreCert     *bool       `json:"ignore_cert,omitempty"`
	Domain         string      `json:"domain,omitempty"`
	Keyboard       string      `json:"keyboard,omitempty"`
	ColorDepth     *uint8      `json:"color_depth,omitempty"`
	ConsoleSession *bool       `json:"console_session,omitempty"`

	EnableRemoteFx         *bool `json:"enable_remote_fx,omitempty"`
	EnableNSCodec          *bool `json:"enable_nscodec,omitempty"`
	EnableH264             *bool `json:"enable_h264,omitempty"`
	EnableGraphicsPipeline *bool `json:"enable_graphics_pipeline,omitempty"`

	DisableWallpaper        *bool `json:"disable_wallpaper,omitempty"`
	DisableFullWindowDrag   *bool `json:"disable_full_window_drag,omitempty"`
	DisableMenuAnims        *bool `json:"disable_menu_anims,omitempty"`
	DisableThemes           *bool `json:"disable_themes,omitempty"`
	AllowFontSmoothing      *bool `json:"allow_font_smoothing,omitempty"`
	AllowDesktopComposition *bool `json:"allow_desktop_composition,omitempty"`

	RedirectClipboard *bool `json:"redirect_clipboard,omitempty"`
	AudioPlayback     *bool `json:"audio_playback,omitempty"`
	DeviceRedirection *bool `json:"device_redirection,omitempty"`

	TcpConnectTimeoutMS *uint32 `json:"tcp_connect_timeout_ms,omitempty"`
	TcpAckTimeoutMS     *uint32 `json:"tcp_ack_timeout_ms,omitempty"`
}

// ParseRdpOptions extracts the RDP-specific knobs from a node's
// proto_options JSON blob. The accepted envelopes are:
//
//   1. `{"rdp": {"security": "tls", ...}}` — current structured form
//   2. `{"security": "tls", "domain": "WORKGROUP", "ignore-cert": "true",
//        "keyboard": "en-us"}` — legacy Guacamole flat form
//
// Empty / invalid input returns a zero-value RdpOptions (which downstream
// code interprets as "use worker defaults"). The dual-format detection
// preserves backward compatibility for existing nodes whose proto_options
// were authored against the Guacamole stack.
func ParseRdpOptions(raw string) RdpOptions {
	if raw == "" {
		return RdpOptions{}
	}
	var envelope struct {
		RDP *RdpOptions `json:"rdp,omitempty"`
		// Legacy flat-form fields. Note Guacamole used "ignore-cert" as a
		// string; structured form uses "ignore_cert" as a real bool.
		Security   string `json:"security,omitempty"`
		Domain     string `json:"domain,omitempty"`
		IgnoreCert any    `json:"ignore-cert,omitempty"`
		Keyboard   string `json:"keyboard,omitempty"`
	}
	if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
		return RdpOptions{}
	}
	if envelope.RDP != nil {
		return *envelope.RDP
	}
	out := RdpOptions{
		Security: RdpSecurity(envelope.Security),
		Domain:   envelope.Domain,
		Keyboard: envelope.Keyboard,
	}
	switch v := envelope.IgnoreCert.(type) {
	case bool:
		out.IgnoreCert = boolPtr(v)
	case string:
		if v == "true" || v == "1" {
			out.IgnoreCert = boolPtr(true)
		} else if v == "false" || v == "0" {
			out.IgnoreCert = boolPtr(false)
		}
	}
	return out
}

// SecurityFlags expands the Security mode to the NLA / TLS / RDP toggle
// triple that applySettings() writes. Unset (SecAny or empty) enables all
// three so FreeRDP picks the best.
func (o RdpOptions) SecurityFlags() (nla, tls, rdp bool) {
	switch o.Security {
	case SecNLA:
		return true, false, false
	case SecTLS:
		return false, true, false
	case SecRDP:
		return false, false, true
	default:
		return true, true, true
	}
}

func boolPtr(b bool) *bool { return &b }
