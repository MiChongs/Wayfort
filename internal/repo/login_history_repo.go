package repo

import (
	"context"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

type LoginHistoryRepo struct{ db *gorm.DB }

func NewLoginHistoryRepo(db *gorm.DB) *LoginHistoryRepo { return &LoginHistoryRepo{db: db} }

func (r *LoginHistoryRepo) Insert(ctx context.Context, h *model.LoginHistory) error {
	return r.db.WithContext(ctx).Create(h).Error
}

func (r *LoginHistoryRepo) ListByUser(ctx context.Context, userID uint64, limit int) ([]model.LoginHistory, error) {
	if limit <= 0 {
		limit = 50
	}
	var out []model.LoginHistory
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).
		Order("created_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// RecentForAnomaly returns the most recent N successful entries used to decide
// whether a new login is anomalous (new IP / UA / country).
func (r *LoginHistoryRepo) RecentForAnomaly(ctx context.Context, userID uint64, limit int) ([]model.LoginHistory, error) {
	if limit <= 0 {
		limit = 30
	}
	var out []model.LoginHistory
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND result = ?", userID, model.LoginSuccess).
		Order("created_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// LoginHistoryFilter is consumed by Query to support flexible reads from the
// AI tools (login_history_query, anomaly_list, security-auditor flows).
type LoginHistoryFilter struct {
	UserID      *uint64 // nil = no user filter (admin scope)
	Username    string  // exact match if non-empty
	Result      string  // success | fail | locked | mfa_required | mfa_failed
	AnomalyOnly bool
	Limit       int
}

// Query is a flexible reader for the login_histories table.
func (r *LoginHistoryRepo) Query(ctx context.Context, f LoginHistoryFilter) ([]model.LoginHistory, error) {
	if f.Limit <= 0 {
		f.Limit = 50
	}
	q := r.db.WithContext(ctx).Model(&model.LoginHistory{})
	if f.UserID != nil {
		q = q.Where("user_id = ?", *f.UserID)
	}
	if f.Username != "" {
		q = q.Where("username = ?", f.Username)
	}
	if f.Result != "" {
		q = q.Where("result = ?", f.Result)
	}
	if f.AnomalyOnly {
		q = q.Where("anomaly = ?", true)
	}
	var out []model.LoginHistory
	if err := q.Order("created_at DESC").Limit(f.Limit).Find(&out).Error; err != nil {
		return nil, err
	}
	return out, nil
}

// CountRecentFailures counts failed/locked/mfa-failed attempts since `since`,
// scoped by username and/or IP (empty values are not filtered). Backs the
// brute-force / credential-stuffing detector.
func (r *LoginHistoryRepo) CountRecentFailures(ctx context.Context, username, ip string, since time.Time) (int64, error) {
	q := r.db.WithContext(ctx).Model(&model.LoginHistory{}).
		Where("created_at >= ?", since).
		Where("result IN ?", []string{string(model.LoginFailed), string(model.LoginLocked), string(model.LoginMFAFailed)})
	if username != "" {
		q = q.Where("username = ?", username)
	}
	if ip != "" {
		q = q.Where("ip = ?", ip)
	}
	var n int64
	err := q.Count(&n).Error
	return n, err
}

// AnomalyFilter drives the admin security-center anomalies list.
type AnomalyFilter struct {
	UserID      *uint64
	Username    string
	CountryISO  string
	Reason      string // substring match against anomaly_reasons (e.g. "new_country")
	MinScore    int
	Since       *time.Time
	AnomalyOnly bool // default true at the handler; included here for explicitness
	Limit       int
	Offset      int
}

// QueryAnomalies returns a paged slice of login-history rows matching the filter
// plus the total count (pre-pagination) so the UI can render real page counts.
func (r *LoginHistoryRepo) QueryAnomalies(ctx context.Context, f AnomalyFilter) ([]model.LoginHistory, int64, error) {
	q := r.db.WithContext(ctx).Model(&model.LoginHistory{})
	if f.AnomalyOnly {
		q = q.Where("anomaly = ?", true)
	}
	if f.UserID != nil {
		q = q.Where("user_id = ?", *f.UserID)
	}
	if f.Username != "" {
		q = q.Where("username = ?", f.Username)
	}
	if f.CountryISO != "" {
		q = q.Where("geo_country_iso = ?", f.CountryISO)
	}
	if f.Reason != "" {
		q = q.Where("anomaly_reasons LIKE ?", "%"+f.Reason+"%")
	}
	if f.MinScore > 0 {
		q = q.Where("risk_score >= ?", f.MinScore)
	}
	if f.Since != nil {
		q = q.Where("created_at >= ?", *f.Since)
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if f.Limit <= 0 {
		f.Limit = 50
	}
	var out []model.LoginHistory
	err := q.Order("created_at DESC").Limit(f.Limit).Offset(f.Offset).Find(&out).Error
	return out, total, err
}

// AnomalyCount is one grouped bucket for the anomaly stats endpoint.
type AnomalyCount struct {
	Key   string `json:"key"`
	Count int64  `json:"count"`
}

// AnomalyStats aggregates anomalous logins since `since`: total, and counts
// grouped by country. Reason breakdown is computed in the handler (reasons are a
// CSV column). Day trend is derived by the handler from the rows it lists.
func (r *LoginHistoryRepo) AnomalyStats(ctx context.Context, since time.Time) (total int64, byCountry []AnomalyCount, err error) {
	base := r.db.WithContext(ctx).Model(&model.LoginHistory{}).
		Where("anomaly = ? AND created_at >= ?", true, since)
	if err = base.Count(&total).Error; err != nil {
		return 0, nil, err
	}
	// Group by the full expression (not the output alias) so it runs unambiguously
	// across dialects; alias the count to a safe, non-reserved name.
	const countryExpr = "COALESCE(NULLIF(geo_country, ''), '未知')"
	err = r.db.WithContext(ctx).Model(&model.LoginHistory{}).
		Select(countryExpr+" AS key, COUNT(*) AS count").
		Where("anomaly = ? AND created_at >= ?", true, since).
		Group(countryExpr).Order("count DESC").Limit(20).Scan(&byCountry).Error
	return total, byCountry, err
}
