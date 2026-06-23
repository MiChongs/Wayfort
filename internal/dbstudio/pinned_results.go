package dbstudio

import (
	"context"

	"gorm.io/gorm"
)

// PinnedResultsStore persists named query result snapshots a user pins for
// later comparison. Phase 1 stub — concrete GORM mapping lands in
// sub-project A.
type PinnedResultsStore struct{ db *gorm.DB }

// PinnedResult is one persisted result snapshot.
type PinnedResult struct {
	ID         int64
	OwnerID    int64
	Name       string
	NodeID     int64
	SQL        string
	ResultJSON string
	UpdatedAt  int64 // unix
}

// List returns the pinned results visible to ownerID.
func (s *PinnedResultsStore) List(ctx context.Context, ownerID string) ([]PinnedResult, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.PinnedResultsStore.List: phase-1 stub; implement in sub-project A plan")
}

// Get returns a single pinned result by id.
func (s *PinnedResultsStore) Get(ctx context.Context, id int64) (*PinnedResult, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.PinnedResultsStore.Get: phase-1 stub; implement in sub-project A plan")
}

// Create persists a new pinned result and returns it with its id set.
func (s *PinnedResultsStore) Create(ctx context.Context, r PinnedResult) (*PinnedResult, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.PinnedResultsStore.Create: phase-1 stub; implement in sub-project A plan")
}

// Update overwrites a pinned result identified by r.ID.
func (s *PinnedResultsStore) Update(ctx context.Context, r PinnedResult) (*PinnedResult, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.PinnedResultsStore.Update: phase-1 stub; implement in sub-project A plan")
}

// Delete removes a pinned result by id.
func (s *PinnedResultsStore) Delete(ctx context.Context, id int64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	panic("dbstudio.PinnedResultsStore.Delete: phase-1 stub; implement in sub-project A plan")
}
