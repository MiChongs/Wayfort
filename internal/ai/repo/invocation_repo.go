package repo

import (
	"context"
	"errors"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
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
func (r *InvocationRepo) ListByConv(ctx context.Context, convID string) ([]aimodel.AIToolInvocation, error) {
	var out []aimodel.AIToolInvocation
	err := r.db.WithContext(ctx).
		Where("conversation_id = ?", convID).
		Order("id").Find(&out).Error
	return out, err
}
