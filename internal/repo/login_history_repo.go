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
