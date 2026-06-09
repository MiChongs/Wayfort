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

	// HighDPI toggles high-DPI scaling for this node. Unset = on (the platform
	// default): the session renders at the browser's physical-pixel resolution
	// with matching Windows display scaling, so text/UI stay crisp on HiDPI
	// screens. Set false for legacy servers that mis-handle scale factors.
	// freerdp backend only.
	HighDPI *bool `json:"high_dpi,omitempty"`
	// MaxScale caps the per-session scale factor in percent (e.g. 200). 0 /
	// unset = no node cap (the worker still clamps to RDP's 100..500 range).
	// Use to bound bandwidth from very-high-DPI clients on a given node.
	MaxScale *uint32 `json:"max_scale,omitempty"`

	// ----- Network / bandwidth profile (Phase 1) -----

	// NetworkPreset is a one-shot bandwidth/latency profile that fills in
	// sensible defaults for the codec / compression / connection-type /
	// performance-flag knobs below. Mirrors FreeRDP's /network:<type>. The
	// preset only fills fields the operator left UNSET — any explicit per-field
	// choice always wins. "" = no preset (pure manual / worker defaults).
	//   "lan"       → LAN link: full visuals, 32bpp, no bulk compression
	//   "broadband" → broadband-high: 32bpp, light trim, no bulk compression
	//   "wan"       → WAN link: 16bpp, bulk compression, trim wallpaper/anims
	//   "mobile"    → modem/cellular: 16bpp, aggressive trim, bulk compression
	//   "auto"      → adaptive: keep visuals, let the ABR/GCC loop pace bitrate
	// Resolved in the gateway (ResolveNetworkPreset) before the worker connects.
	NetworkPreset string `json:"network_preset,omitempty"`

	// ConnectionType overrides the RDP CONNECTION_TYPE hint advertised in the
	// GCC client core data (MS-RDPBCGR TS_UD_CS_CORE.connectionType). Tells the
	// server how to bias its own codec/quality heuristics:
	//   1=MODEM 2=BROADBAND_LOW 3=SATELLITE 4=BROADBAND_HIGH 5=WAN
	//   6=LAN 7=AUTODETECT. 0 / unset = worker default (BROADBAND_LOW).
	ConnectionType *uint8 `json:"connection_type,omitempty"`

	// BulkCompression toggles RDP bulk data compression (MPPC/RDP6,
	// FreeRDP_CompressionEnabled). Trades worker CPU for fewer bytes on the
	// legacy bitmap/cache path — worthwhile on WAN/mobile, wasted on LAN and
	// irrelevant to the already-compressed GFX/H.264/VP9 paths. Unset = off.
	BulkCompression *bool `json:"bulk_compression,omitempty"`
	// CompressionLevel selects the compression generation when BulkCompression
	// is on: 0=RDP4(8K window) 1=RDP5(64K) 2=RDP6 3=RDP6.1. Higher = better
	// ratio at more CPU/memory. Unset = 2. Mirrors FreeRDP's /compression-level.
	CompressionLevel *uint8 `json:"compression_level,omitempty"`

	// DynamicResolution lets the remote desktop resolution track the browser
	// window live (DRDYNVC `disp` display channel + FreeRDP_DynamicResolutionUpdate)
	// instead of staying pinned to the connect-time size — so a window resize
	// reflows the remote desktop at native 1:1 with no scaling blur. Off by
	// default: the display dynamic channel is not on the always-wired path, so
	// it is enabled per-session only when the operator opts in. Pairs with the
	// frontend "动态分辨率" mode (see Phase 5). freerdp backend only.
	DynamicResolution *bool `json:"dynamic_resolution,omitempty"`

	EnableRemoteFx         *bool `json:"enable_remote_fx,omitempty"`
	EnableNSCodec          *bool `json:"enable_nscodec,omitempty"`
	EnableH264             *bool `json:"enable_h264,omitempty"`
	EnableGraphicsPipeline *bool `json:"enable_graphics_pipeline,omitempty"`

	// PreferZstd makes the worker compress the lossless BGRA fallback with zstd
	// instead of zlib. Set from ClientCaps.Zstd at session start; the browser's
	// decode worker bundles a zstd-wasm decoder so it can always inflate it.
	PreferZstd *bool `json:"prefer_zstd,omitempty"`

	// GfxCodec biases the RDPGFX codec negotiation for the legacy bitmap
	// (non-WebRTC) path. Honoured only when the browser actually advertises the
	// matching decode capability — otherwise the worker falls back to a codec
	// the client can render. "" / "auto" = current behaviour (H.264/AVC420 when
	// supported). Values:
	//   "avc444" → 4:4:4 full-chroma H.264 (sharpest coloured text). FreeRDP
	//              decodes it server-side (WITH_GFX_H264/FFmpeg) into the
	//              framebuffer and the worker emits the decoded BGRA — correct
	//              colours, no browser AVC444 decoder needed (costs server CPU +
	//              some bandwidth). Bitmap path only.
	//   "avc420" → single-stream H.264 (4:2:0)
	//   "rfx"    → RemoteFX progressive
	//   "nsc"    → NSCodec
	//   "none"   → uncompressed / Planar surfaces only
	GfxCodec string `json:"gfx_codec,omitempty"`
	// PreferAV1 opts the session into AV1 when it can be negotiated — host-side
	// RDPGFX AV1 passthrough (/gfx:av1, Win11 24H2) or, where the worker has an
	// AV1 encoder compiled in, server-side AV1. Falls back to H.264/VP9 when AV1
	// is unavailable. Off by default (browser AV1 decode support is still
	// uneven). See Phase 3. freerdp backend only.
	PreferAV1 *bool `json:"prefer_av1,omitempty"`

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

	// RD Gateway (Microsoft Remote Desktop Gateway, MS-TSGU). When GatewayHost
	// is set, the worker reaches the target THROUGH the gateway (HTTPS/RPC
	// tunnel) instead of connecting to it directly — for RDP hosts that are only
	// published via an RD Gateway. Independent of proxy_chain (that's JumpServer's
	// own SSH/SOCKS jump hosts).
	GatewayHost string  `json:"gateway_host,omitempty"`
	GatewayPort *uint32 `json:"gateway_port,omitempty"` // default 443
	// GatewayDomain overrides the AD domain presented to the gateway (defaults to
	// the target Domain when same-credentials).
	GatewayDomain string `json:"gateway_domain,omitempty"`
	// GatewayUseSameCredentials (default true when GatewayHost set) makes the
	// gateway authenticate with the SAME credential as the target — the common
	// enterprise case (one AD account). Set false to use a dedicated gateway
	// login via GatewayCredentialID.
	GatewayUseSameCredentials *bool `json:"gateway_use_same_credentials,omitempty"`
	// GatewayCredentialID names a separate sealed password credential for the
	// gateway login (used only when GatewayUseSameCredentials is false). Keeps the
	// gateway password out of proto_options.
	GatewayCredentialID *uint64 `json:"gateway_credential_id,omitempty"`
	// GatewayTransport selects the tunnel transport: "auto" (default, try
	// HTTP/WebSocket then RPC), "http" (WebSocket only — modern gateways), or
	// "rpc" (RPC-over-HTTP only — legacy 2008/2012 gateways).
	GatewayTransport string `json:"gateway_transport,omitempty"`
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

// RDP CONNECTION_TYPE values (MS-RDPBCGR §2.2.1.3.2 TS_UD_CS_CORE.connectionType).
const (
	ConnTypeModem         uint8 = 1 // CONNECTION_TYPE_MODEM (56 Kbps)
	ConnTypeBroadbandLow  uint8 = 2 // CONNECTION_TYPE_BROADBAND_LOW (256K–2M)
	ConnTypeSatellite     uint8 = 3 // CONNECTION_TYPE_SATELLITE
	ConnTypeBroadbandHigh uint8 = 4 // CONNECTION_TYPE_BROADBAND_HIGH (2M–10M)
	ConnTypeWAN           uint8 = 5 // CONNECTION_TYPE_WAN (10M+, high RTT)
	ConnTypeLAN           uint8 = 6 // CONNECTION_TYPE_LAN (10M+, low RTT)
	ConnTypeAutoDetect    uint8 = 7 // CONNECTION_TYPE_AUTODETECT
)

// networkProfile is the concrete knob set a NetworkPreset expands to. Every
// field is applied to RdpOptions only where the operator left the corresponding
// option unset (explicit choice always wins).
type networkProfile struct {
	connectionType   uint8
	colorDepth       uint8
	bulkCompression  bool
	compressionLevel uint8
	disableWallpaper bool
	disableThemes    bool
	disableMenuAnims bool
	disableFullDrag  bool
	fontSmoothing    bool
	desktopComp      bool
}

// networkPresets maps the operator-facing preset names onto concrete profiles.
// Tuned to mirror FreeRDP's /network:<type> performance-flag presets while
// keeping our defaults (full visuals on a fast link, progressive trim as the
// link degrades). "auto" deliberately keeps full visuals and leans on the
// WebRTC GCC/ABR loop for pacing rather than RDP's own NetworkAutoDetect PDU
// (which the worker keeps off — it deadlocks some Server 2022 builds and the
// gateway has no UDP sidechannel).
var networkPresets = map[string]networkProfile{
	"lan": {
		connectionType: ConnTypeLAN, colorDepth: 32,
		bulkCompression: false, compressionLevel: 2,
		fontSmoothing: true, desktopComp: true,
	},
	"broadband": {
		connectionType: ConnTypeBroadbandHigh, colorDepth: 32,
		bulkCompression: false, compressionLevel: 2,
		fontSmoothing: true, desktopComp: true,
	},
	"auto": {
		connectionType: ConnTypeBroadbandLow, colorDepth: 32,
		bulkCompression: false, compressionLevel: 2,
		fontSmoothing: true, desktopComp: true,
	},
	"wan": {
		connectionType: ConnTypeWAN, colorDepth: 16,
		bulkCompression: true, compressionLevel: 2,
		disableWallpaper: true, disableMenuAnims: true, disableFullDrag: true,
		fontSmoothing: true, desktopComp: false,
	},
	"mobile": {
		connectionType: ConnTypeModem, colorDepth: 16,
		bulkCompression: true, compressionLevel: 2,
		disableWallpaper: true, disableThemes: true,
		disableMenuAnims: true, disableFullDrag: true,
		fontSmoothing: false, desktopComp: false,
	},
}

// ResolveNetworkPreset returns a copy of o with the NetworkPreset expanded into
// concrete connection-tuning fields. The preset only fills fields the operator
// left unset, so an explicit per-field override (e.g. color_depth=32 on a "wan"
// node) always wins. An empty or unknown preset returns o unchanged. This runs
// in the gateway before StartParams is built, so the worker only ever sees fully
// resolved values and stays free of preset logic.
func (o RdpOptions) ResolveNetworkPreset() RdpOptions {
	if o.NetworkPreset == "" {
		return o
	}
	prof, ok := networkPresets[o.NetworkPreset]
	if !ok {
		return o
	}
	out := o
	if out.ConnectionType == nil {
		ct := prof.connectionType
		out.ConnectionType = &ct
	}
	if out.ColorDepth == nil {
		cd := prof.colorDepth
		out.ColorDepth = &cd
	}
	if out.BulkCompression == nil {
		out.BulkCompression = boolPtr(prof.bulkCompression)
	}
	if out.CompressionLevel == nil {
		cl := prof.compressionLevel
		out.CompressionLevel = &cl
	}
	if out.DisableWallpaper == nil {
		out.DisableWallpaper = boolPtr(prof.disableWallpaper)
	}
	if out.DisableThemes == nil {
		out.DisableThemes = boolPtr(prof.disableThemes)
	}
	if out.DisableMenuAnims == nil {
		out.DisableMenuAnims = boolPtr(prof.disableMenuAnims)
	}
	if out.DisableFullWindowDrag == nil {
		out.DisableFullWindowDrag = boolPtr(prof.disableFullDrag)
	}
	if out.AllowFontSmoothing == nil {
		out.AllowFontSmoothing = boolPtr(prof.fontSmoothing)
	}
	if out.AllowDesktopComposition == nil {
		out.AllowDesktopComposition = boolPtr(prof.desktopComp)
	}
	return out
}

// ConnectionTypeOrDefault returns the resolved RDP connection-type hint, falling
// back to BROADBAND_LOW (the worker's historical default) when unset or invalid.
func (o RdpOptions) ConnectionTypeOrDefault() uint8 {
	if o.ConnectionType != nil && *o.ConnectionType >= ConnTypeModem && *o.ConnectionType <= ConnTypeAutoDetect {
		return *o.ConnectionType
	}
	return ConnTypeBroadbandLow
}

// CompressionLevelOrDefault returns the resolved compression generation (0..3),
// defaulting to 2 (RDP6) when unset/invalid. Only meaningful when
// BulkCompression is enabled.
func (o RdpOptions) CompressionLevelOrDefault() uint8 {
	if o.CompressionLevel != nil && *o.CompressionLevel <= 3 {
		return *o.CompressionLevel
	}
	return 2
}

func boolPtr(b bool) *bool { return &b }
