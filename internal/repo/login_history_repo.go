package repo

import (
	"context"

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
