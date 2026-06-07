package repo

import (
	"context"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"gorm.io/gorm"
)

type TaskRepo struct{ db *gorm.DB }

func NewTaskRepo(db *gorm.DB) *TaskRepo { return &TaskRepo{db: db} }

// ListByConv returns the conversation's plan items in display order.
func (r *TaskRepo) ListByConv(ctx context.Context, convID string) ([]aimodel.AITask, error) {
	var out []aimodel.AITask
	err := r.db.WithContext(ctx).
		Where("conversation_id = ?", convID).
		Order("ordinal").Find(&out).Error
	return out, err
}

// ReplaceAll atomically swaps the conversation's whole plan for `tasks`. The
// agent re-emits the full ordered list on every `update_plan` call (TodoWrite
// semantics), so a delete-then-insert is the simplest correct implementation:
// no per-item id contract, idempotent, self-healing. Returns the inserted rows
// with their fresh ids so the caller can broadcast them.
func (r *TaskRepo) ReplaceAll(ctx context.Context, convID string, tasks []aimodel.AITask) ([]aimodel.AITask, error) {
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("conversation_id = ?", convID).Delete(&aimodel.AITask{}).Error; err != nil {
			return err
		}
		if len(tasks) == 0 {
			return nil
		}
		for i := range tasks {
			tasks[i].ID = 0
			tasks[i].ConversationID = convID
			tasks[i].Ordinal = i
			if !aimodel.ValidTaskStatus(tasks[i].Status) {
				tasks[i].Status = aimodel.TaskPending
			}
		}
		return tx.Create(&tasks).Error
	})
	if err != nil {
		return nil, err
	}
	return tasks, nil
}

// DeleteByConv removes the conversation's whole plan (used on conversation delete).
func (r *TaskRepo) DeleteByConv(ctx context.Context, convID string) error {
	return r.db.WithContext(ctx).
		Where("conversation_id = ?", convID).
		Delete(&aimodel.AITask{}).Error
}
