package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// SnippetRepo — user-scoped CRUD for terminal command snippets.
type SnippetRepo struct{ db *gorm.DB }

func NewSnippetRepo(db *gorm.DB) *SnippetRepo { return &SnippetRepo{db: db} }

func (r *SnippetRepo) Create(ctx context.Context, s *model.Snippet) error {
	return r.db.WithContext(ctx).Create(s).Error
}

func (r *SnippetRepo) Update(ctx context.Context, s *model.Snippet) error {
	return r.db.WithContext(ctx).Save(s).Error
}

func (r *SnippetRepo) Delete(ctx context.Context, userID, id uint64) error {
	return r.db.WithContext(ctx).Where("user_id = ?", userID).Delete(&model.Snippet{}, id).Error
}

func (r *SnippetRepo) FindByID(ctx context.Context, userID, id uint64) (*model.Snippet, error) {
	var s model.Snippet
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&s, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &s, err
}

// List returns the user's snippets ordered by pinned + recently used.
func (r *SnippetRepo) List(ctx context.Context, userID uint64) ([]model.Snippet, error) {
	var out []model.Snippet
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("pinned DESC, last_used_at DESC NULLS LAST, name ASC").
		Find(&out).Error
	return out, err
}

// BumpUsage increments usage_count + sets last_used_at = now. Called when
// the UI inserts a snippet into a terminal.
func (r *SnippetRepo) BumpUsage(ctx context.Context, userID, id uint64) error {
	now := time.Now()
	return r.db.WithContext(ctx).
		Model(&model.Snippet{}).
		Where("id = ? AND user_id = ?", id, userID).
		Updates(map[string]any{
			"usage_count":  gorm.Expr("usage_count + 1"),
			"last_used_at": &now,
		}).Error
}

// CommandHistoryRepo — opt-in user command capture.
type CommandHistoryRepo struct{ db *gorm.DB }

func NewCommandHistoryRepo(db *gorm.DB) *CommandHistoryRepo { return &CommandHistoryRepo{db: db} }

func (r *CommandHistoryRepo) Create(ctx context.Context, h *model.CommandHistory) error {
	return r.db.WithContext(ctx).Create(h).Error
}

// List returns the most recent entries first. Filters are all optional —
// nil means "don't filter on this field". A non-empty q substring-matches
// the command body (case-insensitive).
func (r *CommandHistoryRepo) List(
	ctx context.Context,
	userID uint64,
	q string,
	nodeID *uint64,
	limit int,
) ([]model.CommandHistory, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	tx := r.db.WithContext(ctx).Where("user_id = ?", userID)
	if nodeID != nil {
		tx = tx.Where("node_id = ?", *nodeID)
	}
	if q != "" {
		tx = tx.Where("LOWER(command) LIKE ?", "%"+q+"%")
	}
	var out []model.CommandHistory
	err := tx.Order("created_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// Clear removes all history rows for the user. Optionally scoped to a
// specific node.
func (r *CommandHistoryRepo) Clear(ctx context.Context, userID uint64, nodeID *uint64) error {
	tx := r.db.WithContext(ctx).Where("user_id = ?", userID)
	if nodeID != nil {
		tx = tx.Where("node_id = ?", *nodeID)
	}
	return tx.Delete(&model.CommandHistory{}).Error
}

// TerminalProfileRepo — server-synced terminal settings.
type TerminalProfileRepo struct{ db *gorm.DB }

func NewTerminalProfileRepo(db *gorm.DB) *TerminalProfileRepo { return &TerminalProfileRepo{db: db} }

func (r *TerminalProfileRepo) Get(ctx context.Context, userID uint64) (*model.TerminalProfile, error) {
	var p model.TerminalProfile
	err := r.db.WithContext(ctx).Where("user_id = ?", userID).First(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &p, err
}

// Upsert creates or updates the user's profile row. Body is an opaque JSON
// blob so adding new settings doesn't require a migration.
func (r *TerminalProfileRepo) Upsert(ctx context.Context, p *model.TerminalProfile) error {
	p.UpdatedAt = time.Now()
	return r.db.WithContext(ctx).Save(p).Error
}
