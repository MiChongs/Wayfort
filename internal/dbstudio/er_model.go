package dbstudio

import (
	"context"

	"gorm.io/gorm"
)

// ERModelsStore persists user-authored ER diagrams (table layout + relations)
// per database node. Phase 1 stub — concrete GORM mapping lands in
// sub-project F.
type ERModelsStore struct{ db *gorm.DB }

// ERModel is one persisted diagram.
type ERModel struct {
	ID            int64
	OwnerID       int64
	NodeID        int64
	Name          string
	TablesJSON    string
	RelationsJSON string
	UpdatedAt     int64 // unix
}

// List returns the ER models visible to ownerID.
func (s *ERModelsStore) List(ctx context.Context, ownerID string) ([]ERModel, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.ERModelsStore.List: phase-1 stub; implement in sub-project F plan")
}

// Get returns a single ER model by id.
func (s *ERModelsStore) Get(ctx context.Context, id int64) (*ERModel, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.ERModelsStore.Get: phase-1 stub; implement in sub-project F plan")
}

// Create persists a new ER model and returns it with its id set.
func (s *ERModelsStore) Create(ctx context.Context, m ERModel) (*ERModel, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.ERModelsStore.Create: phase-1 stub; implement in sub-project F plan")
}

// Update overwrites an ER model identified by m.ID.
func (s *ERModelsStore) Update(ctx context.Context, m ERModel) (*ERModel, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	panic("dbstudio.ERModelsStore.Update: phase-1 stub; implement in sub-project F plan")
}

// Delete removes an ER model by id.
func (s *ERModelsStore) Delete(ctx context.Context, id int64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	panic("dbstudio.ERModelsStore.Delete: phase-1 stub; implement in sub-project F plan")
}
