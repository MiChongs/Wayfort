package dbstudio

import (
	"context"

	"gorm.io/gorm"
)

// SavedQueriesStore persists user/team saved SQL queries organised in a
// folder tree. Phase 1 stub — concrete GORM mapping lands in sub-project A.
type SavedQueriesStore struct{ db *gorm.DB }

// SavedQuery is one persisted named query.
type SavedQuery struct {
	ID          int64
	OwnerID     int64
	Name        string
	FolderPath  string
	SQL         string
	ParamsJSON  string
	SharedScope string // user|team|node
	UpdatedAt   int64  // unix
}

// List returns the saved queries visible to ownerID.
func (s *SavedQueriesStore) List(ctx context.Context, ownerID string) ([]SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.SavedQueriesStore.List: phase-1 stub; implement in sub-project A plan")
}

// Get returns a single saved query by id.
func (s *SavedQueriesStore) Get(ctx context.Context, id int64) (*SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.SavedQueriesStore.Get: phase-1 stub; implement in sub-project A plan")
}

// Create persists a new saved query and returns it with its id set.
func (s *SavedQueriesStore) Create(ctx context.Context, q SavedQuery) (*SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.SavedQueriesStore.Create: phase-1 stub; implement in sub-project A plan")
}

// Update overwrites a saved query identified by q.ID.
func (s *SavedQueriesStore) Update(ctx context.Context, q SavedQuery) (*SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.SavedQueriesStore.Update: phase-1 stub; implement in sub-project A plan")
}

// Delete removes a saved query by id.
func (s *SavedQueriesStore) Delete(ctx context.Context, id int64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	panic("dbstudio.SavedQueriesStore.Delete: phase-1 stub; implement in sub-project A plan")
}
