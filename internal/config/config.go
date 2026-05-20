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
	RetentionMode string `mapstructure:"retention_mode"`
	RetentionDays int    `mapstructure:"retention_days"`
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
	// BinaryPath overrides). Default: /opt/jumpserver/devolutions-gateway
	// on Linux, %LOCALAPPDATA%\Programs\JumpServer\devolutions-gateway
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
	// e.g. "https://jumpserver.example.com").
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
	JWTSecret         string         `mapstructure:"jwt_secret"`
	AccessTTL         time.Duration  `mapstructure:"access_ttl"`
	RefreshTTL        time.Duration  `mapstructure:"refresh_ttl"`
	BootstrapAdmin    string         `mapstructure:"bootstrap_admin"`
	BootstrapPassword string         `mapstructure:"bootstrap_password"`
	Lockout           LockoutConfig  `mapstructure:"lockout"`
	MFA               MFAConfig      `mapstructure:"mfa"`
	Passkey           PasskeyConfig  `mapstructure:"passkey"`
	Anomaly           AnomalyConfig  `mapstructure:"anomaly"`
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
	Enabled            bool     `mapstructure:"enabled"`
	RPID               string   `mapstructure:"rp_id"`
	RPDisplay          string   `mapstructure:"rp_display"`
	Origins            []string `mapstructure:"rp_origins"`
	DiscoverableLogin  bool     `mapstructure:"discoverable_login"`
}

type AnomalyConfig struct {
	Enabled     bool `mapstructure:"enabled"`
	NotifyEmail bool `mapstructure:"notify_email"`
}

type NotifyConfig struct {
	SMTP   SMTPConfig          `mapstructure:"smtp"`
	Worker NotifyWorkerConfig  `mapstructure:"worker"`
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
}

type WebSSHConfig struct {
	ReadBuffer   int           `mapstructure:"read_buffer"`
	WriteTimeout time.Duration `mapstructure:"write_timeout"`
	PingInterval time.Duration `mapstructure:"ping_interval"`
}

// Load reads configuration from the given path. If path is empty, it looks for
// configs/config.yaml relative to the working directory. Environment variables
// prefixed with JUMPSERVER_ override file values (e.g. JUMPSERVER_DB_DSN).
func Load(path string) (*Config, error) {
	v := viper.New()
	v.SetEnvPrefix("JUMPSERVER")
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
	v.SetDefault("auth.mfa.totp_issuer", "JumpServer")
	v.SetDefault("auth.mfa.email_otp_ttl", 5*time.Minute)
	v.SetDefault("auth.mfa.email_otp_cooldown", 60*time.Second)
	v.SetDefault("auth.mfa.recovery_codes_count", 10)
	v.SetDefault("auth.passkey.enabled", false)
	v.SetDefault("auth.passkey.discoverable_login", true)
	v.SetDefault("auth.anomaly.enabled", true)
	v.SetDefault("auth.anomaly.notify_email", false)
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
	v.SetDefault("storage.sessions_dir", "./var/sessions")
	// Phase 14 — KMS bootstrap unseal passphrase lives at this path
	// by default. The file must exist (0600 permissions) and contain
	// a single non-empty line. Set the value via /api/v1/setup/seal
	// on the very first boot; subsequent boots just read it.
	v.SetDefault("crypto.unseal_passphrase_file", "./var/keystore.unseal")
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
