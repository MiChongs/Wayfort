package geoip

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/oschwald/geoip2-golang"
	"go.uber.org/zap"
)

// newGuardedClient builds the database download client with SSRF protection: its
// dialer's Control hook inspects the *resolved* destination IP (after DNS) and
// refuses to connect to non-public addresses. Because the database URL is
// operator-tunable (settings center), a misconfigured/hostile URL pointed at
// 127.0.0.1:6379, 169.254.169.254 (cloud metadata), or an internal host is
// blocked at the socket — checking the resolved IP (not the hostname) defeats
// DNS-rebinding. allowPrivate (read live per-connection) relaxes the guard for a
// legitimate internal mirror in air-gapped deployments.
func newGuardedClient(allowPrivate *atomic.Bool) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
				Control: func(_, address string, _ syscall.RawConn) error {
					if allowPrivate != nil && allowPrivate.Load() {
						return nil
					}
					host, _, err := net.SplitHostPort(address)
					if err != nil {
						return err
					}
					ip := net.ParseIP(host)
					if ip == nil || isPrivate(ip) || !ip.IsGlobalUnicast() {
						return fmt.Errorf("geoip: refusing to connect to non-public address %q (set geoip.allow_private_url to use an internal mirror)", address)
					}
					return nil
				},
			}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          10,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   15 * time.Second,
			ExpectContinueTimeout: time.Second,
		},
	}
}

// maxDBBytes caps a single download so a wrong URL (e.g. an HTML error page or a
// hostile redirect to a huge file) can't exhaust memory. GeoLite/db-ip city
// databases are well under this.
const maxDBBytes = 512 << 20 // 512 MiB

// Status is the operator-facing snapshot of the GeoIP subsystem, surfaced by the
// admin security endpoint so the UI can show "loaded / stale / last error".
type Status struct {
	Enabled    bool       `json:"enabled"`
	Loaded     bool       `json:"loaded"`     // city reader present
	ASNLoaded  bool       `json:"asn_loaded"` // asn reader present
	DBPath     string     `json:"db_path"`
	ASNDBPath  string     `json:"asn_db_path,omitempty"`
	DBType     string     `json:"db_type,omitempty"`
	BuildTime  *time.Time `json:"build_time,omitempty"` // from mmdb metadata build_epoch
	NodeCount  uint       `json:"node_count,omitempty"`
	AutoUpdate bool       `json:"auto_update"`
	UpdateURL  string     `json:"update_url,omitempty"`

	LastUpdate  *time.Time `json:"last_update,omitempty"`  // last successful refresh
	LastAttempt *time.Time `json:"last_attempt,omitempty"` // last refresh attempt (success or fail)
	LastError   string     `json:"last_error,omitempty"`
	NextCheck   *time.Time `json:"next_check,omitempty"`
}

// loadCityFromFile reads the file fully into memory and swaps in a fresh reader.
// Reading into memory (FromBytes) rather than mmap-ing keeps no OS file handle
// open, so update.replaceFile can rename over the path on every platform.
func (s *Service) loadCityFromFile(path string) error {
	r, err := openReaderFromFile(path)
	if err != nil {
		return err
	}
	if old := s.city.Swap(r); old != nil {
		_ = old.Close()
	}
	s.refreshStatus(nil)
	return nil
}

func (s *Service) loadASNFromFile(path string) error {
	r, err := openReaderFromFile(path)
	if err != nil {
		return err
	}
	if old := s.asn.Swap(r); old != nil {
		_ = old.Close()
	}
	s.refreshStatus(nil)
	return nil
}

func openReaderFromFile(path string) (*geoip2.Reader, error) {
	if path == "" {
		return nil, fmt.Errorf("geoip: empty database path")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return geoip2.FromBytes(data)
}

// Run drives the background auto-updater. It returns when ctx is cancelled. When
// the subsystem is disabled it simply idles on ctx (harmless errgroup slot). The
// loop re-reads config each tick so toggling auto_update at runtime (settings
// center) takes effect on the next cadence; the actual auto/staleness decision
// lives in maybeRefresh. The cadence is bounded to a day so a long interval still
// notices a freshly published monthly build within 24h.
func (s *Service) Run(ctx context.Context) error {
	if !s.Enabled() {
		<-ctx.Done()
		return ctx.Err()
	}
	// Stagger the first check so the HTTP listener comes up first.
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(20 * time.Second):
	}
	s.maybeRefresh(ctx, false)

	check := s.cfgSnapshot().UpdateInterval
	if check > 24*time.Hour {
		check = 24 * time.Hour
	}
	if check < time.Minute {
		check = time.Minute
	}
	t := time.NewTicker(check)
	defer t.Stop()
	for {
		next := time.Now().Add(check)
		s.setNextCheck(&next)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			s.maybeRefresh(ctx, false)
		}
	}
}

// RefreshNow forces an immediate download regardless of staleness. Used by the
// admin "update now" endpoint. Returns the resulting status (or an error if the
// download/validation failed).
func (s *Service) RefreshNow(ctx context.Context) (Status, error) {
	err := s.maybeRefresh(ctx, true)
	return s.Status(), err
}

// maybeRefresh downloads the city (and ASN, if configured) databases when force
// is set or the on-disk file is stale/missing. It is single-flighted: a second
// caller while one is in progress returns immediately.
func (s *Service) maybeRefresh(ctx context.Context, force bool) error {
	if !s.updating.CompareAndSwap(false, true) {
		return nil // an update is already running
	}
	defer s.updating.Store(false)

	cfg := s.cfgSnapshot()
	if !cfg.Enabled {
		return nil
	}
	// The periodic path only downloads when auto-update is on; a forced refresh
	// (admin "update now") always proceeds.
	if !force && !cfg.AutoUpdate {
		return nil
	}
	if cfg.UpdateURL == "" && cfg.ASNUpdateURL == "" {
		return nil
	}

	now := time.Now()
	s.setLastAttempt(&now)

	var firstErr error
	if cfg.UpdateURL != "" && (force || isStale(cfg.DBPath, cfg.UpdateInterval)) {
		if err := s.refreshOne(ctx, cfg.UpdateURL, cfg.DBPath, cfg.DownloadTimeout, false); err != nil {
			firstErr = err
			s.logger.Warn("geoip: city database update failed", zap.Error(err))
			s.setLastError(err.Error())
		} else {
			s.logger.Info("geoip: city database updated", zap.String("path", cfg.DBPath))
		}
	}
	if cfg.ASNUpdateURL != "" && cfg.ASNDBPath != "" && (force || isStale(cfg.ASNDBPath, cfg.UpdateInterval)) {
		if err := s.refreshOne(ctx, cfg.ASNUpdateURL, cfg.ASNDBPath, cfg.DownloadTimeout, true); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			s.logger.Warn("geoip: asn database update failed", zap.Error(err))
		} else {
			s.logger.Info("geoip: asn database updated", zap.String("path", cfg.ASNDBPath))
		}
	}
	if firstErr == nil {
		done := time.Now()
		s.setLastSuccess(&done)
	}
	return firstErr
}

// refreshOne downloads, decompresses, validates and atomically installs one
// database, then hot-swaps the in-memory reader.
func (s *Service) refreshOne(ctx context.Context, url, dest string, timeout time.Duration, isASN bool) error {
	data, err := s.fetchDatabase(ctx, templateURL(url, time.Now().UTC()), timeout)
	if err != nil {
		return err
	}
	// Validate before touching disk — a corrupt/HTML body must not clobber a
	// working database.
	if _, err := geoip2.FromBytes(data); err != nil {
		return fmt.Errorf("downloaded file is not a valid mmdb database: %w", err)
	}
	if err := writeFileAtomic(dest, data); err != nil {
		return err
	}
	if isASN {
		return s.loadASNFromFile(dest)
	}
	return s.loadCityFromFile(dest)
}

// fetchDatabase GETs the URL through the SSRF-guarded client and returns the
// decompressed mmdb bytes.
func (s *Service) fetchDatabase(ctx context.Context, url string, timeout time.Duration) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "wayfort-geoip/1")
	client := s.httpClient
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxDBBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > maxDBBytes {
		return nil, fmt.Errorf("download %s exceeds %d bytes", url, maxDBBytes)
	}
	return decompress(url, raw)
}

// decompress unwraps the download by extension: a .tar.gz/.tgz archive yields
// its first *.mmdb member, a plain .gz is gunzipped whole, anything else is
// assumed to already be a raw .mmdb.
func decompress(url string, raw []byte) ([]byte, error) {
	lower := strings.ToLower(url)
	switch {
	case strings.Contains(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		return extractTarGzMMDB(raw)
	case strings.HasSuffix(lower, ".gz"):
		return gunzip(raw)
	default:
		return raw, nil
	}
}

func gunzip(raw []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	return io.ReadAll(io.LimitReader(zr, maxDBBytes))
}

func extractTarGzMMDB(raw []byte) ([]byte, error) {
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.Typeflag != tar.TypeReg || !strings.HasSuffix(strings.ToLower(hdr.Name), ".mmdb") {
			continue
		}
		return io.ReadAll(io.LimitReader(tr, maxDBBytes))
	}
	return nil, fmt.Errorf("no .mmdb file found in archive")
}

// writeFileAtomic writes to a sibling temp file then renames it into place,
// creating the parent directory as needed. Because the active reader holds the
// data in memory (not the file), removing/renaming the destination is safe even
// on Windows where an open file can't be replaced.
func writeFileAtomic(dest string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := dest + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		// Windows: rename fails if dest exists. Remove then retry.
		_ = os.Remove(dest)
		if err2 := os.Rename(tmp, dest); err2 != nil {
			_ = os.Remove(tmp)
			return err2
		}
	}
	return nil
}

// templateURL substitutes time tokens so a monthly source URL stays current
// without operator edits: {year}/{YYYY} → 2006, {month}/{MM} → 01, {day}/{DD} → 02.
func templateURL(url string, now time.Time) string {
	r := strings.NewReplacer(
		"{year}", now.Format("2006"), "{YYYY}", now.Format("2006"),
		"{month}", now.Format("01"), "{MM}", now.Format("01"),
		"{day}", now.Format("02"), "{DD}", now.Format("02"),
	)
	return r.Replace(url)
}

// isStale reports whether the file is missing or older than maxAge.
func isStale(path string, maxAge time.Duration) bool {
	fi, err := os.Stat(path)
	if err != nil {
		return true
	}
	return time.Since(fi.ModTime()) > maxAge
}

// ----- status bookkeeping -----

func (s *Service) refreshStatus(_ *struct{}) {
	prev := s.Status()
	st := Status{
		Enabled:     s.Enabled(),
		AutoUpdate:  s.cfgSnapshot().AutoUpdate,
		UpdateURL:   s.cfgSnapshot().UpdateURL,
		DBPath:      s.cfgSnapshot().DBPath,
		ASNDBPath:   s.cfgSnapshot().ASNDBPath,
		LastUpdate:  prev.LastUpdate,
		LastAttempt: prev.LastAttempt,
		LastError:   prev.LastError,
		NextCheck:   prev.NextCheck,
	}
	if cr := s.city.Load(); cr != nil {
		st.Loaded = true
		md := cr.Metadata()
		st.DBType = md.DatabaseType
		st.NodeCount = md.NodeCount
		if md.BuildEpoch > 0 {
			bt := time.Unix(int64(md.BuildEpoch), 0)
			st.BuildTime = &bt
		}
	}
	st.ASNLoaded = s.asn.Load() != nil
	s.status.Store(&st)
}

func (s *Service) cfgSnapshot() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *Service) mutateStatus(fn func(*Status)) {
	cur := s.Status()
	fn(&cur)
	s.status.Store(&cur)
}

func (s *Service) setLastAttempt(t *time.Time) {
	s.mutateStatus(func(st *Status) { st.LastAttempt = t })
}
func (s *Service) setLastSuccess(t *time.Time) {
	s.mutateStatus(func(st *Status) { st.LastUpdate = t; st.LastError = "" })
}
func (s *Service) setLastError(e string)     { s.mutateStatus(func(st *Status) { st.LastError = e }) }
func (s *Service) setNextCheck(t *time.Time) { s.mutateStatus(func(st *Status) { st.NextCheck = t }) }
