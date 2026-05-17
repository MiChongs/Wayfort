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
