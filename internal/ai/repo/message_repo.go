package repo

import (
	"context"
	"errors"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"gorm.io/gorm"
)

type MessageRepo struct{ db *gorm.DB }

func NewMessageRepo(db *gorm.DB) *MessageRepo { return &MessageRepo{db: db} }

func (r *MessageRepo) Append(ctx context.Context, m *aimodel.AIMessage) error {
	return r.db.WithContext(ctx).Create(m).Error
}

func (r *MessageRepo) ListByConv(ctx context.Context, convID string) ([]aimodel.AIMessage, error) {
	var out []aimodel.AIMessage
	err := r.db.WithContext(ctx).
		Where("conversation_id = ?", convID).
		Order("id").Find(&out).Error
	return out, err
}

func (r *MessageRepo) FindByID(ctx context.Context, id uint64) (*aimodel.AIMessage, error) {
	var m aimodel.AIMessage
	err := r.db.WithContext(ctx).First(&m, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &m, err
}

func (r *MessageRepo) Update(ctx context.Context, m *aimodel.AIMessage) error {
	return r.db.WithContext(ctx).Save(m).Error
}

// DeleteAfter removes every message in convID with id > afterID. Used by
// the "edit & branch" flow to truncate the conversation at the edit point.
func (r *MessageRepo) DeleteAfter(ctx context.Context, convID string, afterID uint64) error {
	return r.db.WithContext(ctx).
		Where("conversation_id = ? AND id > ?", convID, afterID).
		Delete(&aimodel.AIMessage{}).Error
}

func (r *MessageRepo) CountByConv(ctx context.Context, convID string) (int, error) {
	var n int64
	err := r.db.WithContext(ctx).Model(&aimodel.AIMessage{}).
		Where("conversation_id = ?", convID).Count(&n).Error
	return int(n), err
}

func (r *MessageRepo) Last(ctx context.Context, convID string, limit int) ([]aimodel.AIMessage, error) {
	if limit <= 0 {
		limit = 50
	}
	var rows []aimodel.AIMessage
	err := r.db.WithContext(ctx).
		Where("conversation_id = ?", convID).
		Order("id DESC").Limit(limit).Find(&rows).Error
	if err != nil {
		return nil, err
	}
	// Reverse for natural order.
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return rows, nil
}
