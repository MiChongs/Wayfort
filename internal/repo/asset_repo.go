package repo

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/model"
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
// Delete removes a group but PROMOTES its direct children to the deleted
// group's parent (their subtrees ride along, paths rewritten) so nothing is
// orphaned. Member-node links for the deleted group are dropped; member links
// of the promoted children are untouched.
func (r *AssetGroupRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var g model.AssetGroup
		if err := tx.First(&g, id).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		var children []model.AssetGroup
		if err := tx.Where("parent_id = ?", id).Find(&children).Error; err != nil {
			return err
		}
		for _, c := range children {
			if err := r.moveTx(tx, c.ID, g.ParentID); err != nil {
				return err
			}
		}
		if err := tx.Where("group_id = ?", id).Delete(&model.AssetGroupNode{}).Error; err != nil {
			return err
		}
		return tx.Delete(&model.AssetGroup{}, id).Error
	})
}

// Move reparents a group under newParent (nil == top level), rewriting the
// materialised path of the group and its whole subtree. Refuses moves that
// would create a cycle (onto itself or one of its descendants).
func (r *AssetGroupRepo) Move(ctx context.Context, id uint64, newParent *uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return r.moveTx(tx, id, newParent)
	})
}

func (r *AssetGroupRepo) moveTx(tx *gorm.DB, id uint64, newParent *uint64) error {
	var g model.AssetGroup
	if err := tx.First(&g, id).Error; err != nil {
		return err
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
		var parent model.AssetGroup
		if err := tx.First(&parent, *newParent).Error; err != nil {
			return errors.New("目标父组不存在")
		}
		if parent.Path == oldPath || strings.HasPrefix(parent.Path, oldPath+"/") {
			return errors.New("不能移动到自己的子组下")
		}
		newPath = parent.Path + "/" + fmt.Sprint(id)
	}

	if newPath == g.Path && eqUintPtr(g.ParentID, newParent) {
		return nil
	}

	// Capture descendants (by the OLD path prefix) before mutating this row.
	var descendants []model.AssetGroup
	if err := tx.Where("path LIKE ?", oldPath+"/%").Find(&descendants).Error; err != nil {
		return err
	}

	if err := tx.Model(&model.AssetGroup{}).Where("id = ?", id).
		Updates(map[string]any{"parent_id": newParent, "path": newPath}).Error; err != nil {
		return err
	}
	for _, d := range descendants {
		rewritten := newPath + d.Path[len(oldPath):]
		if err := tx.Model(&model.AssetGroup{}).Where("id = ?", d.ID).
			Update("path", rewritten).Error; err != nil {
			return err
		}
	}
	return nil
}

func eqUintPtr(a, b *uint64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
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
// GroupsForNodes is the inverse of MembersByGroup: it returns, for each node,
// the asset-group IDs it belongs to. Lets a flat reachable-node set be hung on
// the group hierarchy (授权树) in one query instead of N.
func (r *AssetGroupRepo) GroupsForNodes(ctx context.Context, nodeIDs []uint64) (map[uint64][]uint64, error) {
	out := map[uint64][]uint64{}
	if len(nodeIDs) == 0 {
		return out, nil
	}
	var rows []model.AssetGroupNode
	if err := r.db.WithContext(ctx).Where("node_id IN ?", nodeIDs).Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		out[row.NodeID] = append(out[row.NodeID], row.GroupID)
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

// Update writes the editable tag attributes. A map is used (not Save) so a nil
// GroupID correctly clears the column to NULL ("ungroup").
func (r *TagRepo) Update(ctx context.Context, t *model.AssetTag) error {
	return r.db.WithContext(ctx).Model(&model.AssetTag{}).Where("id = ?", t.ID).
		Updates(map[string]any{
			"name":        t.Name,
			"color":       t.Color,
			"icon":        t.Icon,
			"description": t.Description,
			"group_id":    t.GroupID,
		}).Error
}

func (r *TagRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// Find affected nodes first so we can refresh their denormalised cache.
		var rels []model.NodeTag
		if err := tx.Where("tag_id = ?", id).Find(&rels).Error; err != nil {
			return err
		}
		if err := tx.Where("tag_id = ?", id).Delete(&model.NodeTag{}).Error; err != nil {
			return err
		}
		if err := tx.Delete(&model.AssetTag{}, id).Error; err != nil {
			return err
		}
		for _, rel := range rels {
			if err := syncNodeTagCache(tx, rel.NodeID); err != nil {
				return err
			}
		}
		return nil
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

// Counts returns tag_id → number of nodes carrying that tag, for usage badges.
func (r *TagRepo) Counts(ctx context.Context) (map[uint64]int, error) {
	type row struct {
		TagID uint64
		N     int
	}
	var rows []row
	if err := r.db.WithContext(ctx).Model(&model.NodeTag{}).
		Select("tag_id, count(*) as n").Group("tag_id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[uint64]int, len(rows))
	for _, x := range rows {
		out[x.TagID] = x.N
	}
	return out, nil
}

// UpsertByName fetches a tag by exact name or creates it. Used by inline
// "create-as-you-type" and the freetext→managed migration. Tolerates a
// concurrent create via a re-fetch on unique-violation.
func (r *TagRepo) UpsertByName(ctx context.Context, name, color, icon string) (*model.AssetTag, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, errors.New("empty tag name")
	}
	var t model.AssetTag
	err := r.db.WithContext(ctx).Where("name = ?", name).First(&t).Error
	if err == nil {
		return &t, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	t = model.AssetTag{Name: name, Color: color, Icon: icon}
	if err := r.db.WithContext(ctx).Create(&t).Error; err != nil {
		var existing model.AssetTag
		if e2 := r.db.WithContext(ctx).Where("name = ?", name).First(&existing).Error; e2 == nil {
			return &existing, nil
		}
		return nil, err
	}
	return &t, nil
}

func (r *TagRepo) AttachToNode(ctx context.Context, nodeID, tagID uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		rel := model.NodeTag{NodeID: nodeID, TagID: tagID}
		if err := tx.Where("node_id = ? AND tag_id = ?", nodeID, tagID).FirstOrCreate(&rel).Error; err != nil {
			return err
		}
		return syncNodeTagCache(tx, nodeID)
	})
}
func (r *TagRepo) DetachFromNode(ctx context.Context, nodeID, tagID uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("node_id = ? AND tag_id = ?", nodeID, tagID).
			Delete(&model.NodeTag{}).Error; err != nil {
			return err
		}
		return syncNodeTagCache(tx, nodeID)
	})
}

// ReplaceNodeTags sets a node's managed tags to exactly tagIDs (deduped), then
// refreshes the denormalised nodes.tags cache string so every freetext consumer
// (search, facets, command palette) keeps working unchanged.
func (r *TagRepo) ReplaceNodeTags(ctx context.Context, nodeID uint64, tagIDs []uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("node_id = ?", nodeID).Delete(&model.NodeTag{}).Error; err != nil {
			return err
		}
		seen := map[uint64]bool{}
		for _, tid := range tagIDs {
			if tid == 0 || seen[tid] {
				continue
			}
			seen[tid] = true
			if err := tx.Create(&model.NodeTag{NodeID: nodeID, TagID: tid}).Error; err != nil {
				return err
			}
		}
		return syncNodeTagCache(tx, nodeID)
	})
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
	err := r.db.WithContext(ctx).Where("id IN ?", ids).Order("name").Find(&tags).Error
	return tags, err
}

// TagsForNodes batch-resolves managed tags for many nodes in two queries, so
// the node list can embed colours without N round-trips.
func (r *TagRepo) TagsForNodes(ctx context.Context, nodeIDs []uint64) (map[uint64][]model.AssetTag, error) {
	out := map[uint64][]model.AssetTag{}
	if len(nodeIDs) == 0 {
		return out, nil
	}
	var rels []model.NodeTag
	if err := r.db.WithContext(ctx).Where("node_id IN ?", nodeIDs).Find(&rels).Error; err != nil {
		return nil, err
	}
	if len(rels) == 0 {
		return out, nil
	}
	idSet := map[uint64]bool{}
	for _, rel := range rels {
		idSet[rel.TagID] = true
	}
	ids := make([]uint64, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	var tags []model.AssetTag
	if err := r.db.WithContext(ctx).Where("id IN ?", ids).Order("name").Find(&tags).Error; err != nil {
		return nil, err
	}
	byID := make(map[uint64]model.AssetTag, len(tags))
	for _, t := range tags {
		byID[t.ID] = t
	}
	for _, rel := range rels {
		if t, ok := byID[rel.TagID]; ok {
			out[rel.NodeID] = append(out[rel.NodeID], t)
		}
	}
	return out, nil
}

// syncNodeTagCache recomputes the denormalised nodes.tags string (sorted,
// comma-joined managed tag names) for one node, inside the caller's tx.
func syncNodeTagCache(tx *gorm.DB, nodeID uint64) error {
	var rows []model.NodeTag
	if err := tx.Where("node_id = ?", nodeID).Find(&rows).Error; err != nil {
		return err
	}
	names := make([]string, 0, len(rows))
	if len(rows) > 0 {
		ids := make([]uint64, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, row.TagID)
		}
		var tags []model.AssetTag
		if err := tx.Where("id IN ?", ids).Order("name").Find(&tags).Error; err != nil {
			return err
		}
		for _, t := range tags {
			names = append(names, t.Name)
		}
	}
	return tx.Model(&model.Node{}).Where("id = ?", nodeID).
		Update("tags", strings.Join(names, ",")).Error
}

// ----- AssetTagGroup -----

type TagGroupRepo struct{ db *gorm.DB }

func NewTagGroupRepo(db *gorm.DB) *TagGroupRepo { return &TagGroupRepo{db: db} }

func (r *TagGroupRepo) Create(ctx context.Context, g *model.AssetTagGroup) error {
	return r.db.WithContext(ctx).Create(g).Error
}
func (r *TagGroupRepo) Update(ctx context.Context, g *model.AssetTagGroup) error {
	return r.db.WithContext(ctx).Model(&model.AssetTagGroup{}).Where("id = ?", g.ID).
		Updates(map[string]any{
			"name":       g.Name,
			"color":      g.Color,
			"icon":       g.Icon,
			"sort_order": g.SortOrder,
		}).Error
}

// Delete removes a group but keeps its tags — they fall back to "ungrouped"
// (group_id set to NULL) rather than vanishing with the group.
func (r *TagGroupRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.AssetTag{}).Where("group_id = ?", id).
			Update("group_id", nil).Error; err != nil {
			return err
		}
		return tx.Delete(&model.AssetTagGroup{}, id).Error
	})
}
func (r *TagGroupRepo) List(ctx context.Context) ([]model.AssetTagGroup, error) {
	var out []model.AssetTagGroup
	err := r.db.WithContext(ctx).Order("sort_order, name").Find(&out).Error
	return out, err
}

// ----- One-time migration: freetext node.tags → managed colour tags -----

// migrationPalette is the canonical token set shared with the frontend palette
// (web/src/lib/tags/palette.ts). A tag's default colour is picked from it
// deterministically by name so the same label always gets the same hue.
var migrationPalette = []string{
	"coral", "teal", "amber", "sage", "sky",
	"violet", "rose", "cyan", "indigo", "lime", "fuchsia", "slate",
}

func migrationColor(name string) string {
	var h uint32 = 2166136261
	for i := 0; i < len(name); i++ {
		h ^= uint32(name[i])
		h *= 16777619
	}
	return migrationPalette[int(h)%len(migrationPalette)]
}

func splitDistinctTags(raw string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		t := strings.TrimSpace(part)
		if t == "" || seen[strings.ToLower(t)] {
			continue
		}
		seen[strings.ToLower(t)] = true
		out = append(out, t)
	}
	return out
}

// MigrateFreetextNodeTags is idempotent: it converts each node's legacy
// comma-separated `tags` string into managed AssetTag rows + NodeTag links,
// but ONLY for nodes that have no managed tags yet — so re-runs and later admin
// edits are never clobbered. Returns the number of nodes migrated.
func (r *TagRepo) MigrateFreetextNodeTags(ctx context.Context) (int, error) {
	var links []model.NodeTag
	if err := r.db.WithContext(ctx).Find(&links).Error; err != nil {
		return 0, err
	}
	hasManaged := map[uint64]bool{}
	for _, l := range links {
		hasManaged[l.NodeID] = true
	}

	var nodes []model.Node
	if err := r.db.WithContext(ctx).Where("tags <> ''").Find(&nodes).Error; err != nil {
		return 0, err
	}

	migrated := 0
	for _, n := range nodes {
		if hasManaged[n.ID] {
			continue
		}
		names := splitDistinctTags(n.Tags)
		if len(names) == 0 {
			continue
		}
		for _, name := range names {
			tag, err := r.UpsertByName(ctx, name, migrationColor(name), "")
			if err != nil {
				return migrated, err
			}
			if err := r.AttachToNode(ctx, n.ID, tag.ID); err != nil {
				return migrated, err
			}
		}
		migrated++
	}
	return migrated, nil
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
