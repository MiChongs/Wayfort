package dbstudio

import (
	"context"
	"time"

	"gorm.io/gorm"

	"github.com/michongs/wayfort/internal/model"
)

// QueryHistoryStore persists the append-only log of executed queries per
// user/node. Backed by GORM against model.QueryHistory.
type QueryHistoryStore struct{ db *gorm.DB }

// QueryHistoryEntry is one executed-query record. Field types mirror
// model.QueryHistory (uint64 ids, time.Time stamps, *int64 nullable row
// count) so the GORM boundary needs no casts.
type QueryHistoryEntry struct {
	ID         uint64    `json:"id"`
	OwnerID    uint64    `json:"owner_id"`
	NodeID     uint64    `json:"node_id"`
	SQL        string    `json:"sql"`
	ParamsJSON string    `json:"params_json,omitempty"`
	ExecutedAt time.Time `json:"executed_at"`
	DurationMs int32     `json:"duration_ms"`
	// RowCount mirrors the brief's nullable BIGINT — nil distinguishes a
	// query that errored before producing rows from one that returned 0.
	RowCount  *int64 `json:"row_count,omitempty"`
	Status    string `json:"status"` // ok|error
	ErrorText string `json:"error_text,omitempty"`
}

// Append writes one history row. History is append-only: there is no
// Update. The caller (the Query handler) typically fires this in a
// goroutine so logging never blocks the response.
func (s *QueryHistoryStore) Append(ctx context.Context, e QueryHistoryEntry) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	row := fromHistoryEntry(e)
	return s.db.WithContext(ctx).Create(&row).Error
}

// List returns history entries for ownerID, newest first. nodeID > 0
// further narrows to one node; limit/offset paginate; since (when non-zero)
// filters to entries at or after that time.
func (s *QueryHistoryStore) List(ctx context.Context, ownerID, nodeID uint64, limit, offset int, since time.Time) ([]QueryHistoryEntry, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	q := s.db.WithContext(ctx).Where("owner_id = ?", ownerID)
	if nodeID > 0 {
		q = q.Where("node_id = ?", nodeID)
	}
	if !since.IsZero() {
		q = q.Where("executed_at >= ?", since)
	}
	q = q.Order("executed_at DESC")
	if limit > 0 {
		q = q.Limit(limit)
	}
	if offset > 0 {
		q = q.Offset(offset)
	}
	var rows []model.QueryHistory
	if err := q.Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]QueryHistoryEntry, len(rows))
	for i, r := range rows {
		out[i] = toHistoryEntry(r)
	}
	return out, nil
}

// Get returns a single history entry by id.
func (s *QueryHistoryStore) Get(ctx context.Context, id uint64) (*QueryHistoryEntry, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	var r model.QueryHistory
	if err := s.db.WithContext(ctx).First(&r, id).Error; err != nil {
		return nil, err
	}
	e := toHistoryEntry(r)
	return &e, nil
}

// Delete removes a history entry by id.
func (s *QueryHistoryStore) Delete(ctx context.Context, id uint64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	return s.db.WithContext(ctx).Delete(&model.QueryHistory{}, id).Error
}

func toHistoryEntry(r model.QueryHistory) QueryHistoryEntry {
	return QueryHistoryEntry{
		ID: r.ID, OwnerID: r.OwnerID, NodeID: r.NodeID, SQL: r.SQL,
		ParamsJSON: r.ParamsJSON, ExecutedAt: r.ExecutedAt, DurationMs: r.DurationMs,
		RowCount: r.RowCount, Status: r.Status, ErrorText: r.ErrorText,
	}
}

func fromHistoryEntry(e QueryHistoryEntry) model.QueryHistory {
	return model.QueryHistory{
		ID: e.ID, OwnerID: e.OwnerID, NodeID: e.NodeID, SQL: e.SQL,
		ParamsJSON: e.ParamsJSON, ExecutedAt: e.ExecutedAt, DurationMs: e.DurationMs,
		RowCount: e.RowCount, Status: e.Status, ErrorText: e.ErrorText,
	}
}
