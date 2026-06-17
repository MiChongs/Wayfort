package repo

import (
	"context"
	"errors"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
	"gorm.io/gorm"
)

type InvocationRepo struct{ db *gorm.DB }

func NewInvocationRepo(db *gorm.DB) *InvocationRepo { return &InvocationRepo{db: db} }

func (r *InvocationRepo) Create(ctx context.Context, inv *aimodel.AIToolInvocation) error {
	return r.db.WithContext(ctx).Create(inv).Error
}
func (r *InvocationRepo) Update(ctx context.Context, inv *aimodel.AIToolInvocation) error {
	return r.db.WithContext(ctx).Save(inv).Error
}
func (r *InvocationRepo) FindByID(ctx context.Context, id string) (*aimodel.AIToolInvocation, error) {
	var v aimodel.AIToolInvocation
	err := r.db.WithContext(ctx).First(&v, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &v, err
}
// DeleteAfter removes every invocation in convID whose owning message id > afterID.
// Used by the edit-message flow to garbage-collect orphan tool runs.
func (r *InvocationRepo) DeleteAfter(ctx context.Context, convID string, afterID uint64) error {
	return r.db.WithContext(ctx).
		Where("conversation_id = ? AND message_id > ?", convID, afterID).
		Delete(&aimodel.AIToolInvocation{}).Error
}

func (r *InvocationRepo) ListByConv(ctx context.Context, convID string) ([]aimodel.AIToolInvocation, error) {
	var out []aimodel.AIToolInvocation
	err := r.db.WithContext(ctx).
		Where("conversation_id = ?", convID).
		Order("id").Find(&out).Error
	return out, err
}
