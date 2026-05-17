package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// ----- Department -----

type DepartmentRepo struct{ db *gorm.DB }

func NewDepartmentRepo(db *gorm.DB) *DepartmentRepo { return &DepartmentRepo{db: db} }

func (r *DepartmentRepo) Create(ctx context.Context, d *model.Department) error {
	return r.db.WithContext(ctx).Create(d).Error
}
func (r *DepartmentRepo) Update(ctx context.Context, d *model.Department) error {
	return r.db.WithContext(ctx).Save(d).Error
}
func (r *DepartmentRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.Department{}, id).Error
}
func (r *DepartmentRepo) FindByID(ctx context.Context, id uint64) (*model.Department, error) {
	var d model.Department
	err := r.db.WithContext(ctx).First(&d, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &d, err
}
func (r *DepartmentRepo) List(ctx context.Context) ([]model.Department, error) {
	var out []model.Department
	err := r.db.WithContext(ctx).Order("path, order_idx").Find(&out).Error
	return out, err
}

// ----- UserGroup -----

type UserGroupRepo struct{ db *gorm.DB }

func NewUserGroupRepo(db *gorm.DB) *UserGroupRepo { return &UserGroupRepo{db: db} }

func (r *UserGroupRepo) Create(ctx context.Context, g *model.UserGroup) error {
	return r.db.WithContext(ctx).Create(g).Error
}
func (r *UserGroupRepo) Update(ctx context.Context, g *model.UserGroup) error {
	return r.db.WithContext(ctx).Save(g).Error
}
func (r *UserGroupRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("group_id = ?", id).Delete(&model.UserGroupMember{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.UserGroup{}, id).Error
	})
}
func (r *UserGroupRepo) FindByID(ctx context.Context, id uint64) (*model.UserGroup, error) {
	var g model.UserGroup
	err := r.db.WithContext(ctx).First(&g, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &g, err
}
func (r *UserGroupRepo) List(ctx context.Context) ([]model.UserGroup, error) {
	var out []model.UserGroup
	err := r.db.WithContext(ctx).Order("id").Find(&out).Error
	return out, err
}
func (r *UserGroupRepo) AddMember(ctx context.Context, groupID, userID uint64) error {
	rel := model.UserGroupMember{GroupID: groupID, UserID: userID, JoinedAt: time.Now()}
	return r.db.WithContext(ctx).Where("group_id = ? AND user_id = ?", groupID, userID).
		FirstOrCreate(&rel).Error
}
func (r *UserGroupRepo) RemoveMember(ctx context.Context, groupID, userID uint64) error {
	return r.db.WithContext(ctx).Where("group_id = ? AND user_id = ?", groupID, userID).
		Delete(&model.UserGroupMember{}).Error
}
func (r *UserGroupRepo) GroupsForUser(ctx context.Context, userID uint64) ([]uint64, error) {
	var rows []model.UserGroupMember
	if err := r.db.WithContext(ctx).Where("user_id = ?", userID).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]uint64, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.GroupID)
	}
	return out, nil
}
func (r *UserGroupRepo) MembersOfGroup(ctx context.Context, groupID uint64) ([]uint64, error) {
	var rows []model.UserGroupMember
	if err := r.db.WithContext(ctx).Where("group_id = ?", groupID).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]uint64, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.UserID)
	}
	return out, nil
}
