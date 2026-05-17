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
}

type CryptoConfig struct {
	MasterKeyHex string `mapstructure:"master_key_hex"`
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
	v.SetDefault("storage.sessions_dir", "./var/sessions")
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
}

func (c *Config) validate() error {
	if c.Auth.JWTSecret == "" || len(c.Auth.JWTSecret) < 16 {
		return fmt.Errorf("auth.jwt_secret must be at least 16 bytes")
	}
	if c.Crypto.MasterKeyHex == "" {
		return fmt.Errorf("crypto.master_key_hex is required")
	}
	if len(c.Crypto.MasterKeyHex) != 64 {
		return fmt.Errorf("crypto.master_key_hex must be 64 hex chars (32 bytes)")
	}
	if c.DB.DSN == "" {
		return fmt.Errorf("db.dsn is required")
	}
	return nil
}
