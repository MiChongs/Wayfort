package repo

import (
	"context"
	"errors"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/gorm"
)

// ChainTemplateRepo backs CRUD for ProxyChainTemplate. The proxy-id-list
// format mirrors model.Node.ProxyChain (comma-separated) so the existing
// resolveHops path can consume templates verbatim once applied to a node.
type ChainTemplateRepo struct{ db *gorm.DB }

func NewChainTemplateRepo(db *gorm.DB) *ChainTemplateRepo { return &ChainTemplateRepo{db: db} }

func (r *ChainTemplateRepo) Create(ctx context.Context, t *model.ProxyChainTemplate) error {
	return r.db.WithContext(ctx).Create(t).Error
}

func (r *ChainTemplateRepo) Update(ctx context.Context, t *model.ProxyChainTemplate) error {
	return r.db.WithContext(ctx).Save(t).Error
}

func (r *ChainTemplateRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.ProxyChainTemplate{}, id).Error
}

func (r *ChainTemplateRepo) FindByID(ctx context.Context, id uint64) (*model.ProxyChainTemplate, error) {
	var t model.ProxyChainTemplate
	err := r.db.WithContext(ctx).First(&t, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &t, err
}

func (r *ChainTemplateRepo) List(ctx context.Context) ([]model.ProxyChainTemplate, error) {
	var out []model.ProxyChainTemplate
	err := r.db.WithContext(ctx).Order("name").Find(&out).Error
	return out, err
}
