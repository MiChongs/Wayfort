// Package anomaly inspects authentication events to flag risky logins. On a
// successful login it scores the attempt against the user's recent history
// across several signals — new IP, new device (UA family), new country, new
// network (ASN), and physically impossible travel — producing a 0–100 risk
// score and a set of reason codes. On failed logins it watches for brute-force /
// credential-stuffing bursts.
//
// Detection is best-effort and must never block or fail the auth response: the
// caller (auth_handler.finalizeLogin / recordHistory) invokes it inline, uses
// the returned Signal to enrich the login_history row + emit audit events, and
// the detector fans security notifications out asynchronously through the
// notification dispatcher.
package anomaly

import (
	"context"
	"math"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/michongs/wayfort/internal/config"
	"github.com/michongs/wayfort/internal/geoip"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/notifications"
	"github.com/michongs/wayfort/internal/repo"
	"github.com/mileusna/useragent"
	"go.uber.org/zap"
)

// Reason codes (machine-readable, stored CSV in login_history.anomaly_reasons).
const (
	ReasonNewIP            = "new_ip"
	ReasonNewDevice        = "new_device"
	ReasonNewCountry       = "new_country"
	ReasonNewASN           = "new_asn"
	ReasonImpossibleTravel = "impossible_travel"
	ReasonBruteForce       = "brute_force"
)

// reason weights → risk score. impossible_travel always forces an anomaly.
var reasonWeight = map[string]int{
	ReasonNewIP:            20,
	ReasonNewDevice:        15,
	ReasonNewCountry:       40,
	ReasonNewASN:           25,
	ReasonImpossibleTravel: 60,
}

var reasonHuman = map[string]string{
	ReasonNewIP:            "新的 IP 地址",
	ReasonNewDevice:        "新的设备 / 浏览器",
	ReasonNewCountry:       "新的登录国家 / 地区",
	ReasonNewASN:           "新的网络运营商 (ASN)",
	ReasonImpossibleTravel: "不可能的位移（疑似异地登录）",
	ReasonBruteForce:       "短时间内多次登录失败",
}

// Signal is the result of inspecting a successful login.
type Signal struct {
	Anomalous bool
	Score     int            // 0–100
	Reasons   []string       // machine codes
	Human     []string       // localized reason text
	Location  geoip.Location // resolved geo for this login (always populated when geoip is on)
}

// ReasonsCSV joins the machine reason codes for storage.
func (s Signal) ReasonsCSV() string { return strings.Join(s.Reasons, ",") }

// Detector scores logins and dispatches security notifications.
type Detector struct {
	repo       *repo.LoginHistoryRepo
	dispatcher *notifications.Dispatcher
	geo        *geoip.Service
	logger     *zap.Logger
	// baseCtx is the application-lifecycle context (cancelled on shutdown).
	// Detached notification goroutines derive a bounded child from it so they
	// survive the request that triggered them but still stop on shutdown rather
	// than touching a tearing-down database via context.Background().
	baseCtx context.Context

	cfg atomic.Pointer[config.AnomalyConfig]

	// bruteMu/lastBrute debounce the whole brute-force alert (in-app + email) so
	// every failed attempt past the threshold doesn't spawn a fresh alert.
	bruteMu   sync.Mutex
	lastBrute map[string]time.Time
}

// notifyTimeout bounds each detached notification dispatch so a stuck DB/SMTP
// call can't leak a goroutine indefinitely.
const notifyTimeout = 30 * time.Second

// New constructs a detector. baseCtx should be the application root context so
// detached notification work is cancelled on shutdown (nil → context.Background).
// Any of dispatcher/geo may be nil (notifications or geo simply skipped).
func New(baseCtx context.Context, history *repo.LoginHistoryRepo, dispatcher *notifications.Dispatcher, geo *geoip.Service, logger *zap.Logger, cfg config.AnomalyConfig) *Detector {
	if logger == nil {
		logger = zap.NewNop()
	}
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	d := &Detector{baseCtx: baseCtx, repo: history, dispatcher: dispatcher, geo: geo, logger: logger, lastBrute: map[string]time.Time{}}
	d.ApplyConfig(cfg)
	return d
}

// dispatchContext returns a shutdown-aware, time-bounded context for detached
// notification work.
func (d *Detector) dispatchContext() (context.Context, context.CancelFunc) {
	base := d.baseCtx
	if base == nil {
		base = context.Background()
	}
	return context.WithTimeout(base, notifyTimeout)
}

// ApplyConfig hot-swaps the tuning knobs (settings center reload).
func (d *Detector) ApplyConfig(cfg config.AnomalyConfig) {
	if d == nil {
		return
	}
	cfg = withAnomalyDefaults(cfg)
	d.cfg.Store(&cfg)
}

func withAnomalyDefaults(c config.AnomalyConfig) config.AnomalyConfig {
	if c.ScoreThreshold <= 0 {
		c.ScoreThreshold = 50
	}
	if c.HistoryWindow <= 0 {
		c.HistoryWindow = 30
	}
	if c.ImpossibleTravelKmh == 0 {
		c.ImpossibleTravelKmh = 900
	}
	if c.BruteForceThreshold <= 0 {
		c.BruteForceThreshold = 8
	}
	if c.BruteForceWindow <= 0 {
		c.BruteForceWindow = 10 * time.Minute
	}
	return c
}

func (d *Detector) config() config.AnomalyConfig {
	if c := d.cfg.Load(); c != nil {
		return *c
	}
	return withAnomalyDefaults(config.AnomalyConfig{})
}

// Geo resolves the location for an IP (nil-safe). Useful to callers that want to
// stamp geo on a row without a full Inspect (e.g. failed logins).
func (d *Detector) Geo(ip string) geoip.Location {
	if d == nil || d.geo == nil {
		return geoip.Location{IP: ip}
	}
	return d.geo.Lookup(ip)
}

// Inspect scores a successful login. It always resolves geo (so the caller can
// stamp the login_history row regardless of anomaly), and when the score crosses
// the threshold it marks the login anomalous and fans notifications to the user
// and (optionally) the security team.
func (d *Detector) Inspect(ctx context.Context, user *model.User, ip, ua string) Signal {
	sig := Signal{Location: d.Geo(ip)}
	if d == nil || user == nil {
		return sig
	}
	cfg := d.config()
	if !cfg.Enabled {
		return sig
	}
	history, err := d.repo.RecentForAnomaly(ctx, user.ID, cfg.HistoryWindow)
	if err != nil {
		d.logger.Warn("anomaly history fetch failed", zap.Error(err))
		return sig
	}
	if len(history) == 0 {
		// First successful login — seed memory, never flag.
		return sig
	}

	loc := sig.Location
	add := func(code string) {
		sig.Reasons = append(sig.Reasons, code)
		sig.Human = append(sig.Human, reasonHuman[code])
		sig.Score += reasonWeight[code]
	}

	if !ipKnown(history, ip) {
		add(ReasonNewIP)
	}
	if !uaFamilyKnown(history, ua) {
		add(ReasonNewDevice)
	}
	if loc.HasGeo() {
		if loc.CountryISO != "" && !countryKnown(history, loc.CountryISO) {
			add(ReasonNewCountry)
		}
		if loc.ASN != 0 && !asnKnown(history, loc.ASN) {
			add(ReasonNewASN)
		}
		if cfg.ImpossibleTravelKmh > 0 && impossibleTravel(history, loc, time.Now(), cfg.ImpossibleTravelKmh) {
			add(ReasonImpossibleTravel)
		}
	}

	if sig.Score > 100 {
		sig.Score = 100
	}
	hasImpossible := slices.Contains(sig.Reasons, ReasonImpossibleTravel)
	sig.Anomalous = len(sig.Reasons) > 0 && (sig.Score >= cfg.ScoreThreshold || hasImpossible)

	if sig.Anomalous {
		d.logger.Info("anomalous login detected",
			zap.String("user", user.Username), zap.String("ip", ip),
			zap.Int("score", sig.Score), zap.Strings("reasons", sig.Reasons),
			zap.String("country", loc.Country))
		// Notifications (recipient resolution + DB inserts + email) run detached so
		// they never add latency to the login response. They use a shutdown-aware,
		// time-bounded context (not the request context, which dies when the
		// response is sent; not context.Background, which would outlive shutdown).
		go func() {
			ctx, cancel := d.dispatchContext()
			defer cancel()
			d.notifyAnomaly(ctx, user, ip, loc, sig, cfg)
		}()
	}
	return sig
}

// notifyAnomaly fans the anomaly out: an in-app + (optional) email notice to the
// affected user, and a security-team alert when NotifyAdmins is set.
func (d *Detector) notifyAnomaly(ctx context.Context, user *model.User, ip string, loc geoip.Location, sig Signal, cfg config.AnomalyConfig) {
	if d.dispatcher == nil {
		return
	}
	where := FormatLocation(loc)
	reasonText := notifications.JoinReasons(sig.Human)
	now := time.Now()
	data := map[string]any{
		"ip": ip, "country": loc.Country, "city": loc.City,
		"score": sig.Score, "reasons": sig.Reasons,
	}

	// User notice.
	subj, htmlBody, text := notifications.AnomalyEmail(user.Username, ip, where, reasonText, sig.Score, now)
	d.dispatcher.Notify(ctx, notifications.Event{
		Kind:           model.NotifyKindAnomalyLogin,
		Severity:       model.NotifySevWarning,
		Title:          "检测到异常登录",
		Body:           "您的账号在 " + where + "（" + ip + "）发生了一次异常登录：" + reasonText + "。如非本人操作请立即修改密码。",
		Link:           "/me/login-history",
		Data:           data,
		Recipients:     []notifications.Recipient{{UserID: user.ID, Email: user.Email}},
		SendEmail:      cfg.NotifyEmail,
		EmailSubject:   subj,
		EmailHTML:      htmlBody,
		EmailText:      text,
		DebounceKey:    "anomaly_self",
		DebounceWindow: 10 * time.Minute,
	})

	// Security-team alert.
	if cfg.NotifyAdmins {
		recipients := excludeUser(d.dispatcher.SecurityRecipients(ctx), user.ID)
		if len(recipients) > 0 {
			asubj, ahtml, atext := notifications.AnomalyAdminEmail(user.Username, ip, where, reasonText, sig.Score, now)
			d.dispatcher.Notify(ctx, notifications.Event{
				Kind:           model.NotifyKindAnomalyLogin,
				Severity:       model.NotifySevWarning,
				Title:          "安全告警：异常登录",
				Body:           "账号 " + user.Username + " 在 " + where + "（" + ip + "）异常登录：" + reasonText + "（风险 " + itoa(sig.Score) + "/100）。",
				Link:           "/admin/security/anomalies",
				Data:           data,
				Recipients:     recipients,
				SendEmail:      true,
				EmailSubject:   asubj,
				EmailHTML:      ahtml,
				EmailText:      atext,
				DebounceKey:    "anomaly_admin:" + user.Username,
				DebounceWindow: 30 * time.Minute,
			})
		}
	}
}

// InspectFailure watches for brute-force / credential-stuffing bursts on a failed
// login. It returns alert=true (with the offending count) ONLY on the first
// detection within the debounce window, so the caller emits at most one
// AuditBruteForce event per window; subsequent failures in the same window
// return alert=false. This method fans the security notification out itself.
func (d *Detector) InspectFailure(ctx context.Context, username, ip string) (alert bool, count int) {
	if d == nil {
		return false, 0
	}
	cfg := d.config()
	if !cfg.Enabled || d.repo == nil {
		return false, 0
	}
	since := time.Now().Add(-cfg.BruteForceWindow)
	if username != "" {
		if n, err := d.repo.CountRecentFailures(ctx, username, "", since); err == nil {
			count = int(n)
		}
	}
	if count < cfg.BruteForceThreshold && ip != "" {
		if n, err := d.repo.CountRecentFailures(ctx, "", ip, since); err == nil && int(n) > count {
			count = int(n)
		}
	}
	if count < cfg.BruteForceThreshold {
		return false, count
	}
	if !d.allowBrute(username+"|"+ip, cfg.BruteForceWindow) {
		return false, count // already alerted this window — suppress duplicate
	}
	d.logger.Warn("brute-force login burst detected",
		zap.String("user", username), zap.String("ip", ip), zap.Int("count", count))
	if cfg.NotifyAdmins && d.dispatcher != nil {
		// Detached: recipient resolution + inserts + email must not slow the auth
		// failure response. Shutdown-aware, time-bounded context (see dispatchContext).
		go func() {
			bg, cancel := d.dispatchContext()
			defer cancel()
			recipients := d.dispatcher.SecurityRecipients(bg)
			if len(recipients) == 0 {
				return
			}
			subj, htmlBody, text := notifications.BruteForceEmail(username, ip, count, cfg.BruteForceWindow)
			d.dispatcher.Notify(bg, notifications.Event{
				Kind:           model.NotifyKindBruteForce,
				Severity:       model.NotifySevCritical,
				Title:          "安全告警：疑似暴力破解",
				Body:           "账号 " + username + " 在短时间内出现 " + itoa(count) + " 次登录失败（来源 " + ip + "），疑似暴力破解 / 撞库。",
				Link:           "/admin/security/anomalies",
				Data:           map[string]any{"username": username, "ip": ip, "count": count},
				Recipients:     recipients,
				SendEmail:      true,
				EmailSubject:   subj,
				EmailHTML:      htmlBody,
				EmailText:      text,
				DebounceKey:    "bruteforce:" + username + "|" + ip,
				DebounceWindow: cfg.BruteForceWindow,
			})
		}()
	}
	return true, count
}

// NotifyLocked sends the account-lockout notice to the user (in-app + email).
// Best-effort; nil-safe. Intended to be invoked as `go d.NotifyLocked(...)`; it
// uses a shutdown-aware, time-bounded context internally.
func (d *Detector) NotifyLocked(user *model.User, minutes int) {
	if d == nil || d.dispatcher == nil || user == nil {
		return
	}
	ctx, cancel := d.dispatchContext()
	defer cancel()
	subj, htmlBody, text := notifications.AccountLockedEmail(user.Username, minutes)
	d.dispatcher.Notify(ctx, notifications.Event{
		Kind:         model.NotifyKindAccountLocked,
		Severity:     model.NotifySevWarning,
		Title:        "账号已被临时锁定",
		Body:         "您的账号因多次登录失败已被临时锁定 " + itoa(minutes) + " 分钟。",
		Link:         "/me/login-history",
		Recipients:   []notifications.Recipient{{UserID: user.ID, Email: user.Email}},
		SendEmail:    true,
		EmailSubject: subj,
		EmailHTML:    htmlBody,
		EmailText:    text,
		DebounceKey:  "locked",
	})
}

func (d *Detector) allowBrute(key string, window time.Duration) bool {
	now := time.Now()
	d.bruteMu.Lock()
	defer d.bruteMu.Unlock()
	if last, ok := d.lastBrute[key]; ok && now.Sub(last) < window {
		return false
	}
	d.lastBrute[key] = now
	if len(d.lastBrute) > 4096 {
		for k, t := range d.lastBrute {
			if now.Sub(t) > window {
				delete(d.lastBrute, k)
			}
		}
		// Hard ceiling: under a flood of unique username|ip keys within the window
		// the prune can't shrink the map, so reset it to bound memory. Worst case
		// is a few duplicate alerts right after the reset — acceptable.
		if len(d.lastBrute) > 8192 {
			d.lastBrute = map[string]time.Time{}
		}
	}
	return true
}

// FormatLocation renders a Location as a short human string for notices.
func FormatLocation(loc geoip.Location) string {
	if loc.Private {
		return "内网"
	}
	parts := make([]string, 0, 3)
	for _, p := range []string{loc.Country, loc.Region, loc.City} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	place := strings.Join(parts, " ")
	if place == "" {
		place = "未知位置"
	}
	if loc.ASNOrg != "" {
		place += " · " + loc.ASNOrg
	}
	return place
}

// ----- comparison helpers -----

func ipKnown(hist []model.LoginHistory, ip string) bool {
	for _, h := range hist {
		if h.IP == ip {
			return true
		}
	}
	return false
}

func uaFamilyKnown(hist []model.LoginHistory, ua string) bool {
	if ua == "" {
		return true
	}
	cur := useragent.Parse(ua)
	curFamily := strings.ToLower(cur.Name + ":" + cur.OS)
	for _, h := range hist {
		if h.UserAgent == ua {
			return true
		}
		past := useragent.Parse(h.UserAgent)
		if strings.ToLower(past.Name+":"+past.OS) == curFamily {
			return true
		}
	}
	return false
}

func countryKnown(hist []model.LoginHistory, iso string) bool {
	any := false
	for _, h := range hist {
		if h.GeoCountryISO == "" {
			continue
		}
		any = true
		if h.GeoCountryISO == iso {
			return true
		}
	}
	// No prior geo to compare against → don't treat as new (avoid false positive
	// on the first geo-resolved login).
	return !any
}

func asnKnown(hist []model.LoginHistory, asn uint) bool {
	any := false
	for _, h := range hist {
		if h.ASN == 0 {
			continue
		}
		any = true
		if h.ASN == asn {
			return true
		}
	}
	return !any
}

// impossibleTravel reports whether the gap between this login and the most recent
// geo-located prior login implies a ground speed above maxKmh. Requires both
// points to have coordinates; small hops (<200km) are ignored to absorb the
// coarseness of city-level coordinates.
func impossibleTravel(hist []model.LoginHistory, cur geoip.Location, now time.Time, maxKmh float64) bool {
	if cur.Latitude == 0 && cur.Longitude == 0 {
		return false
	}
	for _, h := range hist {
		if h.GeoLat == 0 && h.GeoLon == 0 {
			continue
		}
		km := haversineKm(cur.Latitude, cur.Longitude, h.GeoLat, h.GeoLon)
		if km < 200 {
			return false // close enough — first (most recent) geo point governs
		}
		hours := now.Sub(h.CreatedAt).Hours()
		if hours <= 0 {
			// Defensive against clock skew: `now` should always be >= the prior
			// login's recorded time. A non-positive gap means a clock anomaly — we
			// can't compute a meaningful speed, so skip rather than false-flag.
			return false
		}
		if km/hours > maxKmh {
			return true
		}
		return false // most recent geo point is plausible; older ones are stale
	}
	return false
}

func haversineKm(lat1, lon1, lat2, lon2 float64) float64 {
	const r = 6371.0 // earth radius km
	dLat := rad(lat2 - lat1)
	dLon := rad(lon2 - lon1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(rad(lat1))*math.Cos(rad(lat2))*math.Sin(dLon/2)*math.Sin(dLon/2)
	return r * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}

func rad(deg float64) float64 { return deg * math.Pi / 180 }

func excludeUser(rs []notifications.Recipient, userID uint64) []notifications.Recipient {
	out := rs[:0]
	for _, r := range rs {
		if r.UserID != userID {
			out = append(out, r)
		}
	}
	return out
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
