package repo

import (
	"context"
	"errors"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

type OIDCClientRepo struct{ db *gorm.DB }

func NewOIDCClientRepo(db *gorm.DB) *OIDCClientRepo { return &OIDCClientRepo{db: db} }

func (r *OIDCClientRepo) Create(ctx context.Context, c *model.OIDCClient) error {
	return r.db.WithContext(ctx).Create(c).Error
}
func (r *OIDCClientRepo) Update(ctx context.Context, c *model.OIDCClient) error {
	return r.db.WithContext(ctx).Save(c).Error
}
func (r *OIDCClientRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.OIDCClient{}, id).Error
}
func (r *OIDCClientRepo) FindByName(ctx context.Context, name string) (*model.OIDCClient, error) {
	var c model.OIDCClient
	err := r.db.WithContext(ctx).Where("name = ?", name).First(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &c, err
}
func (r *OIDCClientRepo) FindByID(ctx context.Context, id uint64) (*model.OIDCClient, error) {
	var c model.OIDCClient
	err := r.db.WithContext(ctx).First(&c, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &c, err
}
func (r *OIDCClientRepo) ListEnabled(ctx context.Context) ([]model.OIDCClient, error) {
	var out []model.OIDCClient
	err := r.db.WithContext(ctx).Where("enabled = ?", true).Order("name").Find(&out).Error
	return out, err
}
func (r *OIDCClientRepo) List(ctx context.Context) ([]model.OIDCClient, error) {
	var out []model.OIDCClient
	err := r.db.WithContext(ctx).Order("name").Find(&out).Error
	return out, err
}
