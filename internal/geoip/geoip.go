// Package geoip resolves an IP address to a coarse physical location (country /
// region / city / coordinates) and, when an ASN database is present, the owning
// autonomous system. It backs the login-history "where from" column and the
// anomaly detector's new-country / impossible-travel rules.
//
// The lookup is served from a MaxMind-format .mmdb database held entirely in
// memory (geoip2.FromBytes) so the on-disk file is never kept open — that lets
// the background auto-updater (update.go) atomically replace the file and
// hot-swap the in-memory reader without a restart, even on Windows where an
// open file can't be renamed over.
//
// Everything is nil-safe and degrades cleanly: with no database loaded Lookup
// returns just the IP (and a Private flag for RFC1918 / loopback addresses), so
// the rest of the system keeps working in air-gapped deployments that never
// stage a database.
package geoip

import (
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/oschwald/geoip2-golang"
	"go.uber.org/zap"
)

// Config mirrors config.GeoIPConfig (kept as its own type so the package has no
// dependency on internal/config). Construct it in main.go from the snapshot.
type Config struct {
	Enabled         bool
	DBPath          string        // city/country .mmdb path
	ASNDBPath       string        // optional ASN .mmdb path
	AutoUpdate      bool          // download + refresh the file on a schedule
	UpdateURL       string        // city db source; supports {year}/{month} templating; .mmdb/.gz/.tar.gz
	ASNUpdateURL    string        // ASN db source (same templating + formats)
	UpdateInterval  time.Duration // staleness threshold + check cadence
	DownloadTimeout time.Duration // per-download HTTP timeout
	Language        string        // preferred place-name language, e.g. "zh-CN"
	// AllowPrivateURL permits downloading the database from a private / loopback /
	// link-local address. Default false: an SSRF guard blocks such destinations
	// (the URL is operator-tunable, so a hostile/mistaken value can't probe
	// internal services like cloud metadata). Set true ONLY to use a legitimate
	// internal GeoIP mirror (common in air-gapped deployments).
	AllowPrivateURL bool
}

// Location is the resolved lookup result. All fields are best-effort: an empty
// Country means the database had no entry (or none is loaded).
type Location struct {
	IP         string  `json:"ip"`
	Country    string  `json:"country,omitempty"`     // localized country name
	CountryISO string  `json:"country_iso,omitempty"` // ISO 3166-1 alpha-2
	Region     string  `json:"region,omitempty"`      // top-level subdivision (province/state)
	City       string  `json:"city,omitempty"`
	Latitude   float64 `json:"latitude,omitempty"`
	Longitude  float64 `json:"longitude,omitempty"`
	ASN        uint    `json:"asn,omitempty"`
	ASNOrg     string  `json:"asn_org,omitempty"`
	Private    bool    `json:"private,omitempty"` // RFC1918 / loopback / link-local — no public geo
}

// HasGeo reports whether a usable public geolocation was resolved (a country or
// coordinates). Private/loopback addresses and unresolved lookups return false.
func (l Location) HasGeo() bool {
	return !l.Private && (l.CountryISO != "" || l.Latitude != 0 || l.Longitude != 0)
}

// Service owns the in-memory readers and the auto-update worker.
type Service struct {
	mu     sync.RWMutex
	cfg    Config
	logger *zap.Logger

	city atomic.Pointer[geoip2.Reader]
	asn  atomic.Pointer[geoip2.Reader]

	status   atomic.Pointer[Status]
	updating atomic.Bool // guards against overlapping refreshes

	// httpClient downloads database files; its dialer Control enforces the SSRF
	// guard. allowPrivate (consulted live by Control) relaxes it for an internal
	// mirror without rebuilding the client.
	httpClient   *http.Client
	allowPrivate atomic.Bool
}

// New constructs the service and eagerly opens any database files already
// present at the configured paths. Missing files are not an error — the service
// runs in degraded (no-geo) mode until the updater or an operator stages one.
func New(cfg Config, logger *zap.Logger) *Service {
	if logger == nil {
		logger = zap.NewNop()
	}
	cfg = withDefaults(cfg)
	s := &Service{cfg: cfg, logger: logger}
	s.allowPrivate.Store(cfg.AllowPrivateURL)
	s.httpClient = newGuardedClient(&s.allowPrivate)
	st := &Status{Enabled: cfg.Enabled, DBPath: cfg.DBPath, ASNDBPath: cfg.ASNDBPath, AutoUpdate: cfg.AutoUpdate, UpdateURL: cfg.UpdateURL}
	s.status.Store(st)
	if cfg.Enabled {
		if err := s.loadCityFromFile(cfg.DBPath); err != nil {
			logger.Info("geoip: city database not loaded at startup", zap.String("path", cfg.DBPath), zap.Error(err))
		}
		if cfg.ASNDBPath != "" {
			if err := s.loadASNFromFile(cfg.ASNDBPath); err != nil {
				logger.Debug("geoip: asn database not loaded at startup", zap.String("path", cfg.ASNDBPath), zap.Error(err))
			}
		}
	}
	s.refreshStatus(nil)
	return s
}

func withDefaults(c Config) Config {
	if c.DBPath == "" {
		c.DBPath = "./var/geoip/city.mmdb"
	}
	if c.UpdateInterval <= 0 {
		c.UpdateInterval = 168 * time.Hour // weekly
	}
	if c.DownloadTimeout <= 0 {
		c.DownloadTimeout = 2 * time.Minute
	}
	if c.Language == "" {
		c.Language = "zh-CN"
	}
	return c
}

// Enabled reports whether geo resolution is switched on. A nil service is
// treated as disabled.
func (s *Service) Enabled() bool {
	if s == nil {
		return false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg.Enabled
}

// Lookup resolves an IP string to a Location. It never returns an error: an
// unparseable IP, a private address, or a missing database all yield a partial
// Location (with Private set for non-public addresses). Safe on a nil service.
func (s *Service) Lookup(ipStr string) Location {
	loc := Location{IP: ipStr}
	if s == nil {
		return loc
	}
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return loc
	}
	if isPrivate(ip) {
		loc.Private = true
		return loc
	}
	if cr := s.city.Load(); cr != nil {
		s.mu.RLock()
		lang := s.cfg.Language
		s.mu.RUnlock()
		if rec, err := cr.City(ip); err == nil && rec != nil {
			loc.CountryISO = rec.Country.IsoCode
			loc.Country = pickName(rec.Country.Names, lang)
			loc.City = pickName(rec.City.Names, lang)
			if len(rec.Subdivisions) > 0 {
				loc.Region = pickName(rec.Subdivisions[0].Names, lang)
			}
			loc.Latitude = rec.Location.Latitude
			loc.Longitude = rec.Location.Longitude
		}
	}
	if ar := s.asn.Load(); ar != nil {
		if rec, err := ar.ASN(ip); err == nil && rec != nil {
			loc.ASN = rec.AutonomousSystemNumber
			loc.ASNOrg = rec.AutonomousSystemOrganization
		}
	}
	return loc
}

// Status returns a snapshot of the loaded databases + last-update bookkeeping.
func (s *Service) Status() Status {
	if s == nil {
		return Status{}
	}
	if st := s.status.Load(); st != nil {
		return *st
	}
	return Status{}
}

// ApplyConfig hot-reloads the service from a new config snapshot (settings
// center). It reloads readers when a path changes and updates the updater knobs.
func (s *Service) ApplyConfig(cfg Config) {
	if s == nil {
		return
	}
	cfg = withDefaults(cfg)
	s.allowPrivate.Store(cfg.AllowPrivateURL)
	s.mu.Lock()
	old := s.cfg
	s.cfg = cfg
	s.mu.Unlock()

	if !cfg.Enabled {
		s.city.Store(nil)
		s.asn.Store(nil)
		s.refreshStatus(nil)
		return
	}
	if cfg.DBPath != old.DBPath || s.city.Load() == nil {
		if err := s.loadCityFromFile(cfg.DBPath); err != nil {
			s.logger.Info("geoip: reload city database failed", zap.String("path", cfg.DBPath), zap.Error(err))
		}
	}
	if cfg.ASNDBPath != "" && (cfg.ASNDBPath != old.ASNDBPath || s.asn.Load() == nil) {
		if err := s.loadASNFromFile(cfg.ASNDBPath); err != nil {
			s.logger.Debug("geoip: reload asn database failed", zap.String("path", cfg.ASNDBPath), zap.Error(err))
		}
	}
	if cfg.ASNDBPath == "" {
		s.asn.Store(nil)
	}
	s.refreshStatus(nil)
}

// Close releases the in-memory readers.
func (s *Service) Close() {
	if s == nil {
		return
	}
	if r := s.city.Swap(nil); r != nil {
		_ = r.Close()
	}
	if r := s.asn.Swap(nil); r != nil {
		_ = r.Close()
	}
}

// pickName chooses the best place name from a localized names map: the preferred
// language, then English, then any available entry.
func pickName(names map[string]string, lang string) string {
	if len(names) == 0 {
		return ""
	}
	if v := names[lang]; v != "" {
		return v
	}
	if lang != "zh-CN" {
		if v := names["zh-CN"]; v != "" {
			return v
		}
	}
	if v := names["en"]; v != "" {
		return v
	}
	for _, v := range names {
		if v != "" {
			return v
		}
	}
	return ""
}

// isPrivate reports whether the address has no meaningful public geolocation:
// RFC1918 / unique-local, loopback, link-local, and the unspecified address.
func isPrivate(ip net.IP) bool {
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}
