package repo

import (
	"context"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/gorm"
)

// NotificationRepo persists the per-recipient in-app notification center.
type NotificationRepo struct{ db *gorm.DB }

func NewNotificationRepo(db *gorm.DB) *NotificationRepo { return &NotificationRepo{db: db} }

// Insert writes one notification, stamping CreatedAt when unset.
func (r *NotificationRepo) Insert(ctx context.Context, n *model.Notification) error {
	if n.CreatedAt.IsZero() {
		n.CreatedAt = time.Now()
	}
	return r.db.WithContext(ctx).Create(n).Error
}

// ListByUser returns a page of a user's notifications, newest first. When
// unreadOnly is set only unread rows are returned.
func (r *NotificationRepo) ListByUser(ctx context.Context, userID uint64, unreadOnly bool, limit, offset int) ([]model.Notification, int64, error) {
	q := r.db.WithContext(ctx).Model(&model.Notification{}).Where("user_id = ?", userID)
	if unreadOnly {
		q = q.Where("read_at IS NULL")
	}
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if limit <= 0 {
		limit = 50
	}
	var out []model.Notification
	err := q.Order("created_at DESC").Limit(limit).Offset(offset).Find(&out).Error
	return out, total, err
}

// UnreadCount returns the number of unread notifications for a user.
func (r *NotificationRepo) UnreadCount(ctx context.Context, userID uint64) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).Model(&model.Notification{}).
		Where("user_id = ? AND read_at IS NULL", userID).Count(&n).Error
	return n, err
}

// MarkRead marks one notification read, scoped to its owner so a user can't
// touch another's rows. Returns the number of rows affected.
func (r *NotificationRepo) MarkRead(ctx context.Context, id, userID uint64) (int64, error) {
	now := time.Now()
	res := r.db.WithContext(ctx).Model(&model.Notification{}).
		Where("id = ? AND user_id = ? AND read_at IS NULL", id, userID).
		Update("read_at", now)
	return res.RowsAffected, res.Error
}

// MarkAllRead marks every unread notification for a user read.
func (r *NotificationRepo) MarkAllRead(ctx context.Context, userID uint64) (int64, error) {
	now := time.Now()
	res := r.db.WithContext(ctx).Model(&model.Notification{}).
		Where("user_id = ? AND read_at IS NULL", userID).
		Update("read_at", now)
	return res.RowsAffected, res.Error
}

// Delete removes one notification owned by the user.
func (r *NotificationRepo) Delete(ctx context.Context, id, userID uint64) error {
	return r.db.WithContext(ctx).
		Where("id = ? AND user_id = ?", id, userID).
		Delete(&model.Notification{}).Error
}

// PurgeOld deletes notifications older than `before` (retention housekeeping).
func (r *NotificationRepo) PurgeOld(ctx context.Context, before time.Time) (int64, error) {
	res := r.db.WithContext(ctx).
		Where("created_at < ?", before).
		Delete(&model.Notification{})
	return res.RowsAffected, res.Error
}
