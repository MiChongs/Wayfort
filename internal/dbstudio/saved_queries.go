package dbstudio

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"

	"github.com/michongs/wayfort/internal/model"
)

// SavedQueriesStore persists user/team saved SQL queries organised in a
// folder tree. Backed by GORM against model.SavedQuery.
type SavedQueriesStore struct{ db *gorm.DB }

// SavedQuery is the dbstudio wire type for one persisted named query. Its
// fields mirror model.SavedQuery exactly (uint64 ids, time.Time stamps) so
// the to/from GORM helpers stay cast-free and the JSON matches the model's
// json tags 1:1.
type SavedQuery struct {
	ID          uint64    `json:"id"`
	OwnerID     uint64    `json:"owner_id"`
	Name        string    `json:"name"`
	FolderPath  string    `json:"folder_path"`
	SQL         string    `json:"sql"`
	ParamsJSON  string    `json:"params_json,omitempty"`
	SharedScope string    `json:"shared_scope"` // user|team|node
	UpdatedAt   time.Time `json:"updated_at"`
}

// List returns the saved queries owned by ownerID, newest first.
func (s *SavedQueriesStore) List(ctx context.Context, ownerID uint64) ([]SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	var rows []model.SavedQuery
	if err := s.db.WithContext(ctx).
		Where("owner_id = ?", ownerID).
		Order("updated_at DESC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]SavedQuery, len(rows))
	for i, r := range rows {
		out[i] = toSavedQuery(r)
	}
	return out, nil
}

// Get returns a single saved query by id.
func (s *SavedQueriesStore) Get(ctx context.Context, id uint64) (*SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	var r model.SavedQuery
	if err := s.db.WithContext(ctx).First(&r, id).Error; err != nil {
		return nil, err
	}
	q := toSavedQuery(r)
	return &q, nil
}

// Create persists a new saved query and returns it with its id + timestamp
// set. Requires OwnerID, Name and SQL.
func (s *SavedQueriesStore) Create(ctx context.Context, q SavedQuery) (*SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	if q.OwnerID == 0 || q.Name == "" || q.SQL == "" {
		return nil, errors.New("dbstudio: saved query requires OwnerID, Name, SQL")
	}
	r := fromSavedQuery(q)
	if err := s.db.WithContext(ctx).Create(&r).Error; err != nil {
		return nil, err
	}
	out := toSavedQuery(r)
	return &out, nil
}

// Update overwrites the saved query identified by q.ID.
func (s *SavedQueriesStore) Update(ctx context.Context, q SavedQuery) (*SavedQuery, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	if q.ID == 0 {
		return nil, errors.New("dbstudio: update requires ID")
	}
	r := fromSavedQuery(q)
	if err := s.db.WithContext(ctx).Save(&r).Error; err != nil {
		return nil, err
	}
	out := toSavedQuery(r)
	return &out, nil
}

// Delete removes a saved query by id.
func (s *SavedQueriesStore) Delete(ctx context.Context, id uint64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	return s.db.WithContext(ctx).Delete(&model.SavedQuery{}, id).Error
}

// toSavedQuery / fromSavedQuery convert between the dbstudio wire type and
// the GORM model. Field types are identical so no casts appear here — that
// is the Phase 1 uint64 convention applied end to end.
func toSavedQuery(r model.SavedQuery) SavedQuery {
	return SavedQuery{
		ID: r.ID, OwnerID: r.OwnerID, Name: r.Name, FolderPath: r.FolderPath,
		SQL: r.SQL, ParamsJSON: r.ParamsJSON, SharedScope: r.SharedScope,
		UpdatedAt: r.UpdatedAt,
	}
}

func fromSavedQuery(q SavedQuery) model.SavedQuery {
	return model.SavedQuery{
		ID: q.ID, OwnerID: q.OwnerID, Name: q.Name, FolderPath: q.FolderPath,
		SQL: q.SQL, ParamsJSON: q.ParamsJSON, SharedScope: q.SharedScope,
	}
}
