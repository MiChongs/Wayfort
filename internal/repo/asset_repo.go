package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// ----- AssetGroup -----

type AssetGroupRepo struct{ db *gorm.DB }

func NewAssetGroupRepo(db *gorm.DB) *AssetGroupRepo { return &AssetGroupRepo{db: db} }

func (r *AssetGroupRepo) Create(ctx context.Context, g *model.AssetGroup) error {
	return r.db.WithContext(ctx).Create(g).Error
}
func (r *AssetGroupRepo) Update(ctx context.Context, g *model.AssetGroup) error {
	return r.db.WithContext(ctx).Save(g).Error
}
func (r *AssetGroupRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("group_id = ?", id).Delete(&model.AssetGroupNode{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.AssetGroup{}, id).Error
	})
}
func (r *AssetGroupRepo) FindByID(ctx context.Context, id uint64) (*model.AssetGroup, error) {
	var g model.AssetGroup
	err := r.db.WithContext(ctx).First(&g, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &g, err
}
func (r *AssetGroupRepo) List(ctx context.Context) ([]model.AssetGroup, error) {
	var out []model.AssetGroup
	err := r.db.WithContext(ctx).Order("path").Find(&out).Error
	return out, err
}
func (r *AssetGroupRepo) Subtree(ctx context.Context, path string) ([]model.AssetGroup, error) {
	var out []model.AssetGroup
	err := r.db.WithContext(ctx).Where("path LIKE ?", path+"%").Find(&out).Error
	return out, err
}
func (r *AssetGroupRepo) NodesIn(ctx context.Context, groupIDs []uint64) ([]uint64, error) {
	if len(groupIDs) == 0 {
		return nil, nil
	}
	var rows []model.AssetGroupNode
	if err := r.db.WithContext(ctx).Where("group_id IN ?", groupIDs).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]uint64, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.NodeID)
	}
	return out, nil
}

// MembersByGroup returns a per-group map of node IDs. Used by the workspace
// tree to render groups → members without N round-trips.
func (r *AssetGroupRepo) MembersByGroup(ctx context.Context, groupIDs []uint64) (map[uint64][]uint64, error) {
	if len(groupIDs) == 0 {
		return map[uint64][]uint64{}, nil
	}
	var rows []model.AssetGroupNode
	if err := r.db.WithContext(ctx).Where("group_id IN ?", groupIDs).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[uint64][]uint64, len(groupIDs))
	for _, row := range rows {
		out[row.GroupID] = append(out[row.GroupID], row.NodeID)
	}
	return out, nil
}
func (r *AssetGroupRepo) AddNode(ctx context.Context, groupID, nodeID uint64) error {
	rel := model.AssetGroupNode{GroupID: groupID, NodeID: nodeID}
	return r.db.WithContext(ctx).Where("group_id = ? AND node_id = ?", groupID, nodeID).
		FirstOrCreate(&rel).Error
}
func (r *AssetGroupRepo) RemoveNode(ctx context.Context, groupID, nodeID uint64) error {
	return r.db.WithContext(ctx).Where("group_id = ? AND node_id = ?", groupID, nodeID).
		Delete(&model.AssetGroupNode{}).Error
}

// ----- AssetTag -----

type TagRepo struct{ db *gorm.DB }

func NewTagRepo(db *gorm.DB) *TagRepo { return &TagRepo{db: db} }

func (r *TagRepo) Create(ctx context.Context, t *model.AssetTag) error {
	return r.db.WithContext(ctx).Create(t).Error
}
func (r *TagRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("tag_id = ?", id).Delete(&model.NodeTag{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.AssetTag{}, id).Error
	})
}
func (r *TagRepo) FindByID(ctx context.Context, id uint64) (*model.AssetTag, error) {
	var t model.AssetTag
	err := r.db.WithContext(ctx).First(&t, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &t, err
}
func (r *TagRepo) List(ctx context.Context) ([]model.AssetTag, error) {
	var out []model.AssetTag
	err := r.db.WithContext(ctx).Order("name").Find(&out).Error
	return out, err
}
func (r *TagRepo) AttachToNode(ctx context.Context, nodeID, tagID uint64) error {
	rel := model.NodeTag{NodeID: nodeID, TagID: tagID}
	return r.db.WithContext(ctx).Where("node_id = ? AND tag_id = ?", nodeID, tagID).FirstOrCreate(&rel).Error
}
func (r *TagRepo) DetachFromNode(ctx context.Context, nodeID, tagID uint64) error {
	return r.db.WithContext(ctx).Where("node_id = ? AND tag_id = ?", nodeID, tagID).
		Delete(&model.NodeTag{}).Error
}
func (r *TagRepo) NodesWithTag(ctx context.Context, tagIDs []uint64) ([]uint64, error) {
	if len(tagIDs) == 0 {
		return nil, nil
	}
	var rows []model.NodeTag
	if err := r.db.WithContext(ctx).Where("tag_id IN ?", tagIDs).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]uint64, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.NodeID)
	}
	return out, nil
}
func (r *TagRepo) TagsForNode(ctx context.Context, nodeID uint64) ([]model.AssetTag, error) {
	var rows []model.NodeTag
	if err := r.db.WithContext(ctx).Where("node_id = ?", nodeID).Find(&rows).Error; err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	ids := make([]uint64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.TagID)
	}
	var tags []model.AssetTag
	err := r.db.WithContext(ctx).Where("id IN ?", ids).Find(&tags).Error
	return tags, err
}

// ----- AssetGrant -----

type GrantRepo struct{ db *gorm.DB }

func NewGrantRepo(db *gorm.DB) *GrantRepo { return &GrantRepo{db: db} }

func (r *GrantRepo) Create(ctx context.Context, g *model.AssetGrant) error {
	return r.db.WithContext(ctx).Create(g).Error
}
func (r *GrantRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.AssetGrant{}, id).Error
}
func (r *GrantRepo) FindByID(ctx context.Context, id uint64) (*model.AssetGrant, error) {
	var g model.AssetGrant
	err := r.db.WithContext(ctx).First(&g, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &g, err
}
func (r *GrantRepo) List(ctx context.Context) ([]model.AssetGrant, error) {
	var out []model.AssetGrant
	err := r.db.WithContext(ctx).Order("id DESC").Find(&out).Error
	return out, err
}

// ListForGrantees fetches every still-valid grant aimed at any of the supplied
// (type, id) pairs. The boolean "all" sentinel is encoded as subject_type=all.
func (r *GrantRepo) ListForGrantees(ctx context.Context, granteeTypes []model.GranteeType, granteeIDs []uint64) ([]model.AssetGrant, error) {
	if len(granteeIDs) == 0 || len(granteeTypes) == 0 {
		return nil, nil
	}
	var out []model.AssetGrant
	now := time.Now()
	err := r.db.WithContext(ctx).
		Where("grantee_type IN ?", granteeTypes).
		Where("grantee_id IN ?", granteeIDs).
		Where("(valid_from IS NULL OR valid_from <= ?) AND (valid_to IS NULL OR valid_to >= ?)", now, now).
		Find(&out).Error
	return out, err
}

// ----- Favorite -----

type FavoriteRepo struct{ db *gorm.DB }

func NewFavoriteRepo(db *gorm.DB) *FavoriteRepo { return &FavoriteRepo{db: db} }

func (r *FavoriteRepo) Add(ctx context.Context, userID, nodeID uint64) error {
	rel := model.NodeFavorite{UserID: userID, NodeID: nodeID, CreatedAt: time.Now()}
	return r.db.WithContext(ctx).Where("user_id = ? AND node_id = ?", userID, nodeID).
		FirstOrCreate(&rel).Error
}
func (r *FavoriteRepo) Remove(ctx context.Context, userID, nodeID uint64) error {
	return r.db.WithContext(ctx).Where("user_id = ? AND node_id = ?", userID, nodeID).
		Delete(&model.NodeFavorite{}).Error
}
func (r *FavoriteRepo) ListNodeIDs(ctx context.Context, userID uint64) ([]uint64, error) {
	var rows []model.NodeFavorite
	if err := r.db.WithContext(ctx).Where("user_id = ?", userID).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]uint64, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.NodeID)
	}
	return out, nil
}

// ----- Recent -----

type RecentRepo struct{ db *gorm.DB }

func NewRecentRepo(db *gorm.DB) *RecentRepo { return &RecentRepo{db: db} }

// Bump increments the per-user-per-node hit counter and refreshes last_used_at.
func (r *RecentRepo) Bump(ctx context.Context, userID, nodeID uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var row model.NodeRecent
		err := tx.Where("user_id = ? AND node_id = ?", userID, nodeID).First(&row).Error
		now := time.Now()
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return tx.Create(&model.NodeRecent{UserID: userID, NodeID: nodeID, LastUsedAt: now, Hits: 1}).Error
		}
		if err != nil {
			return err
		}
		return tx.Model(&model.NodeRecent{}).
			Where("user_id = ? AND node_id = ?", userID, nodeID).
			Updates(map[string]any{"last_used_at": now, "hits": row.Hits + 1}).Error
	})
}

func (r *RecentRepo) ListByUser(ctx context.Context, userID uint64, limit int) ([]model.NodeRecent, error) {
	if limit <= 0 {
		limit = 20
	}
	var out []model.NodeRecent
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).
		Order("last_used_at DESC").Limit(limit).Find(&out).Error
	return out, err
}
