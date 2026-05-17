package repo

import (
	"context"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

type AuditRepo struct{ db *gorm.DB }

func NewAuditRepo(db *gorm.DB) *AuditRepo { return &AuditRepo{db: db} }

func (r *AuditRepo) BatchInsert(ctx context.Context, logs []model.AuditLog) error {
	if len(logs) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).CreateInBatches(logs, 256).Error
}

func (r *AuditRepo) List(ctx context.Context, sessionID string, limit int) ([]model.AuditLog, error) {
	q := r.db.WithContext(ctx).Model(&model.AuditLog{})
	if sessionID != "" {
		q = q.Where("session_id = ?", sessionID)
	}
	if limit <= 0 {
		limit = 200
	}
	var out []model.AuditLog
	err := q.Order("id DESC").Limit(limit).Find(&out).Error
	return out, err
}
