package repo

import (
	"context"
	"errors"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/gorm"
)

type ProxyRepo struct{ db *gorm.DB }

func NewProxyRepo(db *gorm.DB) *ProxyRepo { return &ProxyRepo{db: db} }

func (r *ProxyRepo) Create(ctx context.Context, p *model.Proxy) error {
	return r.db.WithContext(ctx).Create(p).Error
}

func (r *ProxyRepo) Update(ctx context.Context, p *model.Proxy) error {
	return r.db.WithContext(ctx).Save(p).Error
}

func (r *ProxyRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.Proxy{}, id).Error
}

func (r *ProxyRepo) FindByID(ctx context.Context, id uint64) (*model.Proxy, error) {
	var p model.Proxy
	err := r.db.WithContext(ctx).First(&p, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &p, err
}

func (r *ProxyRepo) List(ctx context.Context) ([]model.Proxy, error) {
	var out []model.Proxy
	err := r.db.WithContext(ctx).Order("id").Find(&out).Error
	return out, err
}
