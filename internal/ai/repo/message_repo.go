package repo

import (
	"context"
	"errors"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
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

// BackfillParents chains the ParentID of every message that lacks one to the
// message before it (in id order). Linear conversations carry nil ParentIDs;
// the first time one is branched we materialize the implicit chain so ListBranch
// can walk it. Idempotent — already-chained messages are left untouched.
func (r *MessageRepo) BackfillParents(ctx context.Context, convID string) error {
	msgs, err := r.ListByConv(ctx, convID)
	if err != nil {
		return err
	}
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		for i := 1; i < len(msgs); i++ {
			if msgs[i].ParentID == nil {
				pid := msgs[i-1].ID
				if err := tx.Model(&aimodel.AIMessage{}).
					Where("id = ?", msgs[i].ID).Update("parent_id", pid).Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
}

// LastUserMessage returns the most recent user-role message in the conversation
// (nil if none). Used by regenerate to find the turn to re-run.
func (r *MessageRepo) LastUserMessage(ctx context.Context, convID string) (*aimodel.AIMessage, error) {
	var m aimodel.AIMessage
	err := r.db.WithContext(ctx).
		Where("conversation_id = ? AND role = ?", convID, aimodel.RoleUser).
		Order("id DESC").First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &m, err
}

// Children returns the messages whose ParentID == parentID (the sibling set used
// to surface a "‹2/3›" branch switcher).
func (r *MessageRepo) Children(ctx context.Context, convID string, parentID uint64) ([]aimodel.AIMessage, error) {
	var out []aimodel.AIMessage
	err := r.db.WithContext(ctx).
		Where("conversation_id = ? AND parent_id = ?", convID, parentID).
		Order("id").Find(&out).Error
	return out, err
}

// ListBranch assembles the message path from the branch leaf up to the root via
// ParentID, returned root→leaf. Falls back to the full linear list when leafID
// is missing/dangling (so a stale ActiveLeafMessageID never breaks a turn). The
// walk is bounded by the message count as a cycle defense.
func (r *MessageRepo) ListBranch(ctx context.Context, convID string, leafID uint64) ([]aimodel.AIMessage, error) {
	all, err := r.ListByConv(ctx, convID)
	if err != nil {
		return nil, err
	}
	byID := make(map[uint64]*aimodel.AIMessage, len(all))
	for i := range all {
		byID[all[i].ID] = &all[i]
	}
	cur, ok := byID[leafID]
	if !ok {
		return all, nil // dangling leaf → linear fallback
	}
	path := make([]aimodel.AIMessage, 0, len(all))
	for steps := 0; cur != nil && steps <= len(all); steps++ {
		path = append(path, *cur)
		if cur.ParentID == nil {
			break
		}
		cur = byID[*cur.ParentID]
	}
	// Reverse to root→leaf order.
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path, nil
}

// DeepestLeaf walks down from fromID, always following the latest child, to the
// tip of that subtree — used when switching to a sibling branch so the whole
// branch (not just the fork point) becomes the active leaf.
func (r *MessageRepo) DeepestLeaf(ctx context.Context, convID string, fromID uint64) (uint64, error) {
	all, err := r.ListByConv(ctx, convID)
	if err != nil {
		return fromID, err
	}
	childrenOf := map[uint64][]uint64{}
	for _, m := range all {
		if m.ParentID != nil {
			childrenOf[*m.ParentID] = append(childrenOf[*m.ParentID], m.ID)
		}
	}
	cur := fromID
	for steps := 0; steps <= len(all); steps++ {
		kids := childrenOf[cur]
		if len(kids) == 0 {
			break
		}
		latest := kids[0]
		for _, k := range kids {
			if k > latest {
				latest = k
			}
		}
		cur = latest
	}
	return cur, nil
}

// ListByConvBefore returns up to `limit` messages with id < beforeID (beforeID
// == 0 means "from the newest"), in natural ascending order — cursor pagination
// for lazy-loading older messages in the UI.
func (r *MessageRepo) ListByConvBefore(ctx context.Context, convID string, beforeID uint64, limit int) ([]aimodel.AIMessage, error) {
	if limit <= 0 {
		limit = 50
	}
	q := r.db.WithContext(ctx).Where("conversation_id = ?", convID)
	if beforeID > 0 {
		q = q.Where("id < ?", beforeID)
	}
	var rows []aimodel.AIMessage
	if err := q.Order("id DESC").Limit(limit).Find(&rows).Error; err != nil {
		return nil, err
	}
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	return rows, nil
}

// SearchInConv runs a LIKE over one conversation's message content for the
// in-conversation search/jump feature.
func (r *MessageRepo) SearchInConv(ctx context.Context, convID, q string, limit int) ([]aimodel.AIMessage, error) {
	if limit <= 0 {
		limit = 100
	}
	var out []aimodel.AIMessage
	err := r.db.WithContext(ctx).
		Where("conversation_id = ? AND content LIKE ?", convID, "%"+escapeLike(q)+"%").
		Order("id").Limit(limit).Find(&out).Error
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
