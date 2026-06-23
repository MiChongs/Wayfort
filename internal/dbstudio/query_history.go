package dbstudio

import (
	"context"

	"gorm.io/gorm"
)

// QueryHistoryStore persists the append-only log of executed queries per
// user/node. Phase 1 stub — concrete GORM mapping lands in sub-project A.
type QueryHistoryStore struct{ db *gorm.DB }

// QueryHistoryEntry is one executed-query record.
type QueryHistoryEntry struct {
	ID         int64
	OwnerID    int64
	NodeID     int64
	SQL        string
	Status     string // ok|error
	DurationMs int64
	Error      string
	ExecutedAt int64 // unix
}

// List returns query-history entries for ownerID, newest first.
func (s *QueryHistoryStore) List(ctx context.Context, ownerID string) ([]QueryHistoryEntry, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.QueryHistoryStore.List: phase-1 stub; implement in sub-project A plan")
}

// Get returns a single history entry by id.
func (s *QueryHistoryStore) Get(ctx context.Context, id int64) (*QueryHistoryEntry, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.QueryHistoryStore.Get: phase-1 stub; implement in sub-project A plan")
}

// Create appends a history entry and returns it with its id set.
func (s *QueryHistoryStore) Create(ctx context.Context, e QueryHistoryEntry) (*QueryHistoryEntry, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.QueryHistoryStore.Create: phase-1 stub; implement in sub-project A plan")
}

// Update overwrites a history entry identified by e.ID.
func (s *QueryHistoryStore) Update(ctx context.Context, e QueryHistoryEntry) (*QueryHistoryEntry, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.QueryHistoryStore.Update: phase-1 stub; implement in sub-project A plan")
}

// Delete removes a history entry by id.
func (s *QueryHistoryStore) Delete(ctx context.Context, id int64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	panic("dbstudio.QueryHistoryStore.Delete: phase-1 stub; implement in sub-project A plan")
}
