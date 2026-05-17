package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

type UserRepo struct{ db *gorm.DB }

func NewUserRepo(db *gorm.DB) *UserRepo { return &UserRepo{db: db} }

func (r *UserRepo) FindByUsername(ctx context.Context, username string) (*model.User, error) {
	var u model.User
	err := r.db.WithContext(ctx).Where("username = ?", username).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &u, err
}

func (r *UserRepo) FindByEmail(ctx context.Context, email string) (*model.User, error) {
	var u model.User
	err := r.db.WithContext(ctx).Where("email = ?", email).First(&u).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &u, err
}

func (r *UserRepo) FindByID(ctx context.Context, id uint64) (*model.User, error) {
	var u model.User
	err := r.db.WithContext(ctx).First(&u, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &u, err
}

func (r *UserRepo) Create(ctx context.Context, u *model.User) error {
	return r.db.WithContext(ctx).Create(u).Error
}

func (r *UserRepo) Update(ctx context.Context, u *model.User) error {
	return r.db.WithContext(ctx).Save(u).Error
}

func (r *UserRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Cascade clean joined tables.
		if err := tx.Where("user_id = ?", id).Delete(&model.UserRole{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.UserGroupMember{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.UserMFA{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.UserRecoveryCode{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.WebauthnCredential{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.NodeFavorite{}).Error; err != nil {
			return err
		}
		if err := tx.Where("user_id = ?", id).Delete(&model.NodeRecent{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.User{}, id).Error
	})
}

type UserFilter struct {
	Search       string
	DepartmentID *uint64
	Disabled     *bool
	Limit        int
	Offset       int
}

func (r *UserRepo) List(ctx context.Context, f UserFilter) ([]model.User, error) {
	q := r.db.WithContext(ctx).Model(&model.User{})
	if f.Search != "" {
		s := "%" + f.Search + "%"
		q = q.Where("username LIKE ? OR display_name LIKE ? OR email LIKE ?", s, s, s)
	}
	if f.DepartmentID != nil {
		q = q.Where("department_id = ?", *f.DepartmentID)
	}
	if f.Disabled != nil {
		q = q.Where("disabled = ?", *f.Disabled)
	}
	if f.Limit <= 0 {
		f.Limit = 100
	}
	q = q.Order("id").Limit(f.Limit).Offset(f.Offset)
	var out []model.User
	err := q.Find(&out).Error
	return out, err
}

// RecordLoginSuccess updates the user's last login fingerprint.
func (r *UserRepo) RecordLoginSuccess(ctx context.Context, id uint64, ip, ua string) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&model.User{}).
		Where("id = ?", id).
		Updates(map[string]any{
			"last_login_at":   &now,
			"last_login_ip":   ip,
			"last_user_agent": ua,
			"locked_until":    nil,
		}).Error
}

func (r *UserRepo) SetLockedUntil(ctx context.Context, id uint64, until *time.Time) error {
	return r.db.WithContext(ctx).Model(&model.User{}).
		Where("id = ?", id).
		Update("locked_until", until).Error
}

func (r *UserRepo) UpdatePassword(ctx context.Context, id uint64, hash string) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&model.User{}).
		Where("id = ?", id).
		Updates(map[string]any{"password_hash": hash, "password_changed": &now}).Error
}
