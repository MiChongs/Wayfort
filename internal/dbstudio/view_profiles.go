package dbstudio

import (
	"context"

	"gorm.io/gorm"
)

// ViewProfilesStore persists per-table view customisations (column order,
// filters, sort) keyed by (owner, node, table). Phase 1 stub — concrete
// GORM mapping lands in sub-project C.
type ViewProfilesStore struct{ db *gorm.DB }

// ViewProfile is one persisted table-view customisation.
type ViewProfile struct {
	ID          int64
	OwnerID     int64
	NodeID      int64
	Table       string
	ColumnsJSON string
	FilterJSON  string
	SortJSON    string
	UpdatedAt   int64 // unix
}

// List returns the view profiles visible to ownerID.
func (s *ViewProfilesStore) List(ctx context.Context, ownerID string) ([]ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.ViewProfilesStore.List: phase-1 stub; implement in sub-project C plan")
}

// Get returns a single view profile by id.
func (s *ViewProfilesStore) Get(ctx context.Context, id int64) (*ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.ViewProfilesStore.Get: phase-1 stub; implement in sub-project C plan")
}

// Create persists a new view profile and returns it with its id set.
func (s *ViewProfilesStore) Create(ctx context.Context, p ViewProfile) (*ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.ViewProfilesStore.Create: phase-1 stub; implement in sub-project C plan")
}

// Update overwrites a view profile identified by p.ID.
func (s *ViewProfilesStore) Update(ctx context.Context, p ViewProfile) (*ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.ViewProfilesStore.Update: phase-1 stub; implement in sub-project C plan")
}

// Delete removes a view profile by id.
func (s *ViewProfilesStore) Delete(ctx context.Context, id int64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	panic("dbstudio.ViewProfilesStore.Delete: phase-1 stub; implement in sub-project C plan")
}
