package dbstudio

import (
	"context"
	"time"

	"gorm.io/gorm"

	"github.com/michongs/wayfort/internal/model"
)

// PinnedResultsStore persists named query result snapshots a user pins for
// later comparison. The snapshot is stored as a gzipped JSON blob
// (SnapshotEncode) in the model's SnapshotArrow LONGBLOB column. Backed by
// GORM against model.PinnedResult.
type PinnedResultsStore struct{ db *gorm.DB }

// PinnedResultEntry is the dbstudio wire type for one pinned snapshot. It
// carries the decoded Rows slice (the Get path decodes the blob; the Create
// path encodes it), so callers never touch gzip directly.
type PinnedResultEntry struct {
	ID         uint64    `json:"id"`
	OwnerID    uint64    `json:"owner_id"`
	NodeID     uint64    `json:"node_id"`
	SQL        string    `json:"sql"`
	ParamsJSON string    `json:"params_json,omitempty"`
	ExecutedAt time.Time `json:"executed_at"`
	// Rows is decoded on Get; omitted from List payloads to keep them
	// small (fetch the full snapshot via Get).
	Rows      []map[string]any `json:"rows,omitempty"`
	Truncated bool             `json:"truncated,omitempty"`
	TTL       time.Time        `json:"ttl"`
	RowCount  int64            `json:"row_count"`
}

// Create persists a new pinned result: encodes Rows via SnapshotEncode,
// stores the blob, and returns the entry with id + row count + truncated
// flag set.
func (s *PinnedResultsStore) Create(ctx context.Context, e PinnedResultEntry) (*PinnedResultEntry, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	blob, truncated, err := SnapshotEncode(e.Rows)
	if err != nil {
		return nil, err
	}
	row := model.PinnedResult{
		OwnerID: e.OwnerID, NodeID: e.NodeID, SQL: e.SQL,
		ParamsJSON: e.ParamsJSON, ExecutedAt: e.ExecutedAt,
		RowCount: int64(len(e.Rows)), SnapshotArrow: blob, TTL: e.TTL,
	}
	if err := s.db.WithContext(ctx).Create(&row).Error; err != nil {
		return nil, err
	}
	out := e
	out.ID = row.ID
	out.RowCount = row.RowCount
	out.Truncated = truncated
	return &out, nil
}

// Get returns a single pinned result, decoding the snapshot blob back into
// Rows.
func (s *PinnedResultsStore) Get(ctx context.Context, id uint64) (*PinnedResultEntry, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	var row model.PinnedResult
	if err := s.db.WithContext(ctx).First(&row, id).Error; err != nil {
		return nil, err
	}
	rows, err := SnapshotDecode(row.SnapshotArrow)
	if err != nil {
		return nil, err
	}
	return &PinnedResultEntry{
		ID: row.ID, OwnerID: row.OwnerID, NodeID: row.NodeID,
		SQL: row.SQL, ParamsJSON: row.ParamsJSON, ExecutedAt: row.ExecutedAt,
		Rows: rows, RowCount: row.RowCount, TTL: row.TTL,
	}, nil
}

// List returns pinned results for ownerID, newest first. Rows are NOT
// decoded here — fetch the full snapshot via Get(id).
func (s *PinnedResultsStore) List(ctx context.Context, ownerID uint64) ([]PinnedResultEntry, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	var rows []model.PinnedResult
	if err := s.db.WithContext(ctx).
		Where("owner_id = ?", ownerID).
		Order("executed_at DESC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]PinnedResultEntry, len(rows))
	for i, r := range rows {
		out[i] = PinnedResultEntry{
			ID: r.ID, OwnerID: r.OwnerID, NodeID: r.NodeID,
			SQL: r.SQL, ParamsJSON: r.ParamsJSON, ExecutedAt: r.ExecutedAt,
			RowCount: r.RowCount, TTL: r.TTL,
		}
	}
	return out, nil
}

// Delete removes a pinned result by id.
func (s *PinnedResultsStore) Delete(ctx context.Context, id uint64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	return s.db.WithContext(ctx).Delete(&model.PinnedResult{}, id).Error
}
