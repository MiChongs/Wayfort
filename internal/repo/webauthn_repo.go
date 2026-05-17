package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

type WebauthnRepo struct{ db *gorm.DB }

func NewWebauthnRepo(db *gorm.DB) *WebauthnRepo { return &WebauthnRepo{db: db} }

func (r *WebauthnRepo) Create(ctx context.Context, c *model.WebauthnCredential) error {
	return r.db.WithContext(ctx).Create(c).Error
}

func (r *WebauthnRepo) Delete(ctx context.Context, id, userID uint64) error {
	return r.db.WithContext(ctx).Where("id = ? AND user_id = ?", id, userID).
		Delete(&model.WebauthnCredential{}).Error
}

func (r *WebauthnRepo) ListByUser(ctx context.Context, userID uint64) ([]model.WebauthnCredential, error) {
	var out []model.WebauthnCredential
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).Order("id").Find(&out).Error
	return out, err
}

func (r *WebauthnRepo) FindByCredentialID(ctx context.Context, credID []byte) (*model.WebauthnCredential, error) {
	var c model.WebauthnCredential
	err := r.db.WithContext(ctx).Where("credential_id = ?", credID).First(&c).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &c, err
}

func (r *WebauthnRepo) UpdateSignCount(ctx context.Context, id uint64, count uint32) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&model.WebauthnCredential{}).
		Where("id = ?", id).
		Updates(map[string]any{"sign_count": count, "last_used_at": &now}).Error
}
