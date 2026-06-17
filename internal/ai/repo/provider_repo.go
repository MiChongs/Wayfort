package repo

import (
	"context"
	"errors"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
	"gorm.io/gorm"
)

type ProviderRepo struct{ db *gorm.DB }

func NewProviderRepo(db *gorm.DB) *ProviderRepo { return &ProviderRepo{db: db} }

func (r *ProviderRepo) Create(ctx context.Context, p *aimodel.AIProvider) error {
	return r.db.WithContext(ctx).Create(p).Error
}

func (r *ProviderRepo) Update(ctx context.Context, p *aimodel.AIProvider) error {
	return r.db.WithContext(ctx).Save(p).Error
}

func (r *ProviderRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&aimodel.AIProvider{}, id).Error
}

func (r *ProviderRepo) FindByID(ctx context.Context, id uint64) (*aimodel.AIProvider, error) {
	var p aimodel.AIProvider
	err := r.db.WithContext(ctx).First(&p, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &p, err
}

// VisibleTo returns providers either marked global or owned by the user.
func (r *ProviderRepo) VisibleTo(ctx context.Context, userID uint64) ([]aimodel.AIProvider, error) {
	var out []aimodel.AIProvider
	err := r.db.WithContext(ctx).
		Where("enabled = ? AND (is_global = ? OR owner_id = ?)", true, true, userID).
		Order("is_global DESC, id").Find(&out).Error
	return out, err
}

// FirstGlobalEnabled returns the lowest-ID enabled global provider; used as a
// last-resort default when nothing more specific was configured.
func (r *ProviderRepo) FirstGlobalEnabled(ctx context.Context) (*aimodel.AIProvider, error) {
	var p aimodel.AIProvider
	err := r.db.WithContext(ctx).
		Where("enabled = ? AND is_global = ?", true, true).
		Order("id").First(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &p, err
}

// List returns every provider (admin view, irrespective of scope).
func (r *ProviderRepo) List(ctx context.Context) ([]aimodel.AIProvider, error) {
	var out []aimodel.AIProvider
	err := r.db.WithContext(ctx).Order("is_global DESC, id").Find(&out).Error
	return out, err
}
