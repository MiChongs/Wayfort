package repo

import (
	"context"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// SystemSettingRepo persists managed configuration overrides + the change
// trail. It's intentionally thin — the settings center owns all typing,
// validation and sealing; this layer only reads and upserts rows.
type SystemSettingRepo struct{ db *gorm.DB }

func NewSystemSettingRepo(db *gorm.DB) *SystemSettingRepo { return &SystemSettingRepo{db: db} }

// All returns every persisted override keyed by setting key.
func (r *SystemSettingRepo) All(ctx context.Context) (map[string]model.SystemSetting, error) {
	var rows []model.SystemSetting
	if err := r.db.WithContext(ctx).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]model.SystemSetting, len(rows))
	for _, row := range rows {
		out[row.Key] = row
	}
	return out, nil
}

// Upsert writes (or overwrites) a batch of rows in one transaction. The whole
// settings save is atomic: either every changed key lands or none do.
func (r *SystemSettingRepo) Upsert(ctx context.Context, rows []model.SystemSetting) error {
	if len(rows) == 0 {
		return nil
	}
	now := time.Now().UTC()
	for i := range rows {
		rows[i].UpdatedAt = now
	}
	return r.db.WithContext(ctx).Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "key"}},
		DoUpdates: clause.AssignmentColumns([]string{"value", "secret", "updated_by", "updated_at"}),
	}).Create(&rows).Error
}

// Delete drops an override so the key falls back to its YAML/code default on the
// next load. Used by the "重置为默认" action.
func (r *SystemSettingRepo) Delete(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Where("key IN ?", keys).Delete(&model.SystemSetting{}).Error
}

// AppendAudit records a batch of change events. Best-effort: a failed audit
// write must never block a settings save, so callers log and continue.
func (r *SystemSettingRepo) AppendAudit(ctx context.Context, rows []model.SystemSettingAudit) error {
	if len(rows) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Create(&rows).Error
}

// RecentAudits returns the newest change events for the activity strip.
func (r *SystemSettingRepo) RecentAudits(ctx context.Context, limit int) ([]model.SystemSettingAudit, error) {
	if limit <= 0 {
		limit = 50
	}
	var rows []model.SystemSettingAudit
	if err := r.db.WithContext(ctx).Order("id DESC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}
