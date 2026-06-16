package repo

import (
	"context"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// AccessRuleRepo persists the unified access-control rules (model.AccessRule).
// Thin layer; the accesscontrol.Engine owns all matching/evaluation.
type AccessRuleRepo struct{ db *gorm.DB }

func NewAccessRuleRepo(db *gorm.DB) *AccessRuleRepo { return &AccessRuleRepo{db: db} }

// List returns rules, optionally filtered by kind (empty = all kinds), ordered
// for admin display (kind, then priority ASC, then id).
func (r *AccessRuleRepo) List(ctx context.Context, kind model.AccessRuleKind) ([]model.AccessRule, error) {
	q := r.db.WithContext(ctx).Model(&model.AccessRule{})
	if kind != "" {
		q = q.Where("kind = ?", kind)
	}
	var rows []model.AccessRule
	if err := q.Order("kind ASC, priority ASC, id ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ListActiveByKind returns the ACTIVE rules of one kind in evaluation order
// (priority ASC = first match wins). Used by the engine on the hot path.
func (r *AccessRuleRepo) ListActiveByKind(ctx context.Context, kind model.AccessRuleKind) ([]model.AccessRule, error) {
	var rows []model.AccessRule
	err := r.db.WithContext(ctx).
		Where("kind = ? AND active = ?", kind, true).
		Order("priority ASC, id ASC").
		Find(&rows).Error
	if err != nil {
		return nil, err
	}
	return rows, nil
}

func (r *AccessRuleRepo) Get(ctx context.Context, id uint64) (*model.AccessRule, error) {
	var row model.AccessRule
	if err := r.db.WithContext(ctx).First(&row, id).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *AccessRuleRepo) Create(ctx context.Context, rule *model.AccessRule) error {
	now := time.Now().UTC()
	rule.CreatedAt = now
	rule.UpdatedAt = now
	return r.db.WithContext(ctx).Create(rule).Error
}

// Update saves the whole row (admin edit). UpdatedAt is bumped; CreatedAt/By and
// IsSystem are preserved by the caller loading the row first.
func (r *AccessRuleRepo) Update(ctx context.Context, rule *model.AccessRule) error {
	rule.UpdatedAt = time.Now().UTC()
	return r.db.WithContext(ctx).Save(rule).Error
}

func (r *AccessRuleRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.AccessRule{}, id).Error
}
