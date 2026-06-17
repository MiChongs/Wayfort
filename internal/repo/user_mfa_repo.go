package repo

import (
	"context"
	"errors"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/gorm"
)

type UserMFARepo struct{ db *gorm.DB }

func NewUserMFARepo(db *gorm.DB) *UserMFARepo { return &UserMFARepo{db: db} }

func (r *UserMFARepo) Create(ctx context.Context, m *model.UserMFA) error {
	return r.db.WithContext(ctx).Create(m).Error
}

func (r *UserMFARepo) Update(ctx context.Context, m *model.UserMFA) error {
	return r.db.WithContext(ctx).Save(m).Error
}

func (r *UserMFARepo) Delete(ctx context.Context, id, userID uint64) error {
	return r.db.WithContext(ctx).Where("id = ? AND user_id = ?", id, userID).Delete(&model.UserMFA{}).Error
}

func (r *UserMFARepo) FindByID(ctx context.Context, id uint64) (*model.UserMFA, error) {
	var m model.UserMFA
	err := r.db.WithContext(ctx).First(&m, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &m, err
}

func (r *UserMFARepo) ListByUser(ctx context.Context, userID uint64) ([]model.UserMFA, error) {
	var out []model.UserMFA
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).Order("id").Find(&out).Error
	return out, err
}

func (r *UserMFARepo) ListEnabled(ctx context.Context, userID uint64) ([]model.UserMFA, error) {
	var out []model.UserMFA
	err := r.db.WithContext(ctx).Where("user_id = ? AND enabled = ?", userID, true).Order("id").Find(&out).Error
	return out, err
}

// ----- Recovery codes -----

type RecoveryCodeRepo struct{ db *gorm.DB }

func NewRecoveryCodeRepo(db *gorm.DB) *RecoveryCodeRepo { return &RecoveryCodeRepo{db: db} }

func (r *RecoveryCodeRepo) ReplaceAll(ctx context.Context, userID uint64, codes []model.UserRecoveryCode) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userID).Delete(&model.UserRecoveryCode{}).Error; err != nil {
			return err
		}
		if len(codes) == 0 {
			return nil
		}
		return tx.Create(&codes).Error
	})
}

func (r *RecoveryCodeRepo) UnusedByUser(ctx context.Context, userID uint64) ([]model.UserRecoveryCode, error) {
	var out []model.UserRecoveryCode
	err := r.db.WithContext(ctx).Where("user_id = ? AND used = ?", userID, false).Find(&out).Error
	return out, err
}

func (r *RecoveryCodeRepo) MarkUsed(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Model(&model.UserRecoveryCode{}).
		Where("id = ?", id).
		Updates(map[string]any{"used": true, "used_at": gorm.Expr("NOW()")}).Error
}
