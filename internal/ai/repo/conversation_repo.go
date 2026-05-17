package repo

import (
	"context"
	"errors"
	"time"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"gorm.io/gorm"
)

type ConversationRepo struct{ db *gorm.DB }

func NewConversationRepo(db *gorm.DB) *ConversationRepo { return &ConversationRepo{db: db} }

func (r *ConversationRepo) Create(ctx context.Context, c *aimodel.AIConversation) error {
	return r.db.WithContext(ctx).Create(c).Error
}
func (r *ConversationRepo) Update(ctx context.Context, c *aimodel.AIConversation) error {
	return r.db.WithContext(ctx).Save(c).Error
}
func (r *ConversationRepo) Delete(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("conversation_id = ?", id).Delete(&aimodel.AIMessage{}).Error; err != nil {
			return err
		}
		if err := tx.Where("conversation_id = ?", id).Delete(&aimodel.AIToolInvocation{}).Error; err != nil {
			return err
		}
		return tx.Delete(&aimodel.AIConversation{}, "id = ?", id).Error
	})
}
func (r *ConversationRepo) FindByID(ctx context.Context, id string) (*aimodel.AIConversation, error) {
	var c aimodel.AIConversation
	err := r.db.WithContext(ctx).First(&c, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &c, err
}
func (r *ConversationRepo) ListByUser(ctx context.Context, userID uint64, limit int) ([]aimodel.AIConversation, error) {
	if limit <= 0 {
		limit = 50
	}
	var out []aimodel.AIConversation
	err := r.db.WithContext(ctx).
		Where("user_id = ? AND archived = ?", userID, false).
		Order("updated_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// PurgeOlderThan removes conversations + their messages/invocations older than
// cutoff. Used by the janitor.
func (r *ConversationRepo) PurgeOlderThan(ctx context.Context, cutoff time.Time) (int64, error) {
	var convs []aimodel.AIConversation
	if err := r.db.WithContext(ctx).
		Where("updated_at < ?", cutoff).
		Limit(1000).Find(&convs).Error; err != nil {
		return 0, err
	}
	if len(convs) == 0 {
		return 0, nil
	}
	ids := make([]string, 0, len(convs))
	for _, c := range convs {
		ids = append(ids, c.ID)
	}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("conversation_id IN ?", ids).Delete(&aimodel.AIMessage{}).Error; err != nil {
			return err
		}
		if err := tx.Where("conversation_id IN ?", ids).Delete(&aimodel.AIToolInvocation{}).Error; err != nil {
			return err
		}
		return tx.Where("id IN ?", ids).Delete(&aimodel.AIConversation{}).Error
	})
	return int64(len(ids)), err
}
