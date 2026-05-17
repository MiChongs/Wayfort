package repo

import (
	"context"
	"errors"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

type CredentialRepo struct{ db *gorm.DB }

func NewCredentialRepo(db *gorm.DB) *CredentialRepo { return &CredentialRepo{db: db} }

func (r *CredentialRepo) Create(ctx context.Context, c *model.Credential) error {
	return r.db.WithContext(ctx).Create(c).Error
}

func (r *CredentialRepo) Update(ctx context.Context, c *model.Credential) error {
	return r.db.WithContext(ctx).Save(c).Error
}

func (r *CredentialRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.Credential{}, id).Error
}

func (r *CredentialRepo) FindByID(ctx context.Context, id uint64) (*model.Credential, error) {
	var c model.Credential
	err := r.db.WithContext(ctx).First(&c, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &c, err
}

func (r *CredentialRepo) List(ctx context.Context) ([]model.Credential, error) {
	var out []model.Credential
	err := r.db.WithContext(ctx).Order("id").Find(&out).Error
	return out, err
}
