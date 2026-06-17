package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/gorm"
)

type RoleRepo struct{ db *gorm.DB }

func NewRoleRepo(db *gorm.DB) *RoleRepo { return &RoleRepo{db: db} }

func (r *RoleRepo) DB() *gorm.DB { return r.db }

func (r *RoleRepo) Create(ctx context.Context, role *model.Role) error {
	return r.db.WithContext(ctx).Create(role).Error
}

func (r *RoleRepo) Update(ctx context.Context, role *model.Role) error {
	return r.db.WithContext(ctx).Save(role).Error
}

func (r *RoleRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var role model.Role
		if err := tx.First(&role, id).Error; err != nil {
			return err
		}
		if role.IsSystem {
			return errors.New("system role cannot be deleted")
		}
		if err := tx.Where("role_id = ?", id).Delete(&model.RolePermission{}).Error; err != nil {
			return err
		}
		if err := tx.Where("role_id = ?", id).Delete(&model.UserRole{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.Role{}, id).Error
	})
}

func (r *RoleRepo) FindByID(ctx context.Context, id uint64) (*model.Role, error) {
	var role model.Role
	err := r.db.WithContext(ctx).First(&role, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &role, err
}

func (r *RoleRepo) FindByName(ctx context.Context, name string) (*model.Role, error) {
	var role model.Role
	err := r.db.WithContext(ctx).Where("name = ?", name).First(&role).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &role, err
}

func (r *RoleRepo) List(ctx context.Context) ([]model.Role, error) {
	var out []model.Role
	err := r.db.WithContext(ctx).Order("id").Find(&out).Error
	return out, err
}

// SetPermissions replaces a role's permission set atomically.
func (r *RoleRepo) SetPermissions(ctx context.Context, roleID uint64, perms []string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("role_id = ?", roleID).Delete(&model.RolePermission{}).Error; err != nil {
			return err
		}
		if len(perms) == 0 {
			return nil
		}
		rows := make([]model.RolePermission, 0, len(perms))
		for _, p := range perms {
			rows = append(rows, model.RolePermission{RoleID: roleID, PermissionCode: p})
		}
		return tx.Create(&rows).Error
	})
}

func (r *RoleRepo) PermissionsFor(ctx context.Context, roleID uint64) ([]string, error) {
	var rows []model.RolePermission
	if err := r.db.WithContext(ctx).Where("role_id = ?", roleID).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.PermissionCode)
	}
	return out, nil
}

// AssignToUser grants role to user; idempotent.
func (r *RoleRepo) AssignToUser(ctx context.Context, userID, roleID uint64, grantedBy *uint64) error {
	rel := model.UserRole{UserID: userID, RoleID: roleID, GrantedAt: time.Now(), GrantedBy: grantedBy}
	return r.db.WithContext(ctx).Where("user_id = ? AND role_id = ?", userID, roleID).
		FirstOrCreate(&rel).Error
}

func (r *RoleRepo) UnassignFromUser(ctx context.Context, userID, roleID uint64) error {
	return r.db.WithContext(ctx).Where("user_id = ? AND role_id = ?", userID, roleID).
		Delete(&model.UserRole{}).Error
}

// ReplaceUserRoles atomically replaces a user's role set.
func (r *RoleRepo) ReplaceUserRoles(ctx context.Context, userID uint64, roleIDs []uint64, grantedBy *uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userID).Delete(&model.UserRole{}).Error; err != nil {
			return err
		}
		if len(roleIDs) == 0 {
			return nil
		}
		now := time.Now()
		rows := make([]model.UserRole, 0, len(roleIDs))
		for _, rid := range roleIDs {
			rows = append(rows, model.UserRole{UserID: userID, RoleID: rid, GrantedAt: now, GrantedBy: grantedBy})
		}
		return tx.Create(&rows).Error
	})
}

func (r *RoleRepo) RolesForUser(ctx context.Context, userID uint64) ([]model.Role, error) {
	var rows []model.UserRole
	if err := r.db.WithContext(ctx).Where("user_id = ?", userID).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	ids := make([]uint64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.RoleID)
	}
	var roles []model.Role
	err := r.db.WithContext(ctx).Where("id IN ?", ids).Find(&roles).Error
	return roles, err
}

func (r *RoleRepo) PermissionsForUser(ctx context.Context, userID uint64) ([]string, error) {
	roles, err := r.RolesForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(roles) == 0 {
		return nil, nil
	}
	ids := make([]uint64, 0, len(roles))
	for _, role := range roles {
		ids = append(ids, role.ID)
	}
	var rows []model.RolePermission
	if err := r.db.WithContext(ctx).Where("role_id IN ?", ids).Find(&rows).Error; err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(rows))
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		if _, ok := seen[row.PermissionCode]; ok {
			continue
		}
		seen[row.PermissionCode] = struct{}{}
		out = append(out, row.PermissionCode)
	}
	return out, nil
}

// SyncPermissions populates the permissions table with the supplied catalogue.
// It is safe to call repeatedly: rows are upserted on PermissionCode primary key.
func (r *RoleRepo) SyncPermissions(ctx context.Context, perms []model.Permission) error {
	if len(perms) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Save(&perms).Error
}

func (r *RoleRepo) ListPermissions(ctx context.Context) ([]model.Permission, error) {
	var out []model.Permission
	err := r.db.WithContext(ctx).Order("category, code").Find(&out).Error
	return out, err
}
