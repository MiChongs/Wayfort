package repo

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// ----- Access tree (授权目录) -----
//
// Each authorisation object (user / group / department) owns a folder tree of
// assets with inline permissions. The folder tree reuses the materialised-path
// pattern from AssetGroupRepo, scoped to the owner; Delete deletes the whole
// subtree (a folder carries grants, so promoting children would silently
// re-scope access). asset.Resolver flattens an owner's tree into the same access
// set as AssetGrant, and members inherit their group / department tree.

type AccessFolderRepo struct{ db *gorm.DB }

func NewAccessFolderRepo(db *gorm.DB) *AccessFolderRepo { return &AccessFolderRepo{db: db} }

// Create inserts a folder and computes its materialised path in one transaction.
func (r *AccessFolderRepo) Create(ctx context.Context, f *model.AccessFolder) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(f).Error; err != nil {
			return err
		}
		path := fmt.Sprint(f.ID)
		if f.ParentID != nil {
			var parent model.AccessFolder
			if err := tx.First(&parent, *f.ParentID).Error; err == nil && parent.Path != "" {
				path = parent.Path + "/" + fmt.Sprint(f.ID)
			}
		}
		f.Path = path
		return tx.Model(&model.AccessFolder{}).Where("id = ?", f.ID).Update("path", path).Error
	})
}
func (r *AccessFolderRepo) Update(ctx context.Context, f *model.AccessFolder) error {
	return r.db.WithContext(ctx).Save(f).Error
}
func (r *AccessFolderRepo) FindByID(ctx context.Context, id uint64) (*model.AccessFolder, error) {
	var f model.AccessFolder
	err := r.db.WithContext(ctx).First(&f, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &f, err
}
func (r *AccessFolderRepo) ListByOwner(ctx context.Context, ownerType model.GranteeType, ownerID uint64) ([]model.AccessFolder, error) {
	var out []model.AccessFolder
	err := r.db.WithContext(ctx).
		Where("owner_type = ? AND owner_id = ?", ownerType, ownerID).Order("path").Find(&out).Error
	return out, err
}

// ListByOwnerSet returns folders for many owners of one type — used by the
// resolver (members inherit their group / department trees) and /me/directory.
func (r *AccessFolderRepo) ListByOwnerSet(ctx context.Context, ownerType model.GranteeType, ownerIDs []uint64) ([]model.AccessFolder, error) {
	if len(ownerIDs) == 0 {
		return nil, nil
	}
	var out []model.AccessFolder
	err := r.db.WithContext(ctx).
		Where("owner_type = ? AND owner_id IN ?", ownerType, ownerIDs).Order("path").Find(&out).Error
	return out, err
}

// Subtree returns a folder plus its descendants, scoped to the owner. The
// `path = ? OR path LIKE ?/%` form avoids the "12" matching "120" prefix bug.
func (r *AccessFolderRepo) Subtree(ctx context.Context, ownerType model.GranteeType, ownerID uint64, path string) ([]model.AccessFolder, error) {
	var out []model.AccessFolder
	err := r.db.WithContext(ctx).
		Where("owner_type = ? AND owner_id = ?", ownerType, ownerID).
		Where("path = ? OR path LIKE ?", path, path+"/%").Find(&out).Error
	return out, err
}

func (r *AccessFolderRepo) Move(ctx context.Context, id uint64, newParent *uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return r.moveTx(tx, id, newParent)
	})
}

func (r *AccessFolderRepo) moveTx(tx *gorm.DB, id uint64, newParent *uint64) error {
	var f model.AccessFolder
	if err := tx.First(&f, id).Error; err != nil {
		return err
	}
	oldPath := f.Path
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
		var parent model.AccessFolder
		if err := tx.First(&parent, *newParent).Error; err != nil {
			return errors.New("目标父文件夹不存在")
		}
		if parent.OwnerType != f.OwnerType || parent.OwnerID != f.OwnerID {
			return errors.New("不能跨对象移动")
		}
		if parent.Path == oldPath || strings.HasPrefix(parent.Path, oldPath+"/") {
			return errors.New("不能移动到自己的子文件夹下")
		}
		newPath = parent.Path + "/" + fmt.Sprint(id)
	}
	if newPath == f.Path && eqUintPtr(f.ParentID, newParent) {
		return nil
	}
	var descendants []model.AccessFolder
	if err := tx.Where("owner_type = ? AND owner_id = ?", f.OwnerType, f.OwnerID).
		Where("path LIKE ?", oldPath+"/%").Find(&descendants).Error; err != nil {
		return err
	}
	if err := tx.Model(&model.AccessFolder{}).Where("id = ?", id).
		Updates(map[string]any{"parent_id": newParent, "path": newPath}).Error; err != nil {
		return err
	}
	for _, d := range descendants {
		rewritten := newPath + d.Path[len(oldPath):]
		if err := tx.Model(&model.AccessFolder{}).Where("id = ?", d.ID).
			Update("path", rewritten).Error; err != nil {
			return err
		}
	}
	return nil
}

// Delete removes a folder AND its whole subtree (descendant folders + the items
// inside them). It does NOT promote children — a folder carries grants, and
// promoting would silently re-scope access.
func (r *AccessFolderRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var f model.AccessFolder
		if err := tx.First(&f, id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		path := f.Path
		if path == "" {
			path = fmt.Sprint(id)
		}
		var subtree []model.AccessFolder
		if err := tx.Where("owner_type = ? AND owner_id = ?", f.OwnerType, f.OwnerID).
			Where("path = ? OR path LIKE ?", path, path+"/%").Find(&subtree).Error; err != nil {
			return err
		}
		ids := make([]uint64, 0, len(subtree))
		for _, s := range subtree {
			ids = append(ids, s.ID)
		}
		if len(ids) == 0 {
			ids = []uint64{id}
		}
		if err := tx.Where("folder_id IN ?", ids).Delete(&model.AccessItem{}).Error; err != nil {
			return err
		}
		return tx.Where("id IN ?", ids).Delete(&model.AccessFolder{}).Error
	})
}

// ----- AccessItem -----

type AccessItemRepo struct{ db *gorm.DB }

func NewAccessItemRepo(db *gorm.DB) *AccessItemRepo { return &AccessItemRepo{db: db} }

// Add places a node in a folder. Idempotent within a (folder, node) pair.
func (r *AccessItemRepo) Add(ctx context.Context, it *model.AccessItem) error {
	it.CreatedAt = time.Now()
	return r.db.WithContext(ctx).
		Where("owner_type = ? AND owner_id = ? AND folder_id = ? AND node_id = ?", it.OwnerType, it.OwnerID, it.FolderID, it.NodeID).
		FirstOrCreate(it).Error
}
func (r *AccessItemRepo) Update(ctx context.Context, it *model.AccessItem) error {
	return r.db.WithContext(ctx).Save(it).Error
}
func (r *AccessItemRepo) FindByID(ctx context.Context, id uint64) (*model.AccessItem, error) {
	var it model.AccessItem
	err := r.db.WithContext(ctx).First(&it, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &it, err
}
func (r *AccessItemRepo) Remove(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.AccessItem{}, id).Error
}
func (r *AccessItemRepo) ListByOwner(ctx context.Context, ownerType model.GranteeType, ownerID uint64) ([]model.AccessItem, error) {
	var out []model.AccessItem
	err := r.db.WithContext(ctx).
		Where("owner_type = ? AND owner_id = ?", ownerType, ownerID).Order("sort_order, id").Find(&out).Error
	return out, err
}
func (r *AccessItemRepo) ListByOwnerSet(ctx context.Context, ownerType model.GranteeType, ownerIDs []uint64) ([]model.AccessItem, error) {
	if len(ownerIDs) == 0 {
		return nil, nil
	}
	var out []model.AccessItem
	err := r.db.WithContext(ctx).
		Where("owner_type = ? AND owner_id IN ?", ownerType, ownerIDs).Order("sort_order, id").Find(&out).Error
	return out, err
}

// ListByNode returns every item that places the node — backs "按资产看".
func (r *AccessItemRepo) ListByNode(ctx context.Context, nodeID uint64) ([]model.AccessItem, error) {
	var out []model.AccessItem
	err := r.db.WithContext(ctx).Where("node_id = ?", nodeID).Find(&out).Error
	return out, err
}

// PurgeNode drops every item referencing a node — called when a node is deleted.
func (r *AccessItemRepo) PurgeNode(ctx context.Context, nodeID uint64) error {
	return r.db.WithContext(ctx).Where("node_id = ?", nodeID).Delete(&model.AccessItem{}).Error
}
