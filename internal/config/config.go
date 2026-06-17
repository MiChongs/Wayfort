package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/viper"
)

type Config struct {
	Server    ServerConfig    `mapstructure:"server"`
	DB        DBConfig        `mapstructure:"db"`
	Redis     RedisConfig     `mapstructure:"redis"`
	Auth      AuthConfig      `mapstructure:"auth"`
	Crypto    CryptoConfig    `mapstructure:"crypto"`
	Storage   StorageConfig   `mapstructure:"storage"`
	SSHPool   SSHPoolConfig   `mapstructure:"sshpool"`
	Anonymous AnonymousConfig `mapstructure:"anonymous"`
	Recorder  RecorderConfig  `mapstructure:"recorder"`
	Audit     AuditConfig     `mapstructure:"audit"`
	WebSSH    WebSSHConfig    `mapstructure:"webssh"`
	Protocols ProtocolsConfig `mapstructure:"protocols"`
	Notify    NotifyConfig    `mapstructure:"notify"`
	AI        AIConfig        `mapstructure:"ai"`
	Insights  InsightsConfig  `mapstructure:"insights"`
	Desktop   DesktopConfig   `mapstructure:"desktop"`
	Approval  ApprovalConfig  `mapstructure:"approval"`
	Office    OfficeConfig    `mapstructure:"office"`
	Health    HealthConfig    `mapstructure:"health"`
	Watermark WatermarkConfig `mapstructure:"watermark"`
	Agent     AgentConfig     `mapstructure:"agent"`
	Guard     GuardConfig     `mapstructure:"guard"`
	Metrics    MetricsConfig    `mapstructure:"metrics"`
	GeoIP      GeoIPConfig      `mapstructure:"geoip"`
	BreakGlass BreakGlassConfig `mapstructure:"break_glass"`
	Edition    EditionConfig    `mapstructure:"edition"`
}

// EditionConfig is the bootstrap fallback for the license. The preferred path is
// to install the license at runtime via the admin UI (stored in the DB); these
// fields let an operator pin a license in YAML/env or from a file for air-gapped
// / immutable deployments. A DB-installed license takes precedence over both.
type EditionConfig struct {
	// License is an inline license token (the whole JSL1.… string).
	License string `mapstructure:"license"`
	// LicenseFile is a path to a file containing a license token. Read at startup
	// and on reload. Intentionally NOT exposed in the settings UI (it reads an
	// arbitrary filesystem path) — YAML/env only.
	LicenseFile string `mapstructure:"license_file"`
}

// BreakGlassConfig is the global kill-switch + ceilings for emergency access
// (应急访问). Per-asset granularity lives in break_glass_policies; these are the
// system-wide gates the settings center exposes (all live / hot-reloaded).
type BreakGlassConfig struct {
	// Enabled turns the whole break-glass surface on. When false the activate
	// endpoint refuses with 503 and the reconciler idles.
	Enabled bool `mapstructure:"enabled"`
	// AllowFailOpen is the GLOBAL gate for self-service (no-prior-approval)
	// activation. AND-ed with each policy's AllowFailOpen — both must be true for
	// a fail-open activation to be permitted. Off by default: a fresh install
	// only allows the approver-mediated path until an operator opts in.
	AllowFailOpen bool `mapstructure:"allow_fail_open"`
	// MaxDuration caps every activation window regardless of policy. The
	// effective window is min(policy, this, approval-template).
	MaxDuration time.Duration `mapstructure:"max_duration"`
	// RequireReview forces post-use review on for every activation regardless of
	// per-policy settings (a compliance override).
	RequireReview bool `mapstructure:"require_review"`
}

// GeoIPConfig drives IP→location resolution (login history "where from" + the
// anomaly detector's new-country / impossible-travel rules). Lookups are served
// from a MaxMind-format .mmdb held in memory; the file can be staged manually or
// kept current by the built-in auto-updater.
//
// AutoUpdate defaults OFF so a fresh deploy makes no surprise outbound request
// (bastions are often air-gapped) — the source URLs are pre-filled with the
// keyless monthly db-ip "lite" databases, so enabling it (or hitting the admin
// "update now" endpoint) is a single switch. The {year}/{month} tokens in the
// URL are substituted with the current UTC date at download time.
type GeoIPConfig struct {
	Enabled         bool          `mapstructure:"enabled"`
	DBPath          string        `mapstructure:"db_path"`          // city/country .mmdb
	ASNDBPath       string        `mapstructure:"asn_db_path"`      // optional ASN .mmdb
	AutoUpdate      bool          `mapstructure:"auto_update"`      // download + refresh on a schedule
	UpdateURL       string        `mapstructure:"update_url"`       // city db source (.mmdb / .gz / .tar.gz)
	ASNUpdateURL    string        `mapstructure:"asn_update_url"`   // ASN db source
	UpdateInterval  time.Duration `mapstructure:"update_interval"`  // staleness threshold + check cadence
	DownloadTimeout time.Duration `mapstructure:"download_timeout"` // per-download HTTP timeout
	Language        string        `mapstructure:"language"`         // preferred place-name language
	// AllowPrivateURL relaxes the download SSRF guard to permit a private /
	// loopback address — set true ONLY for a legitimate internal GeoIP mirror.
	AllowPrivateURL bool `mapstructure:"allow_private_url"`
}

// MetricsConfig controls the Prometheus /metrics endpoint (security-architecture
// §16). Disabled by default. When enabled, set Token to require a bearer token
// on scrapes (recommended — /metrics otherwise leaks operational data).
type MetricsConfig struct {
	Enabled bool   `mapstructure:"enabled"`
	Token   string `mapstructure:"token"`
}

// GuardConfig configures the overload-protection layer (security-architecture.md
// §11): concurrency ceilings, the connection-rate limit, and the per-domain
// circuit breaker. Zero ceilings mean "unlimited"; the defaults are applied in
// main.go so an empty config is safe.
type GuardConfig struct {
	GlobalMaxSessions  int `mapstructure:"global_max_sessions"`   // default 2000
	PerUserMaxSessions int `mapstructure:"per_user_max_sessions"` // default 20
	ConnectsPerMinute  int `mapstructure:"connects_per_minute"`   // per-user new-session rate; default 10
	BreakerMinSamples  int `mapstructure:"breaker_min_samples"`   // default 10
	BreakerOpenSeconds int `mapstructure:"breaker_open_seconds"`  // default 30
}

// AgentConfig drives the reverse-connect Gateway Agent control plane's mTLS
// listener (security-architecture.md §4/§6). When enabled the gateway stands up
// a dedicated TLS listener for /agent/v1/{enroll,renew,tunnel}, terminating TLS
// itself so it can verify agent client certificates — which a fronting reverse
// proxy can't do for it.
type AgentConfig struct {
	// Enabled turns on the dedicated mTLS listener. Default false; when off the
	// agent endpoints are not exposed (reverse agents unavailable).
	Enabled bool `mapstructure:"enabled"`
	// Addr is the listener bind address (default ":8443"). Keep it separate from
	// the user-facing API port so it can be firewalled to the agent egress range.
	Addr string `mapstructure:"addr"`
	// PublicHost is the agent-facing hostname/IP agents dial. It becomes the
	// server certificate SAN and the host shown in the install command. Empty =
	// derive from the request at install time (server cert then uses a wildcard
	// localhost SAN only — fine for testing, set it for production).
	PublicHost string `mapstructure:"public_host"`
	// DistDir is the directory the gateway serves prebuilt gateway-agent
	// binaries from (GET /dl/gateway-agent). Stage it with scripts/build-agent.sh
	// output. Default "dist/agent" (relative to the gateway's working dir); empty
	// disables the download endpoint and the copy-paste install command.
	DistDir string `mapstructure:"dist_dir"`
}

// WatermarkConfig drives the browser-side anti-leak watermark: a diagonally
// tiled overlay carrying the operator's identity across every authenticated
// page and full-screen session so a screenshot/photo leak is traceable. The
// gateway only stores policy here; the per-user identity is resolved at request
// time by the /me/watermark endpoint (email/phone masked server-side) and the
// canvas rendering happens in the browser via the watermark-js-plus library.
//
// Content is a template with newline-separated lines and {var} placeholders:
// {username} {name} {email} {phone} {ip} {date} {time} {datetime} plus the
// session-scoped {asset} {host} {session}. The server substitutes identity + ip
// (masking email/phone) and leaves the date/time AND session tokens for the
// client to fill: date/time so the optional clock can tick, and asset/host/
// session because they only exist inside a live terminal/desktop connection
// (a plain page clears them).
type WatermarkConfig struct {
	Enabled      bool   `mapstructure:"enabled"`       // master switch
	Scope        string `mapstructure:"scope"`         // all | session
	Content      string `mapstructure:"content"`       // template, newline-separated, {var} tokens
	Opacity      int    `mapstructure:"opacity"`       // 1..100 (%)
	FontSize     int    `mapstructure:"font_size"`     // px
	FontColor    string `mapstructure:"font_color"`    // hex
	Rotation     int    `mapstructure:"rotation"`      // degrees, -90..90 (default -45 → 45° diagonal)
	GapX         int    `mapstructure:"gap_x"`         // horizontal tile spacing px
	GapY         int    `mapstructure:"gap_y"`         // vertical tile spacing px
	AntiTamper   bool   `mapstructure:"anti_tamper"`   // MutationObserver auto-restore
	Hardened     bool   `mapstructure:"hardened"`      // extra removal hardening + periodic re-validate
	BlindEnabled bool   `mapstructure:"blind_enabled"` // invisible blind watermark for forensics
	BlindContent string `mapstructure:"blind_content"` // blind text; empty → first visible line
	LiveClock    bool   `mapstructure:"live_clock"`    // refresh time tokens periodically
	RefreshSec   int    `mapstructure:"refresh_sec"`   // clock refresh / re-validate interval (s)
	SessionVars  bool   `mapstructure:"session_vars"`  // fill {asset}/{host}/{session} inside live sessions
}

// HealthConfig tunes the background proxy reachability prober. When enabled, a
// goroutine probes every enabled proxy on Interval and feeds the failover dialer
// + the live-health UI. ProbeTarget empty (default) = L4 reachability to each
// proxy's own endpoint (no tunnel traffic); set it to a host:port to instead
// dial that canary THROUGH each proxy (true end-to-end, exercises credentials).
type HealthConfig struct {
	Enabled     bool          `mapstructure:"enabled"`
	Interval    time.Duration `mapstructure:"interval"`
	Timeout     time.Duration `mapstructure:"timeout"`
	Concurrency int           `mapstructure:"concurrency"`
	DegradedMS  int64         `mapstructure:"degraded_ms"`
	ProbeTarget string        `mapstructure:"probe_target"`
}

// OfficeConfig wires an external OnlyOffice / Collabora Document Server for
// in-browser editing of Office documents on the SFTP and OSS surfaces.
// Disabled by default — when off, office files fall back to download.
// document_server_url is where the editor's api.js is served; callback_base_url
// is THIS gateway's URL as reachable from the Document Server (it pulls files
// and posts saves there); jwt_secret must match the Document Server's secret.
type OfficeConfig struct {
	Enabled           bool   `mapstructure:"enabled"`
	DocumentServerURL string `mapstructure:"document_server_url"`
	JWTSecret         string `mapstructure:"jwt_secret"`
	CallbackBaseURL   string `mapstructure:"callback_base_url"`
}

// ApprovalConfig is the Phase 16c knob set for the audit-ledger offsite
// archive. When `archive.enabled: true` the gateway pushes every
// hash-chained ApprovalEvent to an S3-compatible bucket with Object Lock
// retention so the chain survives even a complete loss of the primary
// PostgreSQL store. MinIO works as a drop-in target.
type ApprovalConfig struct {
	Archive ApprovalArchiveConfig `mapstructure:"archive"`
}

type ApprovalArchiveConfig struct {
	Enabled bool `mapstructure:"enabled"`
	// EndpointURL is empty for AWS S3; set to the MinIO / Ceph / other
	// S3-compatible URL otherwise. UsePathStyle is forced on for
	// non-empty endpoints.
	EndpointURL     string `mapstructure:"endpoint_url"`
	Region          string `mapstructure:"region"`
	Bucket          string `mapstructure:"bucket"`
	Prefix          string `mapstructure:"prefix"`
	AccessKeyID     string `mapstructure:"access_key_id"`
	SecretAccessKey string `mapstructure:"secret_access_key"`
	// RetentionMode is "GOVERNANCE" (admin can bypass) or "COMPLIANCE"
	// (no one can shorten retention). Default GOVERNANCE.
	RetentionMode string        `mapstructure:"retention_mode"`
	RetentionDays int           `mapstructure:"retention_days"`
	FlushInterval time.Duration `mapstructure:"flush_interval"`
	BatchSize     int           `mapstructure:"batch_size"`
}

// InsightsConfig — Plan 14: SSH-page live system dashboard. The frontend
// polls /api/v1/nodes/:id/insights/* on a user-chosen interval; the manager
// dedups concurrent requests inside CacheTTL and aborts a single sample
// after SSHTimeout.
type InsightsConfig struct {
	Enabled      bool          `mapstructure:"enabled"`
	CacheTTL     time.Duration `mapstructure:"cache_ttl"`
	SSHTimeout   time.Duration `mapstructure:"ssh_timeout"`
	ProcessLimit int           `mapstructure:"process_limit"`
}

// DesktopConfig — Plan 17: new RDP backend with worker-process abstraction
// (FreeRDP / IronRDP / dummy). DefaultBackend "freerdp" requires WorkerPath
// to point at the `freerdp-worker` binary built from cmd/freerdp-worker.
// During Plan 17 M1 (no libfreerdp linkage yet) leave DefaultBackend
// "dummy" so the test-pattern worker runs in-process and the pipeline is
// exercisable.
type DesktopConfig struct {
	Enabled               bool          `mapstructure:"enabled"`
	DefaultBackend        string        `mapstructure:"default_backend"`
	WorkerPath            string        `mapstructure:"worker_path"`
	WorkerIdleTimeout     time.Duration `mapstructure:"worker_idle_timeout"`
	MaxConcurrentSessions int           `mapstructure:"max_concurrent_sessions"`
	// Plan 18 — startup self-check that lazily installs libfreerdp +
	// builds the worker binary if it can't find one at WorkerPath / the
	// fallback path table. Default true so a fresh deploy "just works"
	// on supported distros. Operators can opt out.
	AutoInstall bool `mapstructure:"auto_install"`
	// InstallPrefix is where the freshly-built worker gets dropped.
	// Defaults to /usr/local/bin/freerdp-worker. ~/.local/bin and the
	// gateway binary's own directory are tried as fallbacks if this is
	// not writeable.
	InstallPrefix string `mapstructure:"install_prefix"`
	// DebugLog turns on libfreerdp's WLOG_LEVEL=DEBUG for every freerdp-
	// worker subprocess. The full RDP state machine (X.224 / TLS / MCS /
	// CredSSP / channel join / capability negotiation) is then logged at
	// DEBUG level via the worker's stderr → gateway log forwarder.
	// Default false because DEBUG is loud (hundreds of lines per session
	// connect). Enable when diagnosing a specific failure.
	DebugLog bool `mapstructure:"debug_log"`

	// DevolutionsGateway — Plan 29: the new ironrdp backend. The browser
	// talks RDP directly via @devolutions/iron-remote-desktop (Wasm) and
	// tunnels over WebSocket to a Devolutions Gateway subprocess we
	// supervise here. This Go service only mints short-lived RS256 JWTs;
	// the gateway subprocess validates them and byte-proxies TCP to the
	// target RDP host. Replaces the libfreerdp cgo subprocess pipeline.
	DevolutionsGateway DevolutionsGatewayConfig `mapstructure:"devolutions_gateway"`

	// Recording — session screen recording + input audit for the freerdp
	// backend. The gateway tees the desktop.v2 frame stream (and, when
	// IncludeInput is on, keyboard/mouse/clipboard events + milestones) to a
	// timestamped .dtr file that the browser replays in-place via the same
	// canvas/decoder pipeline. On by default, as bastion audit usually
	// requires it.
	Recording DesktopRecordingConfig `mapstructure:"recording"`

	// Drive — per-user persistent file drive redirected into every freerdp
	// session (rdpdr filesystem redirection). The user uploads/downloads via
	// the browser file panel; the same folder is mounted as a drive in the
	// remote desktop so files move both ways. ironrdp sessions don't use it.
	Drive DesktopDriveConfig `mapstructure:"drive"`

	// WebRTC — the hardware-decoded video path for the freerdp backend. When
	// enabled and the browser advertises WebRTC support, the worker VP8-encodes
	// the composited framebuffer and the gateway streams it over a Pion video
	// track instead of pushing dirty-bitmap frames the browser decodes in JS.
	// The browser renders it in a <video> element (GPU decode). Falls back to
	// the legacy bitmap path automatically when negotiation fails.
	WebRTC DesktopWebRTCConfig `mapstructure:"webrtc"`
}

// DesktopWebRTCConfig parameterises the WebRTC video transport. ICE defaults
// to host candidates only (works for a directly reachable gateway / same-LAN
// browser); add STUN/TURN/public-IP for NAT traversal.
type DesktopWebRTCConfig struct {
	// Enabled gates the whole path. On by default; the browser must also
	// advertise WebRTC support or the session silently uses the bitmap path.
	Enabled bool `mapstructure:"enabled"`
	// Codec is the preferred WebRTC video codec: "vp9" (default) uses VP9's
	// screen-content coding — markedly sharper for desktop text/UI at the same
	// bitrate — when the browser can decode it; "vp8" forces the universally
	// supported baseline. A vp9 preference falls back to vp8 per-session when
	// the browser doesn't advertise VP9 decode.
	Codec string `mapstructure:"codec"`
	// BitrateKbps / FPS tune the worker's video encoder. BitrateKbps is the
	// "balanced" quality target; the per-session VideoQuality choice scales it.
	// 0 = worker defaults (8000 kbps / 30 fps).
	BitrateKbps int `mapstructure:"bitrate_kbps"`
	FPS         int `mapstructure:"fps"`
	// STUNURLs are reflexive-candidate servers, e.g.
	// ["stun:stun.l.google.com:19302"]. Empty = host candidates only.
	STUNURLs []string `mapstructure:"stun_urls"`
	// TURN* relays media when neither side can reach the other directly (the
	// gateway sits behind symmetric NAT and the browser is remote). Empty URL
	// disables TURN.
	TURNURL      string `mapstructure:"turn_url"`
	TURNUsername string `mapstructure:"turn_username"`
	TURNPassword string `mapstructure:"turn_password"`
	// PublicIP maps the gateway's host candidates to a known public address
	// (1:1 NAT). Set this when the gateway has a stable public IP but binds a
	// private one — the cheapest way to make WebRTC work across NAT without a
	// STUN/TURN round trip.
	PublicIP string `mapstructure:"public_ip"`
	// UDPPortMin / UDPPortMax bound the ICE UDP port range so a firewall can
	// be opened narrowly. 0/0 = let the OS pick any ephemeral port.
	UDPPortMin int `mapstructure:"udp_port_min"`
	UDPPortMax int `mapstructure:"udp_port_max"`
}

// DesktopDriveConfig parameterises the redirected per-user file drive.
type DesktopDriveConfig struct {
	// Enabled gates the whole feature. On by default.
	Enabled bool `mapstructure:"enabled"`
	// Dir is the base directory under which each user gets a folder
	// (<dir>/user-<id>). Empty = <sessions_dir>/desktop-drives.
	Dir string `mapstructure:"dir"`
	// Name is the drive label shown in the remote "This PC" (ASCII).
	Name string `mapstructure:"name"`
	// AllowUpload / AllowDownload gate the transfer directions independently so
	// an operator can run upload-only (no exfil) or download-only.
	AllowUpload   bool `mapstructure:"allow_upload"`
	AllowDownload bool `mapstructure:"allow_download"`
	// MaxFileMB caps a single uploaded file; MaxTotalMB caps a user's whole
	// folder. 0 = unlimited.
	MaxFileMB  int `mapstructure:"max_file_mb"`
	MaxTotalMB int `mapstructure:"max_total_mb"`
}

// DesktopRecordingConfig parameterises freerdp session recording.
type DesktopRecordingConfig struct {
	Enabled bool `mapstructure:"enabled"`
	// Dir is where .dtr recordings are written. Empty = <sessions_dir>/desktop-recordings.
	Dir string `mapstructure:"dir"`
	// IncludeInput records keyboard / mouse / clipboard events into the audit
	// timeline alongside the screen frames. Keystrokes may contain secrets, so
	// the recordings inherit the same PermSessionRead gate as every other
	// recording — but operators can disable input capture here.
	IncludeInput bool `mapstructure:"include_input"`
}

// DevolutionsGatewayConfig parameterises the Devolutions Gateway
// subprocess supervisor + JWT signer. See
//   https://github.com/Devolutions/devolutions-gateway/blob/master/docs/COOKBOOK.md
// for the upstream config shape this code generates.
type DevolutionsGatewayConfig struct {
	// Enabled gates the entire ironrdp path. When false the backend is
	// unavailable and the manager refuses sessions that request it.
	Enabled bool `mapstructure:"enabled"`
	// AutoInstall runs scripts/install-devolutions-gateway-*.{sh,ps1}
	// at startup when BinaryPath is missing. Default true so the first
	// gateway boot on a fresh host "just works".
	AutoInstall bool `mapstructure:"auto_install"`
	// AutoStart spawns the gateway binary as a child of this process.
	// Disable when running the gateway under systemd / Windows service
	// / container — in that mode we only manage config + JWT signing.
	AutoStart bool `mapstructure:"auto_start"`
	// InstallPrefix is the directory the install script drops the
	// binary into and where the supervisor expects to find it (unless
	// BinaryPath overrides). Default: /opt/wayfort/devolutions-gateway
	// on Linux, %LOCALAPPDATA%\Programs\Wayfort\devolutions-gateway
	// on Windows.
	InstallPrefix string `mapstructure:"install_prefix"`
	// BinaryPath is the absolute path to the gateway executable.
	// Empty = derive from InstallPrefix + platform-specific name.
	BinaryPath string `mapstructure:"binary_path"`
	// ConfigPath is where the supervisor writes the generated
	// devolutions-gateway.json each time it spawns the subprocess.
	// Empty = <InstallPrefix>/config/gateway.json
	ConfigPath string `mapstructure:"config_path"`
	// IDFile persists the gateway's stable UUID across restarts so log
	// correlation upstream remains consistent. Empty = <InstallPrefix>/config/gateway-id
	IDFile string `mapstructure:"id_file"`
	// ListenAddr is what the gateway subprocess binds. Internal-only —
	// the browser uses AdvertisedURL.
	ListenAddr string `mapstructure:"listen_addr"`
	// AdvertisedURL is the WebSocket URL handed to the browser when it
	// starts a session. Typically a wss://… URL once the reverse proxy
	// terminates TLS. Empty = derived from ListenAddr.
	AdvertisedURL string `mapstructure:"advertised_url"`
	// ExternalURL is the gateway's own public-face URL (HTTP/HTTPS) that
	// it bakes into its config and uses for callbacks. Devolutions
	// Gateway rejects the config outright when this field is missing,
	// hence it's plumbed through here. Empty = same as ListenAddr (fine
	// for single-host loopback deploys; reverse-proxy fronting sets
	// e.g. "https://wayfort.example.com").
	ExternalURL string `mapstructure:"external_url"`
	// JWTPrivateKeyFile holds the RS256 private key the signer uses to
	// mint pre-auth tokens. Generated on first run if missing.
	JWTPrivateKeyFile string `mapstructure:"jwt_private_key_file"`
	// TokenTTL caps how long an issued JWT stays valid. Default 90s.
	TokenTTL time.Duration `mapstructure:"token_ttl"`
	// HealthTimeout is how long Ensure() will wait for the gateway's
	// /jet/health endpoint after spawning. Default 15s.
	HealthTimeout time.Duration `mapstructure:"health_timeout"`
	// Verbosity is passed through to the gateway's `Verbosity` config
	// (warn/info/debug/trace). Default "info".
	Verbosity string `mapstructure:"verbosity"`
}

type AIConfig struct {
	Enabled               bool          `mapstructure:"enabled"`
	DefaultPermissionMode string        `mapstructure:"default_permission_mode"`
	MaxIterations         int           `mapstructure:"max_iterations"`
	MaxSubAgentDepth      int           `mapstructure:"max_subagent_depth"`
	ToolTimeout           time.Duration `mapstructure:"tool_timeout"`
	ApprovalTimeout       time.Duration `mapstructure:"approval_timeout"`
	SSHExecReadOnlyAllow  []string      `mapstructure:"ssh_exec_readonly_allow"`
	SSHExecReadOnlyExtra  []string      `mapstructure:"ssh_exec_readonly_allow_extra"`
	ConversationTTLDays   int           `mapstructure:"conversation_ttl_days"`
	SeedDefaultAgents     bool          `mapstructure:"seed_default_agents"`
	// Background provider health probing (opt-in: pinging upstream providers on a
	// schedule consumes real quota). HealthProbeModels additionally calls
	// ListModels each cycle for a model count (off by default — extra round-trip).
	HealthProbeEnabled  bool          `mapstructure:"health_probe_enabled"`
	HealthProbeInterval time.Duration `mapstructure:"health_probe_interval"`
	HealthProbeTimeout  time.Duration `mapstructure:"health_probe_timeout"`
	HealthProbeModels   bool          `mapstructure:"health_probe_models"`
	HealthDegradedMS    int64         `mapstructure:"health_degraded_ms"`

	// Knowledge base (RAG) + long-term memory. Embeddings reuse a designated
	// provider (Anthropic has no embeddings API, so chat-on-Anthropic deploys
	// must point these at an OpenAI/Gemini/compatible provider).
	EmbeddingProviderID uint64 `mapstructure:"embedding_provider_id"` // 0 = auto-pick a global provider
	EmbeddingModel      string `mapstructure:"embedding_model"`
	EmbeddingDimensions int    `mapstructure:"embedding_dimensions"` // 0 = model default
	ChunkTokens         int    `mapstructure:"chunk_tokens"`         // default 512
	ChunkOverlap        int    `mapstructure:"chunk_overlap"`        // default 64
	EmbedBatchSize      int    `mapstructure:"embed_batch_size"`     // default 64
	RAGTopK             int    `mapstructure:"rag_top_k"`            // default 5
	MemoryEnabled       bool   `mapstructure:"memory_enabled"`       // default true
	MemoryRecallK       int    `mapstructure:"memory_recall_k"`      // default 8
	DistillationEnabled bool   `mapstructure:"distillation_enabled"` // default false
	FallbackMaxChunks   int    `mapstructure:"fallback_max_chunks"`  // cap for in-app cosine; default 5000
}

// ProtocolsConfig holds knobs for every non-SSH protocol the gateway brokers.
type ProtocolsConfig struct {
	Guacamole GuacamoleConfig `mapstructure:"guacamole"`
	DBCLI     DBCLIConfig     `mapstructure:"dbcli"`
	TCPFwd    TCPFwdConfig    `mapstructure:"tcpfwd"`
	Telnet    TelnetConfig    `mapstructure:"telnet"`
}

type GuacamoleConfig struct {
	Enabled         bool   `mapstructure:"enabled"`
	GuacdAddr       string `mapstructure:"guacd_addr"`
	Recording       bool   `mapstructure:"recording"`
	SOCKSListenHost string `mapstructure:"socks_listen_host"`
	// RecordingPathInGuacd is what the guacd container sees for the sessions
	// directory; defaults to the host's sessions_dir when running side-by-side.
	RecordingPathInGuacd string `mapstructure:"recording_path_in_guacd"`
}

type DBCLIConfig struct {
	Enabled bool              `mapstructure:"enabled"`
	Images  map[string]string `mapstructure:"images"`
	TTL     time.Duration     `mapstructure:"ttl"`
}

type TCPFwdConfig struct {
	Enabled    bool          `mapstructure:"enabled"`
	ListenHost string        `mapstructure:"listen_host"`
	PortRange  [2]int        `mapstructure:"port_range"`
	DefaultTTL time.Duration `mapstructure:"default_ttl"`
	MaxPerUser int           `mapstructure:"max_per_user"`
}

type TelnetConfig struct {
	Enabled bool          `mapstructure:"enabled"`
	Timeout time.Duration `mapstructure:"timeout"`
}

type ServerConfig struct {
	Addr            string        `mapstructure:"addr"`
	ReadTimeout     time.Duration `mapstructure:"read_timeout"`
	WriteTimeout    time.Duration `mapstructure:"write_timeout"`
	ShutdownTimeout time.Duration `mapstructure:"shutdown_timeout"`
}

type DBConfig struct {
	DSN             string        `mapstructure:"dsn"`
	MaxOpen         int           `mapstructure:"max_open"`
	MaxIdle         int           `mapstructure:"max_idle"`
	ConnMaxLifetime time.Duration `mapstructure:"conn_max_lifetime"`
}

type RedisConfig struct {
	Addr     string `mapstructure:"addr"`
	Password string `mapstructure:"password"`
	DB       int    `mapstructure:"db"`
}

type AuthConfig struct {
	JWTSecret         string        `mapstructure:"jwt_secret"`
	AccessTTL         time.Duration `mapstructure:"access_ttl"`
	RefreshTTL        time.Duration `mapstructure:"refresh_ttl"`
	BootstrapAdmin    string        `mapstructure:"bootstrap_admin"`
	BootstrapPassword string        `mapstructure:"bootstrap_password"`
	Lockout           LockoutConfig `mapstructure:"lockout"`
	MFA               MFAConfig     `mapstructure:"mfa"`
	Passkey           PasskeyConfig `mapstructure:"passkey"`
	Anomaly           AnomalyConfig `mapstructure:"anomaly"`
}

type LockoutConfig struct {
	Enabled   bool          `mapstructure:"enabled"`
	Threshold int           `mapstructure:"threshold"`
	Window    time.Duration `mapstructure:"window"`
	Duration  time.Duration `mapstructure:"duration"`
}

type MFAConfig struct {
	EnforceForAdmin    bool          `mapstructure:"enforce_for_admin"`
	TOTPIssuer         string        `mapstructure:"totp_issuer"`
	EmailOTPTTL        time.Duration `mapstructure:"email_otp_ttl"`
	EmailOTPCooldown   time.Duration `mapstructure:"email_otp_cooldown"`
	RecoveryCodesCount int           `mapstructure:"recovery_codes_count"`
}

type PasskeyConfig struct {
	Enabled           bool     `mapstructure:"enabled"`
	RPID              string   `mapstructure:"rp_id"`
	RPDisplay         string   `mapstructure:"rp_display"`
	Origins           []string `mapstructure:"rp_origins"`
	DiscoverableLogin bool     `mapstructure:"discoverable_login"`
}

// AnomalyConfig tunes the login anomaly detector. The detector compares each
// successful login against the user's recent history across several signals (new
// IP / country / ASN / device + impossible travel), assigns a 0–100 risk score,
// and flags the login when the score crosses ScoreThreshold (or on an
// always-critical signal like impossible travel). Failed-login bursts are scored
// separately for brute-force / credential-stuffing alerting.
type AnomalyConfig struct {
	Enabled     bool `mapstructure:"enabled"`
	NotifyEmail bool `mapstructure:"notify_email"` // email the affected user on an anomalous login
	// NotifyAdmins also routes anomaly + brute-force alerts to the security team
	// (holders of security:manage / audit:read / system:admin) via in-app
	// notifications and, when an email channel exists, email.
	NotifyAdmins bool `mapstructure:"notify_admins"`
	// ScoreThreshold is the minimum risk score (0–100) that flags a login as
	// anomalous. Default 50.
	ScoreThreshold int `mapstructure:"score_threshold"`
	// HistoryWindow is how many recent successful logins to compare against.
	// Default 30.
	HistoryWindow int `mapstructure:"history_window"`
	// ImpossibleTravelKmh is the ground speed above which the gap between two
	// consecutive logins is physically implausible (always flagged). Default 900
	// (roughly a jet airliner); 0 disables the rule.
	ImpossibleTravelKmh float64 `mapstructure:"impossible_travel_kmh"`
	// BruteForceThreshold is the number of failed attempts (per username or IP)
	// within BruteForceWindow that raises a brute-force alert. Default 8.
	BruteForceThreshold int `mapstructure:"brute_force_threshold"`
	// BruteForceWindow bounds the failed-attempt count. Default 10m.
	BruteForceWindow time.Duration `mapstructure:"brute_force_window"`
}

type NotifyConfig struct {
	SMTP   SMTPConfig         `mapstructure:"smtp"`
	Worker NotifyWorkerConfig `mapstructure:"worker"`
}

type SMTPConfig struct {
	Host     string `mapstructure:"host"`
	Port     int    `mapstructure:"port"`
	Username string `mapstructure:"username"`
	Password string `mapstructure:"password"`
	From     string `mapstructure:"from"`
	TLS      string `mapstructure:"tls"`
}

type NotifyWorkerConfig struct {
	ChanSize   int `mapstructure:"chan_size"`
	MaxRetries int `mapstructure:"max_retries"`
}

type CryptoConfig struct {
	// MasterKeyHex is the legacy fixed AES-256 master key. Pre-Phase-14
	// installations stored every credential row's ciphertext under this
	// single key.
	//
	// Phase 14 moved credential pool encryption to KMS-managed envelope
	// encryption: a fresh per-row DEK wrapped by a KEK kept in Vault /
	// OpenBao / AWS / Azure / GCP KMS (see kms_providers table). The
	// master key no longer participates in any new ciphertext.
	//
	// This field is retained ONLY as a one-shot migration aid: when set,
	// the boot sequence wires up a read-only legacy Sealer that the
	// envelope vault can fall back to for opening pre-Phase-14 byte
	// layouts. Once a deployment has rewrapped every legacy row, the
	// operator deletes this field from the YAML.
	//
	// New installs leave this empty.
	MasterKeyHex string `mapstructure:"master_key_hex"`

	// UnsealPassphraseFile is the path to a single-line 0600 file
	// holding the bootstrap passphrase that unwraps KMS auth
	// ciphertexts at startup. Defaults to "./var/keystore.unseal".
	//
	// The passphrase NEVER appears in the YAML, in env vars, or in
	// argv — it lives at this path on disk under filesystem
	// permissions. Operators who need stronger guarantees can mount
	// the file from a hardware keystore or a systemd-credential.
	UnsealPassphraseFile string `mapstructure:"unseal_passphrase_file"`
}

type StorageConfig struct {
	SessionsDir string `mapstructure:"sessions_dir"`
}

type SSHPoolConfig struct {
	MaxSessionsPerClient int           `mapstructure:"max_sessions_per_client"`
	IdleEviction         time.Duration `mapstructure:"idle_eviction"`
	DialTimeout          time.Duration `mapstructure:"dial_timeout"`
	Keepalive            time.Duration `mapstructure:"keepalive"`
}

type AnonymousConfig struct {
	Enabled   bool          `mapstructure:"enabled"`
	Image     string        `mapstructure:"image"`
	TTL       time.Duration `mapstructure:"ttl"`
	CPU       float64       `mapstructure:"cpu"`
	MemoryMB  int64         `mapstructure:"memory_mb"`
	PidsLimit int64         `mapstructure:"pids_limit"`
	Network   string        `mapstructure:"network"`
	Shell     []string      `mapstructure:"shell"`
}

type RecorderConfig struct {
	ChanSize      int           `mapstructure:"chan_size"`
	FlushInterval time.Duration `mapstructure:"flush_interval"`
}

type AuditConfig struct {
	ChanSize      int           `mapstructure:"chan_size"`
	BatchSize     int           `mapstructure:"batch_size"`
	BatchInterval time.Duration `mapstructure:"batch_interval"`
	// BatchTimeout bounds each batch insert. Generous by default so a cold
	// dev Postgres (container still warming up its connection pool) doesn't
	// trip "context deadline exceeded" on the first few flushes.
	BatchTimeout time.Duration `mapstructure:"batch_timeout"`
	// InstanceID pins this gateway's tamper-evidence audit chain id
	// (security-architecture.md §5.2). Empty → a random id per process (a fresh
	// chain each run). Set a stable per-instance value in an HA deployment so a
	// restart continues the same chain.
	InstanceID string `mapstructure:"instance_id"`
	// Export ships audit events to external SIEM/alerting sinks (§10).
	Export AuditExportConfig `mapstructure:"export"`
}

// AuditExportConfig configures the external-audit fan-out (§10): CEF over
// syslog and/or a signed webhook. Both disabled by default.
type AuditExportConfig struct {
	QueueSize int `mapstructure:"queue_size"` // per-sink backlog; default 1024
	Syslog    struct {
		Enabled     bool   `mapstructure:"enabled"`
		Addr        string `mapstructure:"addr"` // host:port
		TLS         bool   `mapstructure:"tls"`
		InsecureTLS bool   `mapstructure:"insecure_tls"`
	} `mapstructure:"syslog"`
	Webhook struct {
		Enabled bool   `mapstructure:"enabled"`
		URL     string `mapstructure:"url"`
		Secret  string `mapstructure:"secret"` // HMAC-SHA256 key
	} `mapstructure:"webhook"`
}

type WebSSHConfig struct {
	ReadBuffer   int           `mapstructure:"read_buffer"`
	WriteTimeout time.Duration `mapstructure:"write_timeout"`
	PingInterval time.Duration `mapstructure:"ping_interval"`
}

// Load reads configuration from the given path. If path is empty, it looks for
// configs/config.yaml relative to the working directory. Environment variables
// prefixed with WAYFORT_ override file values (e.g. WAYFORT_DB_DSN).
func Load(path string) (*Config, error) {
	v := viper.New()
	v.SetEnvPrefix("WAYFORT")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()
	if path != "" {
		v.SetConfigFile(path)
	} else {
		v.SetConfigName("config")
		v.SetConfigType("yaml")
		v.AddConfigPath("./configs")
		v.AddConfigPath(".")
	}
	setDefaults(v)
	if err := v.ReadInConfig(); err != nil {
		if _, ok := err.(viper.ConfigFileNotFoundError); !ok {
			return nil, fmt.Errorf("read config: %w", err)
		}
	}
	var c Config
	if err := v.Unmarshal(&c); err != nil {
		return nil, fmt.Errorf("unmarshal config: %w", err)
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func setDefaults(v *viper.Viper) {
	v.SetDefault("server.addr", ":8080")
	v.SetDefault("server.read_timeout", 30*time.Second)
	v.SetDefault("server.write_timeout", 30*time.Second)
	v.SetDefault("server.shutdown_timeout", 10*time.Second)
	v.SetDefault("db.max_open", 50)
	v.SetDefault("db.max_idle", 10)
	v.SetDefault("db.conn_max_lifetime", time.Hour)
	v.SetDefault("auth.access_ttl", time.Hour)
	v.SetDefault("auth.refresh_ttl", 7*24*time.Hour)
	v.SetDefault("auth.lockout.enabled", true)
	v.SetDefault("auth.lockout.threshold", 5)
	v.SetDefault("auth.lockout.window", 15*time.Minute)
	v.SetDefault("auth.lockout.duration", 15*time.Minute)
	v.SetDefault("auth.mfa.totp_issuer", "Wayfort")
	v.SetDefault("auth.mfa.email_otp_ttl", 5*time.Minute)
	v.SetDefault("auth.mfa.email_otp_cooldown", 60*time.Second)
	v.SetDefault("auth.mfa.recovery_codes_count", 10)
	v.SetDefault("auth.passkey.enabled", false)
	v.SetDefault("auth.passkey.discoverable_login", true)
	v.SetDefault("auth.anomaly.enabled", true)
	v.SetDefault("auth.anomaly.notify_email", false)
	v.SetDefault("auth.anomaly.notify_admins", true)
	v.SetDefault("auth.anomaly.score_threshold", 50)
	v.SetDefault("auth.anomaly.history_window", 30)
	v.SetDefault("auth.anomaly.impossible_travel_kmh", 900.0)
	v.SetDefault("auth.anomaly.brute_force_threshold", 8)
	v.SetDefault("auth.anomaly.brute_force_window", 10*time.Minute)

	// GeoIP — IP→location for login history + anomaly geo rules. Lookups on by
	// default (served from a local .mmdb if present; degrades to no-geo if not).
	// Auto-update OFF by default (no surprise egress on a fresh/air-gapped boot);
	// the keyless monthly db-ip "lite" sources are pre-filled so flipping
	// auto_update on — or calling the admin "update now" endpoint — just works.
	v.SetDefault("geoip.enabled", true)
	v.SetDefault("geoip.db_path", "./var/geoip/city.mmdb")
	v.SetDefault("geoip.asn_db_path", "./var/geoip/asn.mmdb")
	v.SetDefault("geoip.auto_update", false)
	v.SetDefault("geoip.update_url", "https://download.db-ip.com/free/dbip-city-lite-{year}-{month}.mmdb.gz")
	v.SetDefault("geoip.asn_update_url", "https://download.db-ip.com/free/dbip-asn-lite-{year}-{month}.mmdb.gz")
	v.SetDefault("geoip.update_interval", 168*time.Hour)
	v.SetDefault("geoip.download_timeout", 2*time.Minute)
	v.SetDefault("geoip.language", "zh-CN")
	v.SetDefault("geoip.allow_private_url", false)
	// Break-glass (应急访问) — enabled so the approver-mediated path works out of
	// the box; self-service fail-open stays OFF globally until an operator opts
	// in (defense in depth: per-policy opt-in is AND-ed with this gate).
	v.SetDefault("break_glass.enabled", true)
	v.SetDefault("break_glass.allow_fail_open", false)
	v.SetDefault("break_glass.max_duration", 30*time.Minute)
	v.SetDefault("break_glass.require_review", true)
	// Edition / licensing — no license by default (Community). Operators point
	// these at a license token / file for air-gapped pinning; the admin UI install
	// path (DB-stored) takes precedence over both.
	v.SetDefault("edition.license", "")
	v.SetDefault("edition.license_file", "")
	v.SetDefault("notify.worker.chan_size", 256)
	v.SetDefault("notify.worker.max_retries", 3)
	v.SetDefault("notify.smtp.tls", "starttls")
	v.SetDefault("notify.smtp.port", 587)
	v.SetDefault("ai.enabled", true)
	v.SetDefault("ai.default_permission_mode", "normal")
	v.SetDefault("ai.max_iterations", 20)
	v.SetDefault("ai.max_subagent_depth", 2)
	v.SetDefault("ai.tool_timeout", 60*time.Second)
	v.SetDefault("ai.approval_timeout", 2*time.Minute)
	v.SetDefault("ai.conversation_ttl_days", 90)
	v.SetDefault("ai.seed_default_agents", true)
	// Knowledge base (RAG) + long-term memory.
	v.SetDefault("ai.chunk_tokens", 512)
	v.SetDefault("ai.chunk_overlap", 64)
	v.SetDefault("ai.embed_batch_size", 64)
	v.SetDefault("ai.rag_top_k", 5)
	v.SetDefault("ai.memory_enabled", true)
	v.SetDefault("ai.memory_recall_k", 8)
	v.SetDefault("ai.distillation_enabled", false)
	v.SetDefault("ai.fallback_max_chunks", 5000)
	v.SetDefault("storage.sessions_dir", "./var/sessions")
	// Phase 14 — KMS bootstrap unseal passphrase lives at this path
	// by default. The file must exist (0600 permissions) and contain
	// a single non-empty line. Set the value via /api/v1/setup/seal
	// on the very first boot; subsequent boots just read it.
	v.SetDefault("crypto.unseal_passphrase_file", "./var/keystore.unseal")
	v.SetDefault("health.enabled", true)
	v.SetDefault("health.interval", 30*time.Second)
	v.SetDefault("health.timeout", 5*time.Second)
	v.SetDefault("health.concurrency", 8)
	v.SetDefault("health.degraded_ms", 800)
	v.SetDefault("health.probe_target", "")
	v.SetDefault("sshpool.max_sessions_per_client", 8)
	v.SetDefault("sshpool.idle_eviction", 10*time.Minute)
	v.SetDefault("sshpool.dial_timeout", 15*time.Second)
	v.SetDefault("sshpool.keepalive", 30*time.Second)
	v.SetDefault("anonymous.image", "alpine:latest")
	v.SetDefault("anonymous.ttl", 10*time.Minute)
	v.SetDefault("anonymous.cpu", 0.5)
	v.SetDefault("anonymous.memory_mb", 128)
	v.SetDefault("anonymous.pids_limit", 64)
	v.SetDefault("anonymous.network", "none")
	v.SetDefault("anonymous.shell", []string{"/bin/sh"})
	v.SetDefault("recorder.chan_size", 1024)
	v.SetDefault("recorder.flush_interval", 250*time.Millisecond)
	v.SetDefault("audit.chan_size", 4096)
	v.SetDefault("audit.batch_size", 64)
	v.SetDefault("audit.batch_interval", 200*time.Millisecond)
	v.SetDefault("webssh.read_buffer", 8192)
	v.SetDefault("webssh.write_timeout", 10*time.Second)
	v.SetDefault("webssh.ping_interval", 30*time.Second)

	// Anti-leak watermark — on by default so a fresh deploy is traceable.
	// Default content lays out name / masked email / ip + live datetime; the
	// 45° diagonal tiling and forensic blind layer are all enabled out of the
	// box. Super-admins tune everything from /admin/settings → 界面水印.
	v.SetDefault("watermark.enabled", true)
	v.SetDefault("watermark.scope", "all")
	v.SetDefault("watermark.content", "{name}\n{email}\n{ip}  {datetime}")
	v.SetDefault("watermark.opacity", 16)
	v.SetDefault("watermark.font_size", 15)
	v.SetDefault("watermark.font_color", "#141413")
	v.SetDefault("watermark.rotation", -45)
	v.SetDefault("watermark.gap_x", 240)
	v.SetDefault("watermark.gap_y", 180)
	v.SetDefault("watermark.anti_tamper", true)
	v.SetDefault("watermark.hardened", true)
	v.SetDefault("watermark.blind_enabled", true)
	v.SetDefault("watermark.blind_content", "")
	v.SetDefault("watermark.live_clock", true)
	v.SetDefault("watermark.refresh_sec", 60)

	// Plan 14 — live system insights are read-only and gated by
	// asset.ActionConnect, so they're on by default. Operators who need to
	// hide the dashboard from the SSH page can set `insights.enabled: false`
	// in their YAML.
	v.SetDefault("insights.enabled", true)
	v.SetDefault("insights.cache_ttl", 3*time.Second)
	v.SetDefault("insights.ssh_timeout", 10*time.Second)
	v.SetDefault("insights.process_limit", 200)

	// Desktop subsystem — workspace-v2 "rdp_next" protocol. Operators
	// build the freerdp-worker binary explicitly via
	// scripts/build-worker-*.{sh,ps1} (see scripts/README.md). The
	// gateway only searches standard install paths at startup.
	v.SetDefault("desktop.enabled", true)
	v.SetDefault("desktop.default_backend", "freerdp")
	v.SetDefault("desktop.worker_path", "")
	v.SetDefault("desktop.worker_idle_timeout", 5*time.Minute)
	v.SetDefault("desktop.max_concurrent_sessions", 64)
	// Deprecated: runtime auto-install was removed in favour of explicit
	// pre-build scripts. Field kept for yaml backward compatibility — if
	// set to true the gateway logs a one-time deprecation notice at
	// startup and otherwise ignores it. Remove from new configs.
	v.SetDefault("desktop.auto_install", false)
	v.SetDefault("desktop.install_prefix", "")
	v.SetDefault("desktop.recording.enabled", true)
	v.SetDefault("desktop.recording.dir", "")
	v.SetDefault("desktop.recording.include_input", true)
	v.SetDefault("desktop.drive.enabled", true)
	v.SetDefault("desktop.drive.dir", "")
	v.SetDefault("desktop.drive.name", "Wayfort")
	v.SetDefault("desktop.drive.allow_upload", true)
	v.SetDefault("desktop.drive.allow_download", true)
	v.SetDefault("desktop.drive.max_file_mb", 1024)
	v.SetDefault("desktop.drive.max_total_mb", 4096)
	// WebRTC video path. On by default; needs a WebRTC-capable browser and the
	// freerdp backend. ICE host-only by default — add stun/turn/public_ip for
	// cross-NAT. Bitrate/fps 0 → worker defaults (8000 kbps / 30 fps).
	v.SetDefault("desktop.webrtc.enabled", true)
	v.SetDefault("desktop.webrtc.codec", "vp9")
	v.SetDefault("desktop.webrtc.bitrate_kbps", 8000)
	v.SetDefault("desktop.webrtc.fps", 30)
	v.SetDefault("desktop.webrtc.stun_urls", []string{})
	v.SetDefault("desktop.webrtc.turn_url", "")
	v.SetDefault("desktop.webrtc.turn_username", "")
	v.SetDefault("desktop.webrtc.turn_password", "")
	v.SetDefault("desktop.webrtc.public_ip", "")
	v.SetDefault("desktop.webrtc.udp_port_min", 0)
	v.SetDefault("desktop.webrtc.udp_port_max", 0)

	// Plan 29 — ironrdp backend via Devolutions Gateway subprocess.
	// Defaults are tuned for a single-host deploy where the gateway
	// listens on loopback and our reverse proxy forwards /jet/* to it
	// (or the browser hits it directly if no proxy is in front).
	v.SetDefault("desktop.devolutions_gateway.enabled", false)
	v.SetDefault("desktop.devolutions_gateway.auto_install", true)
	v.SetDefault("desktop.devolutions_gateway.auto_start", true)
	v.SetDefault("desktop.devolutions_gateway.listen_addr", "http://127.0.0.1:7171")
	v.SetDefault("desktop.devolutions_gateway.advertised_url", "")
	v.SetDefault("desktop.devolutions_gateway.external_url", "")
	v.SetDefault("desktop.devolutions_gateway.install_prefix", "")
	v.SetDefault("desktop.devolutions_gateway.binary_path", "")
	v.SetDefault("desktop.devolutions_gateway.config_path", "")
	v.SetDefault("desktop.devolutions_gateway.id_file", "")
	v.SetDefault("desktop.devolutions_gateway.jwt_private_key_file", "")
	v.SetDefault("desktop.devolutions_gateway.token_ttl", 90*time.Second)
	v.SetDefault("desktop.devolutions_gateway.health_timeout", 15*time.Second)
	v.SetDefault("desktop.devolutions_gateway.verbosity", "info")

	v.SetDefault("protocols.guacamole.enabled", false)
	v.SetDefault("protocols.guacamole.guacd_addr", "127.0.0.1:4822")
	v.SetDefault("protocols.guacamole.recording", true)
	v.SetDefault("protocols.guacamole.socks_listen_host", "127.0.0.1")
	v.SetDefault("protocols.dbcli.enabled", false)
	v.SetDefault("protocols.dbcli.images", map[string]string{
		"mysql":    "mysql:8.0",
		"postgres": "postgres:16-alpine",
		"redis":    "redis:7-alpine",
		"mongo":    "mongo:7",
	})
	v.SetDefault("protocols.dbcli.ttl", 30*time.Minute)
	v.SetDefault("protocols.tcpfwd.enabled", true)
	v.SetDefault("protocols.tcpfwd.listen_host", "127.0.0.1")
	v.SetDefault("protocols.tcpfwd.port_range", []int{40000, 49999})
	v.SetDefault("protocols.tcpfwd.default_ttl", time.Hour)
	v.SetDefault("protocols.tcpfwd.max_per_user", 8)
	v.SetDefault("protocols.telnet.enabled", true)
	v.SetDefault("protocols.telnet.timeout", 15*time.Second)
}

func (c *Config) validate() error {
	if c.Auth.JWTSecret == "" || len(c.Auth.JWTSecret) < 16 {
		return fmt.Errorf("auth.jwt_secret must be at least 16 bytes")
	}
	// Phase 14: master_key_hex is now legacy / migration-only. When
	// present it must still be a valid 32-byte hex; when absent we
	// rely entirely on the DB-stored KMS provider config.
	if c.Crypto.MasterKeyHex != "" && len(c.Crypto.MasterKeyHex) != 64 {
		return fmt.Errorf("crypto.master_key_hex must be 64 hex chars (32 bytes) when set; leave empty for new installs")
	}
	if c.DB.DSN == "" {
		return fmt.Errorf("db.dsn is required")
	}
	return nil
}
