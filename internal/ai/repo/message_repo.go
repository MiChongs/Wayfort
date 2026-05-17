package repo

import (
	"context"

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
