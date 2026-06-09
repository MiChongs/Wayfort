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

// ----- Catalog (授权目录) -----
//
// Catalogs are admin-authored asset directories, independent of the global
// asset-group tree. The folder tree reuses the materialised-path pattern from
// AssetGroupRepo, but Delete deletes the whole subtree (a folder is a grant
// unit, so promoting children would silently re-scope an existing folder
// assignment). asset.Resolver resolves assignments into the same access set as
// AssetGrant, so the enforcement path is unchanged.

type CatalogRepo struct{ db *gorm.DB }

func NewCatalogRepo(db *gorm.DB) *CatalogRepo { return &CatalogRepo{db: db} }

func (r *CatalogRepo) Create(ctx context.Context, c *model.Catalog) error {
	return r.db.WithContext(ctx).Create(c).Error
}
func (r *CatalogRepo) Update(ctx context.Context, c *model.Catalog) error {
	return r.db.WithContext(ctx).Save(c).Error
}
func (r *CatalogRepo) FindByID(ctx context.Context, id uint64) (*model.Catalog, error) {
	var c model.Catalog
	err := r.db.WithContext(ctx).First(&c, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &c, err
}
func (r *CatalogRepo) List(ctx context.Context) ([]model.Catalog, error) {
	var out []model.Catalog
	err := r.db.WithContext(ctx).Order("id DESC").Find(&out).Error
	return out, err
}

// Delete removes a catalog and everything under it (folders, placements,
// assignments) in one transaction.
func (r *CatalogRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("catalog_id = ?", id).Delete(&model.CatalogPlacement{}).Error; err != nil {
			return err
		}
		if err := tx.Where("catalog_id = ?", id).Delete(&model.CatalogAssignment{}).Error; err != nil {
			return err
		}
		if err := tx.Where("catalog_id = ?", id).Delete(&model.CatalogFolder{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.Catalog{}, id).Error
	})
}

// ----- CatalogFolder -----

type CatalogFolderRepo struct{ db *gorm.DB }

func NewCatalogFolderRepo(db *gorm.DB) *CatalogFolderRepo { return &CatalogFolderRepo{db: db} }

// Create inserts a folder and computes its materialised path in one transaction
// (path is the chain of folder IDs, e.g. "12/45").
func (r *CatalogFolderRepo) Create(ctx context.Context, f *model.CatalogFolder) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(f).Error; err != nil {
			return err
		}
		path := fmt.Sprint(f.ID)
		if f.ParentID != nil {
			var parent model.CatalogFolder
			if err := tx.First(&parent, *f.ParentID).Error; err == nil && parent.Path != "" {
				path = parent.Path + "/" + fmt.Sprint(f.ID)
			}
		}
		f.Path = path
		return tx.Model(&model.CatalogFolder{}).Where("id = ?", f.ID).Update("path", path).Error
	})
}
func (r *CatalogFolderRepo) Update(ctx context.Context, f *model.CatalogFolder) error {
	return r.db.WithContext(ctx).Save(f).Error
}
func (r *CatalogFolderRepo) FindByID(ctx context.Context, id uint64) (*model.CatalogFolder, error) {
	var f model.CatalogFolder
	err := r.db.WithContext(ctx).First(&f, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &f, err
}
func (r *CatalogFolderRepo) ListByCatalog(ctx context.Context, catalogID uint64) ([]model.CatalogFolder, error) {
	var out []model.CatalogFolder
	err := r.db.WithContext(ctx).Where("catalog_id = ?", catalogID).Order("path").Find(&out).Error
	return out, err
}

// Subtree returns the folder identified by path plus all its descendants, scoped
// to the catalog. The `path = ? OR path LIKE ?/%` form avoids the classic prefix
// bug where "12" would also match "120".
func (r *CatalogFolderRepo) Subtree(ctx context.Context, catalogID uint64, path string) ([]model.CatalogFolder, error) {
	var out []model.CatalogFolder
	err := r.db.WithContext(ctx).
		Where("catalog_id = ?", catalogID).
		Where("path = ? OR path LIKE ?", path, path+"/%").
		Find(&out).Error
	return out, err
}

// Move reparents a folder under newParent (nil == top level), rewriting the
// materialised path of the folder and its whole subtree. Refuses cycle-creating
// moves and cross-catalog moves.
func (r *CatalogFolderRepo) Move(ctx context.Context, id uint64, newParent *uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return r.moveTx(tx, id, newParent)
	})
}

func (r *CatalogFolderRepo) moveTx(tx *gorm.DB, id uint64, newParent *uint64) error {
	var f model.CatalogFolder
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
		var parent model.CatalogFolder
		if err := tx.First(&parent, *newParent).Error; err != nil {
			return errors.New("目标父文件夹不存在")
		}
		if parent.CatalogID != f.CatalogID {
			return errors.New("不能跨目录移动")
		}
		if parent.Path == oldPath || strings.HasPrefix(parent.Path, oldPath+"/") {
			return errors.New("不能移动到自己的子文件夹下")
		}
		newPath = parent.Path + "/" + fmt.Sprint(id)
	}

	if newPath == f.Path && eqUintPtr(f.ParentID, newParent) {
		return nil
	}

	// Capture descendants (by the OLD path prefix) before mutating this row.
	var descendants []model.CatalogFolder
	if err := tx.Where("catalog_id = ?", f.CatalogID).
		Where("path LIKE ?", oldPath+"/%").Find(&descendants).Error; err != nil {
		return err
	}
	if err := tx.Model(&model.CatalogFolder{}).Where("id = ?", id).
		Updates(map[string]any{"parent_id": newParent, "path": newPath}).Error; err != nil {
		return err
	}
	for _, d := range descendants {
		rewritten := newPath + d.Path[len(oldPath):]
		if err := tx.Model(&model.CatalogFolder{}).Where("id = ?", d.ID).
			Update("path", rewritten).Error; err != nil {
			return err
		}
	}
	return nil
}

// Delete removes a folder AND its whole subtree: the descendant folders, the
// placements inside them, and any assignment scoped to a folder in the subtree.
// Unlike AssetGroupRepo.Delete it does NOT promote children — a folder is a
// grant unit, and promoting would silently re-scope an existing assignment.
func (r *CatalogFolderRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var f model.CatalogFolder
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
		var subtree []model.CatalogFolder
		if err := tx.Where("catalog_id = ?", f.CatalogID).
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
		if err := tx.Where("folder_id IN ?", ids).Delete(&model.CatalogPlacement{}).Error; err != nil {
			return err
		}
		if err := tx.Where("folder_id IN ?", ids).Delete(&model.CatalogAssignment{}).Error; err != nil {
			return err
		}
		return tx.Where("id IN ?", ids).Delete(&model.CatalogFolder{}).Error
	})
}

// ----- CatalogPlacement -----

type CatalogPlacementRepo struct{ db *gorm.DB }

func NewCatalogPlacementRepo(db *gorm.DB) *CatalogPlacementRepo { return &CatalogPlacementRepo{db: db} }

// Add places a node in a folder. Idempotent within a (folder, node) pair, but a
// node may live in many folders (placements are intentionally non-unique across
// folders).
func (r *CatalogPlacementRepo) Add(ctx context.Context, catalogID, folderID, nodeID uint64) error {
	p := model.CatalogPlacement{CatalogID: catalogID, FolderID: folderID, NodeID: nodeID, CreatedAt: time.Now()}
	return r.db.WithContext(ctx).
		Where("folder_id = ? AND node_id = ?", folderID, nodeID).
		FirstOrCreate(&p).Error
}
func (r *CatalogPlacementRepo) Remove(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.CatalogPlacement{}, id).Error
}
func (r *CatalogPlacementRepo) RemoveFolderNode(ctx context.Context, folderID, nodeID uint64) error {
	return r.db.WithContext(ctx).
		Where("folder_id = ? AND node_id = ?", folderID, nodeID).
		Delete(&model.CatalogPlacement{}).Error
}
func (r *CatalogPlacementRepo) ListByCatalog(ctx context.Context, catalogID uint64) ([]model.CatalogPlacement, error) {
	var out []model.CatalogPlacement
	err := r.db.WithContext(ctx).Where("catalog_id = ?", catalogID).
		Order("sort_order, id").Find(&out).Error
	return out, err
}

// NodesInCatalog returns the distinct node IDs placed anywhere in the catalog.
func (r *CatalogPlacementRepo) NodesInCatalog(ctx context.Context, catalogID uint64) ([]uint64, error) {
	var out []uint64
	err := r.db.WithContext(ctx).Model(&model.CatalogPlacement{}).
		Where("catalog_id = ?", catalogID).Distinct().Pluck("node_id", &out).Error
	return out, err
}

// NodesInFolders returns the distinct node IDs placed in any of the folders.
func (r *CatalogPlacementRepo) NodesInFolders(ctx context.Context, folderIDs []uint64) ([]uint64, error) {
	if len(folderIDs) == 0 {
		return nil, nil
	}
	var out []uint64
	err := r.db.WithContext(ctx).Model(&model.CatalogPlacement{}).
		Where("folder_id IN ?", folderIDs).Distinct().Pluck("node_id", &out).Error
	return out, err
}

// PurgeNode drops every placement referencing a node — called when a node is
// deleted so no dangling placements remain.
func (r *CatalogPlacementRepo) PurgeNode(ctx context.Context, nodeID uint64) error {
	return r.db.WithContext(ctx).Where("node_id = ?", nodeID).Delete(&model.CatalogPlacement{}).Error
}

// ----- CatalogAssignment -----

type CatalogAssignmentRepo struct{ db *gorm.DB }

func NewCatalogAssignmentRepo(db *gorm.DB) *CatalogAssignmentRepo {
	return &CatalogAssignmentRepo{db: db}
}

func (r *CatalogAssignmentRepo) Create(ctx context.Context, a *model.CatalogAssignment) error {
	return r.db.WithContext(ctx).Create(a).Error
}
func (r *CatalogAssignmentRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.CatalogAssignment{}, id).Error
}
func (r *CatalogAssignmentRepo) ListByCatalog(ctx context.Context, catalogID uint64) ([]model.CatalogAssignment, error) {
	var out []model.CatalogAssignment
	err := r.db.WithContext(ctx).Where("catalog_id = ?", catalogID).Order("id DESC").Find(&out).Error
	return out, err
}
func (r *CatalogAssignmentRepo) List(ctx context.Context) ([]model.CatalogAssignment, error) {
	var out []model.CatalogAssignment
	err := r.db.WithContext(ctx).Order("id DESC").Find(&out).Error
	return out, err
}

// ListForGrantees fetches every still-valid catalog assignment aimed at any of
// the supplied (type, id) pairs — the catalog twin of GrantRepo.ListForGrantees.
func (r *CatalogAssignmentRepo) ListForGrantees(ctx context.Context, granteeTypes []model.GranteeType, granteeIDs []uint64) ([]model.CatalogAssignment, error) {
	if len(granteeIDs) == 0 || len(granteeTypes) == 0 {
		return nil, nil
	}
	var out []model.CatalogAssignment
	now := time.Now()
	err := r.db.WithContext(ctx).
		Where("grantee_type IN ?", granteeTypes).
		Where("grantee_id IN ?", granteeIDs).
		Where("(valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)", now, now).
		Find(&out).Error
	return out, err
}
