package repo

import (
	"context"
	"errors"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

type NodeRepo struct{ db *gorm.DB }

func NewNodeRepo(db *gorm.DB) *NodeRepo { return &NodeRepo{db: db} }

func (r *NodeRepo) Create(ctx context.Context, n *model.Node) error {
	return r.db.WithContext(ctx).Create(n).Error
}

func (r *NodeRepo) Update(ctx context.Context, n *model.Node) error {
	return r.db.WithContext(ctx).Save(n).Error
}

func (r *NodeRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.Node{}, id).Error
}

func (r *NodeRepo) FindByID(ctx context.Context, id uint64) (*model.Node, error) {
	var n model.Node
	err := r.db.WithContext(ctx).First(&n, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &n, err
}

func (r *NodeRepo) List(ctx context.Context) ([]model.Node, error) {
	var out []model.Node
	err := r.db.WithContext(ctx).Order("id").Find(&out).Error
	return out, err
}

// SetDisabledBatch flips the disabled flag for many nodes in one UPDATE. Used
// by the asset-tree bulk enable/disable action.
func (r *NodeRepo) SetDisabledBatch(ctx context.Context, ids []uint64, disabled bool) error {
	if len(ids) == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Model(&model.Node{}).
		Where("id IN ?", ids).Update("disabled", disabled).Error
}

// NamesByIDs resolves a batch of node ids to their display names in one query.
// Used to enrich audit rows (which carry only node_id) with the asset name.
func (r *NodeRepo) NamesByIDs(ctx context.Context, ids []uint64) (map[uint64]string, error) {
	out := map[uint64]string{}
	if len(ids) == 0 {
		return out, nil
	}
	type row struct {
		ID   uint64
		Name string
	}
	var rows []row
	if err := r.db.WithContext(ctx).Model(&model.Node{}).
		Select("id, name").Where("id IN ?", ids).Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, x := range rows {
		out[x.ID] = x.Name
	}
	return out, nil
}
