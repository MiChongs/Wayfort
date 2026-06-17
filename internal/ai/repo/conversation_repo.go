package repo

import (
	"context"
	"errors"
	"strings"
	"time"

	aimodel "github.com/michongs/wayfort/internal/ai/model"
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

// UpdateTitle persists only the title column — used by the auto-title generator,
// which runs concurrently with a live turn and must not clobber the run's other
// in-flight column writes (token totals, status, active leaf).
func (r *ConversationRepo) UpdateTitle(ctx context.Context, id, title string) error {
	return r.db.WithContext(ctx).Model(&aimodel.AIConversation{}).
		Where("id = ?", id).Update("title", title).Error
}
func (r *ConversationRepo) Delete(ctx context.Context, id string) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("conversation_id = ?", id).Delete(&aimodel.AIMessage{}).Error; err != nil {
			return err
		}
		if err := tx.Where("conversation_id = ?", id).Delete(&aimodel.AIToolInvocation{}).Error; err != nil {
			return err
		}
		if err := tx.Where("conversation_id = ?", id).Delete(&aimodel.AITask{}).Error; err != nil {
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
// ListByUser returns every conversation the user owns (including archived
// and pinned). The frontend is responsible for visual grouping; the API
// always returns the full set so search / filter UIs aren't crippled.
func (r *ConversationRepo) ListByUser(ctx context.Context, userID uint64, limit int) ([]aimodel.AIConversation, error) {
	if limit <= 0 {
		limit = 200
	}
	var out []aimodel.AIConversation
	err := r.db.WithContext(ctx).
		Where("user_id = ?", userID).
		Order("pinned DESC, updated_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// Search runs a full-text-ish LIKE across the user's own conversations:
// either the title matches the query OR at least one of the conversation's
// messages has matching content. Returns up to `limit` rows, ordered by
// recency. Good enough for the dataset sizes we expect; swap to MySQL
// FULLTEXT or Postgres TS if it ever costs.
func (r *ConversationRepo) Search(ctx context.Context, userID uint64, q string, limit int) ([]aimodel.AIConversation, error) {
	if limit <= 0 {
		limit = 50
	}
	q = "%" + escapeLike(q) + "%"
	// Subquery: conversation IDs with a matching message.
	var ids []string
	if err := r.db.WithContext(ctx).
		Model(&aimodel.AIMessage{}).
		Distinct("conversation_id").
		Where("content LIKE ?", q).
		Pluck("conversation_id", &ids).Error; err != nil {
		return nil, err
	}
	tx := r.db.WithContext(ctx).
		Model(&aimodel.AIConversation{}).
		Where("user_id = ?", userID)
	if len(ids) > 0 {
		tx = tx.Where("title LIKE ? OR id IN ?", q, ids)
	} else {
		tx = tx.Where("title LIKE ?", q)
	}
	var out []aimodel.AIConversation
	err := tx.Order("updated_at DESC").Limit(limit).Find(&out).Error
	return out, err
}

// Clone forks a conversation into a new one (newID), copying the active branch's
// messages up to and including throughMsgID (0 = copy everything). ParentID
// links are remapped to the new message ids; tool invocations and the plan are
// NOT copied (the clone starts a fresh execution context). The new conversation
// is linear (ActiveLeafMessageID nil) regardless of the source's branch state.
func (r *ConversationRepo) Clone(ctx context.Context, srcID string, throughMsgID uint64, newID, title string) (*aimodel.AIConversation, error) {
	var src aimodel.AIConversation
	if err := r.db.WithContext(ctx).First(&src, "id = ?", srcID).Error; err != nil {
		return nil, err
	}
	var msgs []aimodel.AIMessage
	if err := r.db.WithContext(ctx).
		Where("conversation_id = ?", srcID).Order("id").Find(&msgs).Error; err != nil {
		return nil, err
	}
	pathIDs := branchPathIDs(msgs, src.ActiveLeafMessageID)
	if throughMsgID > 0 {
		for i, id := range pathIDs {
			if id == throughMsgID {
				pathIDs = pathIDs[:i+1]
				break
			}
		}
	}
	keep := make(map[uint64]bool, len(pathIDs))
	for _, id := range pathIDs {
		keep[id] = true
	}
	now := time.Now()
	newConv := &aimodel.AIConversation{
		ID: newID, UserID: src.UserID, AgentID: src.AgentID, Title: title,
		ProviderID: src.ProviderID, Model: src.Model, PermissionMode: src.PermissionMode,
		Status: aimodel.ConvStatusActive, Temperature: src.Temperature, TopP: src.TopP,
		MaxTokens: src.MaxTokens, ThinkingBudget: src.ThinkingBudget,
		ParentConversation: &srcID, CreatedAt: now, UpdatedAt: now,
	}
	err := r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(newConv).Error; err != nil {
			return err
		}
		idMap := map[uint64]uint64{}
		count := 0
		for i := range msgs {
			m := msgs[i]
			if !keep[m.ID] {
				continue
			}
			nm := m
			nm.ID = 0
			nm.ConversationID = newID
			if m.ParentID != nil {
				if np, ok := idMap[*m.ParentID]; ok {
					nm.ParentID = &np
				} else {
					nm.ParentID = nil
				}
			}
			if err := tx.Create(&nm).Error; err != nil {
				return err
			}
			idMap[m.ID] = nm.ID
			count++
		}
		newConv.MessageCount = count
		return tx.Model(newConv).Update("message_count", count).Error
	})
	if err != nil {
		return nil, err
	}
	return newConv, nil
}

// branchPathIDs returns the ordered message ids to follow: the path from the
// branch leaf up to the root (root→leaf) when leaf is set, else every message
// in linear id order.
func branchPathIDs(msgs []aimodel.AIMessage, leaf *uint64) []uint64 {
	if leaf == nil {
		ids := make([]uint64, len(msgs))
		for i := range msgs {
			ids[i] = msgs[i].ID
		}
		return ids
	}
	byID := make(map[uint64]*aimodel.AIMessage, len(msgs))
	for i := range msgs {
		byID[msgs[i].ID] = &msgs[i]
	}
	cur, ok := byID[*leaf]
	if !ok {
		ids := make([]uint64, len(msgs))
		for i := range msgs {
			ids[i] = msgs[i].ID
		}
		return ids
	}
	var rev []uint64
	for steps := 0; cur != nil && steps <= len(msgs); steps++ {
		rev = append(rev, cur.ID)
		if cur.ParentID == nil {
			break
		}
		cur = byID[*cur.ParentID]
	}
	for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
		rev[i], rev[j] = rev[j], rev[i]
	}
	return rev
}

func escapeLike(q string) string {
	// minimal escape so the user's _ and % don't act as wildcards
	out := make([]byte, 0, len(q))
	for i := 0; i < len(q); i++ {
		c := q[i]
		if c == '\\' || c == '_' || c == '%' {
			out = append(out, '\\')
		}
		out = append(out, c)
	}
	return string(out)
}

// UsageBucket is one row of aggregated usage. The grouping dimensions present
// (day / model / provider_id) depend on the UsageQuery; absent dimensions stay
// zero-valued and are omitted from JSON.
type UsageBucket struct {
	Day              string `json:"day,omitempty"`
	Model            string `json:"model,omitempty"`
	ProviderID       uint64 `json:"provider_id,omitempty"`
	InputTokens      uint64 `json:"input_tokens"`
	OutputTokens     uint64 `json:"output_tokens"`
	CacheReadTokens  uint64 `json:"cache_read_tokens"`
	CacheWriteTokens uint64 `json:"cache_write_tokens"`
	CostMicros       uint64 `json:"cost_micros"`
	Messages         int    `json:"messages"`
}

// UsageQuery selects the aggregation dimensions + an optional provider filter.
type UsageQuery struct {
	GroupBy    []string // subset of {"day","model","provider"}; empty → day+model
	ProviderID uint64   // 0 = all providers
}

// usageGroupCols maps a whitelisted dimension to its (select, group-by) SQL.
// Provider attribution joins through ai_conversations.provider_id (the message
// rows carry no provider id), so it reflects the conversation's CURRENT provider
// — slightly approximate for conversations that switched provider mid-stream.
var usageGroupCols = map[string][2]string{
	"day":      {"DATE(m.created_at) AS day", "day"},
	"model":    {"m.model AS model", "m.model"},
	"provider": {"c.provider_id AS provider_id", "c.provider_id"},
}

func normalizeUsageGroups(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, g := range in {
		g = strings.ToLower(strings.TrimSpace(g))
		if _, ok := usageGroupCols[g]; ok && !seen[g] {
			seen[g] = true
			out = append(out, g)
		}
	}
	if len(out) == 0 {
		return []string{"day", "model"}
	}
	return out
}

// AggregateUsage sums assistant-turn token/cache/cost across the time window,
// grouped by the requested dimensions. adminAll = true aggregates every user's
// usage; otherwise it is scoped to userID.
func (r *ConversationRepo) AggregateUsage(ctx context.Context, userID uint64, adminAll bool, from, to time.Time, opt UsageQuery) ([]UsageBucket, error) {
	groups := normalizeUsageGroups(opt.GroupBy)
	groupByProvider := false
	sel := make([]string, 0, len(groups)+6)
	grp := make([]string, 0, len(groups))
	for _, g := range groups {
		cols := usageGroupCols[g]
		sel = append(sel, cols[0])
		grp = append(grp, cols[1])
		if g == "provider" {
			groupByProvider = true
		}
	}
	sel = append(sel,
		"SUM(m.input_tokens) AS input_tokens", "SUM(m.output_tokens) AS output_tokens",
		"SUM(m.cache_read_tokens) AS cache_read_tokens", "SUM(m.cache_write_tokens) AS cache_write_tokens",
		"SUM(m.cost_micros) AS cost_micros", "COUNT(*) AS messages")

	needJoin := !adminAll || opt.ProviderID != 0 || groupByProvider
	q := r.db.WithContext(ctx).
		Table("ai_messages AS m").
		Select(strings.Join(sel, ", ")).
		Where("m.role = ?", aimodel.RoleAssistant).
		Where("m.created_at >= ? AND m.created_at < ?", from, to)
	if needJoin {
		q = q.Joins("JOIN ai_conversations c ON c.id = m.conversation_id")
	}
	if !adminAll {
		q = q.Where("c.user_id = ?", userID)
	}
	if opt.ProviderID != 0 {
		q = q.Where("c.provider_id = ?", opt.ProviderID)
	}
	q = q.Group(strings.Join(grp, ", "))
	for _, g := range groups {
		if g == "day" {
			q = q.Order("day DESC")
			break
		}
	}
	var out []UsageBucket
	err := q.Scan(&out).Error
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
		if err := tx.Where("conversation_id IN ?", ids).Delete(&aimodel.AITask{}).Error; err != nil {
			return err
		}
		return tx.Where("id IN ?", ids).Delete(&aimodel.AIConversation{}).Error
	})
	return int64(len(ids)), err
}
