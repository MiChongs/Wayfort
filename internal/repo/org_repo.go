package repo

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// ----- shared materialised-path tree helpers -----
//
// Department, UserGroup (and AssetGroup) all model a forest with a `parent_id`
// column plus a materialised `path` ("1/4/9"). These helpers operate on any
// such table by name so the move / delete-promote / create-path logic lives in
// one place. Ancestor lookups (for grant inheritance) just split the path.

type treeRow struct {
	ID       uint64
	ParentID *uint64
	Path     string
}

// treeSetPath assigns a freshly-created node its materialised path and returns
// it. Call inside the same transaction that created the row.
func treeSetPath(tx *gorm.DB, table string, id uint64, parentID *uint64) (string, error) {
	path := fmt.Sprint(id)
	if parentID != nil {
		var p treeRow
		if err := tx.Table(table).Select("id, parent_id, path").Where("id = ?", *parentID).Scan(&p).Error; err != nil {
			return "", err
		}
		if p.ID == 0 {
			return "", errors.New("父级不存在")
		}
		if p.Path != "" {
			path = p.Path + "/" + fmt.Sprint(id)
		}
	}
	if err := tx.Table(table).Where("id = ?", id).Update("path", path).Error; err != nil {
		return "", err
	}
	return path, nil
}

// treeMove reparents a node (nil == top level), rewriting the path of the node
// and its whole subtree. Refuses cycles (onto itself or a descendant).
func treeMove(tx *gorm.DB, table string, id uint64, newParent *uint64) error {
	var g treeRow
	if err := tx.Table(table).Select("id, parent_id, path").Where("id = ?", id).Scan(&g).Error; err != nil {
		return err
	}
	if g.ID == 0 {
		return errors.New("节点不存在")
	}
	oldPath := g.Path
	if oldPath == "" {
		oldPath = fmt.Sprint(id)
	}

	var newPath string
	if newParent == nil {
		newPath = fmt.Sprint(id)
	} else {
		if *newParent == id {
			return errors.New("不能移动到自身")
		}
		var parent treeRow
		if err := tx.Table(table).Select("id, parent_id, path").Where("id = ?", *newParent).Scan(&parent).Error; err != nil {
			return err
		}
		if parent.ID == 0 {
			return errors.New("目标父级不存在")
		}
		if parent.Path == oldPath || strings.HasPrefix(parent.Path, oldPath+"/") {
			return errors.New("不能移动到自己的子级下")
		}
		newPath = parent.Path + "/" + fmt.Sprint(id)
	}

	if newPath == g.Path && eqUintPtr(g.ParentID, newParent) {
		return nil
	}

	var descendants []treeRow
	if err := tx.Table(table).Select("id, parent_id, path").Where("path LIKE ?", oldPath+"/%").Scan(&descendants).Error; err != nil {
		return err
	}
	if err := tx.Table(table).Where("id = ?", id).
		Updates(map[string]any{"parent_id": newParent, "path": newPath}).Error; err != nil {
		return err
	}
	for _, d := range descendants {
		rewritten := newPath + d.Path[len(oldPath):]
		if err := tx.Table(table).Where("id = ?", d.ID).Update("path", rewritten).Error; err != nil {
			return err
		}
	}
	return nil
}

// treePromoteChildren reparents a node's direct children to that node's parent
// (their subtrees ride along) so deleting the node orphans nothing. Caller is
// responsible for deleting the node row + its membership rows afterwards.
func treePromoteChildren(tx *gorm.DB, table string, id uint64) error {
	var g treeRow
	if err := tx.Table(table).Select("id, parent_id, path").Where("id = ?", id).Scan(&g).Error; err != nil {
		return err
	}
	if g.ID == 0 {
		return nil
	}
	var children []treeRow
	if err := tx.Table(table).Select("id, parent_id, path").Where("parent_id = ?", id).Scan(&children).Error; err != nil {
		return err
	}
	for _, c := range children {
		if err := treeMove(tx, table, c.ID, g.ParentID); err != nil {
			return err
		}
	}
	return nil
}

// ancestorIDsFromPaths turns a set of materialised paths into the full ancestor
// id set (including the nodes themselves). "1/4/9" contributes 1, 4 and 9.
func ancestorIDsFromPaths(paths []string) []uint64 {
	seen := map[uint64]bool{}
	out := make([]uint64, 0, len(paths))
	for _, p := range paths {
		for _, seg := range strings.Split(p, "/") {
			if seg == "" {
				continue
			}
			id, err := strconv.ParseUint(seg, 10, 64)
			if err != nil || seen[id] {
				continue
			}
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

// ----- Department -----

type DepartmentRepo struct{ db *gorm.DB }

func NewDepartmentRepo(db *gorm.DB) *DepartmentRepo { return &DepartmentRepo{db: db} }

func (r *DepartmentRepo) Create(ctx context.Context, d *model.Department) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(d).Error; err != nil {
			return err
		}
		path, err := treeSetPath(tx, "departments", d.ID, d.ParentID)
		if err != nil {
			return err
		}
		d.Path = path
		return nil
	})
}

// Update saves the editable fields (name/description/icon/order). Parent moves
// go through Move so the subtree paths stay consistent.
func (r *DepartmentRepo) Update(ctx context.Context, d *model.Department) error {
	return r.db.WithContext(ctx).Model(&model.Department{}).Where("id = ?", d.ID).
		Updates(map[string]any{
			"name":        d.Name,
			"description": d.Description,
			"icon":        d.Icon,
			"order_idx":   d.OrderIdx,
		}).Error
}

func (r *DepartmentRepo) Move(ctx context.Context, id uint64, newParent *uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return treeMove(tx, "departments", id, newParent)
	})
}

// Delete promotes the deleted department's children to its parent, drops the
// department's user memberships, then removes the row.
func (r *DepartmentRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := treePromoteChildren(tx, "departments", id); err != nil {
			return err
		}
		if err := tx.Where("department_id = ?", id).Delete(&model.UserDepartment{}).Error; err != nil {
			return err
		}
		// Clear the denormalised primary pointer on affected users.
		if err := tx.Model(&model.User{}).Where("department_id = ?", id).
			Update("department_id", nil).Error; err != nil {
			return err
		}
		return tx.Delete(&model.Department{}, id).Error
	})
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

// ExpandWithAncestors returns the input department ids plus every ancestor, so
// grants attached to a parent department flow down to children.
func (r *DepartmentRepo) ExpandWithAncestors(ctx context.Context, ids []uint64) ([]uint64, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var paths []string
	if err := r.db.WithContext(ctx).Model(&model.Department{}).
		Where("id IN ?", ids).Pluck("path", &paths).Error; err != nil {
		return nil, err
	}
	out := ancestorIDsFromPaths(paths)
	// Guard against rows with an empty path (pre-backfill safety).
	have := map[uint64]bool{}
	for _, id := range out {
		have[id] = true
	}
	for _, id := range ids {
		if !have[id] {
			out = append(out, id)
		}
	}
	return out, nil
}

// ----- Department membership (user_departments) -----

func (r *DepartmentRepo) DepartmentsForUser(ctx context.Context, userID uint64) ([]uint64, error) {
	var out []uint64
	err := r.db.WithContext(ctx).Model(&model.UserDepartment{}).
		Where("user_id = ?", userID).Pluck("department_id", &out).Error
	return out, err
}

// DepartmentsForUsers batches the per-user department lists for a set of users.
func (r *DepartmentRepo) DepartmentsForUsers(ctx context.Context, userIDs []uint64) (map[uint64][]uint64, error) {
	out := map[uint64][]uint64{}
	if len(userIDs) == 0 {
		return out, nil
	}
	var rows []model.UserDepartment
	if err := r.db.WithContext(ctx).Where("user_id IN ?", userIDs).Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		out[row.UserID] = append(out[row.UserID], row.DepartmentID)
	}
	return out, nil
}

func (r *DepartmentRepo) MembersOf(ctx context.Context, deptID uint64) ([]uint64, error) {
	var out []uint64
	err := r.db.WithContext(ctx).Model(&model.UserDepartment{}).
		Where("department_id = ?", deptID).Pluck("user_id", &out).Error
	return out, err
}

// MembershipsByDept returns deptID -> []userID for every membership (one query),
// used by the list endpoint to attach member ids.
func (r *DepartmentRepo) MembershipsByDept(ctx context.Context) (map[uint64][]uint64, error) {
	var rows []model.UserDepartment
	if err := r.db.WithContext(ctx).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := map[uint64][]uint64{}
	for _, row := range rows {
		out[row.DepartmentID] = append(out[row.DepartmentID], row.UserID)
	}
	return out, nil
}

func (r *DepartmentRepo) AddMember(ctx context.Context, deptID, userID uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		rel := model.UserDepartment{DepartmentID: deptID, UserID: userID, JoinedAt: time.Now()}
		if err := tx.Where("department_id = ? AND user_id = ?", deptID, userID).
			FirstOrCreate(&rel).Error; err != nil {
			return err
		}
		return syncPrimaryDept(tx, userID)
	})
}

func (r *DepartmentRepo) RemoveMember(ctx context.Context, deptID, userID uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("department_id = ? AND user_id = ?", deptID, userID).
			Delete(&model.UserDepartment{}).Error; err != nil {
			return err
		}
		return syncPrimaryDept(tx, userID)
	})
}

// SetUserDepartments replaces a user's whole department set (used by the user
// create/update handlers) and keeps the denormalised primary pointer in sync.
func (r *DepartmentRepo) SetUserDepartments(ctx context.Context, userID uint64, deptIDs []uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ?", userID).Delete(&model.UserDepartment{}).Error; err != nil {
			return err
		}
		seen := map[uint64]bool{}
		now := time.Now()
		for _, id := range deptIDs {
			if id == 0 || seen[id] {
				continue
			}
			seen[id] = true
			if err := tx.Create(&model.UserDepartment{DepartmentID: id, UserID: userID, JoinedAt: now}).Error; err != nil {
				return err
			}
		}
		return syncPrimaryDept(tx, userID)
	})
}

// syncPrimaryDept refreshes users.department_id to the user's lowest-id current
// department (or NULL), keeping the back-compat column meaningful.
func syncPrimaryDept(tx *gorm.DB, userID uint64) error {
	var ids []uint64
	if err := tx.Model(&model.UserDepartment{}).Where("user_id = ?", userID).
		Order("department_id").Pluck("department_id", &ids).Error; err != nil {
		return err
	}
	// nil interface → SET department_id = NULL; a value → SET it. (Update treats
	// a literal nil as NULL, which a typed nil pointer doesn't reliably do.)
	var primary any
	if len(ids) > 0 {
		primary = ids[0]
	}
	return tx.Model(&model.User{}).Where("id = ?", userID).
		Update("department_id", primary).Error
}

// ----- UserGroup -----

type UserGroupRepo struct{ db *gorm.DB }

func NewUserGroupRepo(db *gorm.DB) *UserGroupRepo { return &UserGroupRepo{db: db} }

func (r *UserGroupRepo) Create(ctx context.Context, g *model.UserGroup) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(g).Error; err != nil {
			return err
		}
		path, err := treeSetPath(tx, "user_groups", g.ID, g.ParentID)
		if err != nil {
			return err
		}
		g.Path = path
		return nil
	})
}

func (r *UserGroupRepo) Update(ctx context.Context, g *model.UserGroup) error {
	return r.db.WithContext(ctx).Model(&model.UserGroup{}).Where("id = ?", g.ID).
		Updates(map[string]any{
			"name":        g.Name,
			"description": g.Description,
			"icon":        g.Icon,
			"order_idx":   g.OrderIdx,
		}).Error
}

func (r *UserGroupRepo) Move(ctx context.Context, id uint64, newParent *uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return treeMove(tx, "user_groups", id, newParent)
	})
}

func (r *UserGroupRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := treePromoteChildren(tx, "user_groups", id); err != nil {
			return err
		}
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
	err := r.db.WithContext(ctx).Order("path, order_idx").Find(&out).Error
	return out, err
}

// ExpandWithAncestors returns the input group ids plus every ancestor so grants
// attached to a parent group flow down to children.
func (r *UserGroupRepo) ExpandWithAncestors(ctx context.Context, ids []uint64) ([]uint64, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var paths []string
	if err := r.db.WithContext(ctx).Model(&model.UserGroup{}).
		Where("id IN ?", ids).Pluck("path", &paths).Error; err != nil {
		return nil, err
	}
	out := ancestorIDsFromPaths(paths)
	have := map[uint64]bool{}
	for _, id := range out {
		have[id] = true
	}
	for _, id := range ids {
		if !have[id] {
			out = append(out, id)
		}
	}
	return out, nil
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
	var out []uint64
	err := r.db.WithContext(ctx).Model(&model.UserGroupMember{}).
		Where("user_id = ?", userID).Pluck("group_id", &out).Error
	return out, err
}

func (r *UserGroupRepo) MembersOfGroup(ctx context.Context, groupID uint64) ([]uint64, error) {
	var out []uint64
	err := r.db.WithContext(ctx).Model(&model.UserGroupMember{}).
		Where("group_id = ?", groupID).Pluck("user_id", &out).Error
	return out, err
}

// MembershipsByGroup returns groupID -> []userID for every membership (one
// query), used by the list endpoint to attach member ids.
func (r *UserGroupRepo) MembershipsByGroup(ctx context.Context) (map[uint64][]uint64, error) {
	var rows []model.UserGroupMember
	if err := r.db.WithContext(ctx).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := map[uint64][]uint64{}
	for _, row := range rows {
		out[row.GroupID] = append(out[row.GroupID], row.UserID)
	}
	return out, nil
}

// ----- one-time backfill -----

// BackfillOrg makes existing data consistent with the redesigned org model:
//   - gives every department / user_group an empty path a self-path (id)
//   - migrates the legacy users.department_id into the user_departments table
//
// It is idempotent and cheap; run once after AutoMigrate on boot.
func BackfillOrg(ctx context.Context, db *gorm.DB) error {
	if err := db.WithContext(ctx).Exec(
		"UPDATE departments SET path = CAST(id AS TEXT) WHERE path IS NULL OR path = ''").Error; err != nil {
		return err
	}
	if err := db.WithContext(ctx).Exec(
		"UPDATE user_groups SET path = CAST(id AS TEXT) WHERE path IS NULL OR path = ''").Error; err != nil {
		return err
	}
	// User groups are now a tree; drop the legacy global-unique-name index so
	// sibling / cousin groups in different branches can share a name. Safe no-op
	// if it was never created.
	if err := db.WithContext(ctx).Exec("DROP INDEX IF EXISTS idx_user_groups_name").Error; err != nil {
		return err
	}
	return db.WithContext(ctx).Exec(`
		INSERT INTO user_departments (user_id, department_id, joined_at)
		SELECT u.id, u.department_id, NOW() FROM users u
		WHERE u.department_id IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM user_departments ud
			WHERE ud.user_id = u.id AND ud.department_id = u.department_id
		)`).Error
}
