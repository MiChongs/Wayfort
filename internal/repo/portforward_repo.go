package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/gorm"
)

type PortForwardRepo struct{ db *gorm.DB }

func NewPortForwardRepo(db *gorm.DB) *PortForwardRepo { return &PortForwardRepo{db: db} }

func (r *PortForwardRepo) Create(ctx context.Context, p *model.PortForward) error {
	return r.db.WithContext(ctx).Create(p).Error
}

func (r *PortForwardRepo) Update(ctx context.Context, p *model.PortForward) error {
	return r.db.WithContext(ctx).Save(p).Error
}

func (r *PortForwardRepo) FindByID(ctx context.Context, id string) (*model.PortForward, error) {
	var p model.PortForward
	err := r.db.WithContext(ctx).First(&p, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &p, err
}

func (r *PortForwardRepo) ListActive(ctx context.Context, userID uint64) ([]model.PortForward, error) {
	q := r.db.WithContext(ctx).Where("status = ?", model.PortForwardActive)
	if userID > 0 {
		q = q.Where("user_id = ?", userID)
	}
	var out []model.PortForward
	err := q.Order("created_at DESC").Find(&out).Error
	return out, err
}

func (r *PortForwardRepo) MarkClosed(ctx context.Context, id string, bytesIn, bytesOut uint64) error {
	now := time.Now()
	return r.db.WithContext(ctx).Model(&model.PortForward{}).
		Where("id = ?", id).
		Updates(map[string]any{
			"status":    model.PortForwardClosed,
			"closed_at": &now,
			"bytes_in":  bytesIn,
			"bytes_out": bytesOut,
		}).Error
}

func (r *PortForwardRepo) MarkExpired(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Model(&model.PortForward{}).
		Where("id = ?", id).
		Update("status", model.PortForwardExpired).Error
}
