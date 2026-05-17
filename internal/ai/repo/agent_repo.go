package repo

import (
	"context"
	"errors"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"gorm.io/gorm"
)

type AgentRepo struct{ db *gorm.DB }

func NewAgentRepo(db *gorm.DB) *AgentRepo { return &AgentRepo{db: db} }

func (r *AgentRepo) Create(ctx context.Context, a *aimodel.AIAgent) error {
	return r.db.WithContext(ctx).Create(a).Error
}
func (r *AgentRepo) Update(ctx context.Context, a *aimodel.AIAgent) error {
	return r.db.WithContext(ctx).Save(a).Error
}
func (r *AgentRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&aimodel.AIAgent{}, id).Error
}
func (r *AgentRepo) FindByID(ctx context.Context, id uint64) (*aimodel.AIAgent, error) {
	var a aimodel.AIAgent
	err := r.db.WithContext(ctx).First(&a, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &a, err
}

func (r *AgentRepo) VisibleTo(ctx context.Context, userID uint64) ([]aimodel.AIAgent, error) {
	var out []aimodel.AIAgent
	err := r.db.WithContext(ctx).
		Where("enabled = ? AND (scope = ? OR (scope = ? AND owner_id = ?))",
			true, aimodel.AgentScopeGlobal, aimodel.AgentScopePersonal, userID).
		Order("scope DESC, id").Find(&out).Error
	return out, err
}

// List returns every agent (admin view).
func (r *AgentRepo) List(ctx context.Context) ([]aimodel.AIAgent, error) {
	var out []aimodel.AIAgent
	err := r.db.WithContext(ctx).Order("id").Find(&out).Error
	return out, err
}
