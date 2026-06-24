package dbstudio

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"

	"github.com/michongs/wayfort/internal/model"
)

// ViewProfilesStore persists per-table view customisations (column order,
// filters, sort) keyed by (owner, node, table). Backed by GORM against
// model.ViewProfile.
type ViewProfilesStore struct{ db *gorm.DB }

// ViewProfile is the dbstudio wire type for one persisted table-view
// customisation. Field types mirror model.ViewProfile (uint64 ids,
// time.Time stamps) so the GORM boundary is cast-free.
type ViewProfile struct {
	ID          uint64    `json:"id"`
	OwnerID     uint64    `json:"owner_id"`
	NodeID      uint64    `json:"node_id"`
	TableFQN    string    `json:"table_fqn"`
	Name        string    `json:"name"`
	FilterJSON  string    `json:"filter_json,omitempty"`
	SortJSON    string    `json:"sort_json,omitempty"`
	ColumnsJSON string    `json:"columns_json,omitempty"`
	IsDefault   bool      `json:"is_default"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// List returns the view profiles for (ownerID, nodeID, tableFQN), default
// first then newest.
func (s *ViewProfilesStore) List(ctx context.Context, ownerID, nodeID uint64, tableFQN string) ([]ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	var rows []model.ViewProfile
	if err := s.db.WithContext(ctx).
		Where("owner_id = ? AND node_id = ? AND table_fqn = ?", ownerID, nodeID, tableFQN).
		Order("is_default DESC, updated_at DESC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]ViewProfile, len(rows))
	for i, r := range rows {
		out[i] = toViewProfile(r)
	}
	return out, nil
}

// Get returns a single view profile by id.
func (s *ViewProfilesStore) Get(ctx context.Context, id uint64) (*ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	var r model.ViewProfile
	if err := s.db.WithContext(ctx).First(&r, id).Error; err != nil {
		return nil, err
	}
	p := toViewProfile(r)
	return &p, nil
}

// Create persists a new view profile and returns it with id + timestamp
// set. Requires OwnerID, NodeID, TableFQN and Name.
func (s *ViewProfilesStore) Create(ctx context.Context, p ViewProfile) (*ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	if p.OwnerID == 0 || p.NodeID == 0 || p.TableFQN == "" || p.Name == "" {
		return nil, errors.New("dbstudio: view profile requires OwnerID, NodeID, TableFQN, Name")
	}
	r := fromViewProfile(p)
	if err := s.db.WithContext(ctx).Create(&r).Error; err != nil {
		return nil, err
	}
	out := toViewProfile(r)
	return &out, nil
}

// Update overwrites the view profile identified by p.ID.
func (s *ViewProfilesStore) Update(ctx context.Context, p ViewProfile) (*ViewProfile, error) {
	if s == nil || s.db == nil {
		return nil, ErrUnavailable
	}
	if p.ID == 0 {
		return nil, errors.New("dbstudio: update requires ID")
	}
	r := fromViewProfile(p)
	if err := s.db.WithContext(ctx).Save(&r).Error; err != nil {
		return nil, err
	}
	out := toViewProfile(r)
	return &out, nil
}

// Delete removes a view profile by id.
func (s *ViewProfilesStore) Delete(ctx context.Context, id uint64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	return s.db.WithContext(ctx).Delete(&model.ViewProfile{}, id).Error
}

// SetDefault flips the is_default flag for id and clears it for every
// sibling profile on the same (owner, node, table). All inside one
// transaction so the table always has at most one default.
func (s *ViewProfilesStore) SetDefault(ctx context.Context, id uint64) error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	return s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var target model.ViewProfile
		if err := tx.First(&target, id).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.ViewProfile{}).
			Where("owner_id = ? AND node_id = ? AND table_fqn = ?", target.OwnerID, target.NodeID, target.TableFQN).
			Update("is_default", false).Error; err != nil {
			return err
		}
		return tx.Model(&target).Update("is_default", true).Error
	})
}

func toViewProfile(r model.ViewProfile) ViewProfile {
	return ViewProfile{
		ID: r.ID, OwnerID: r.OwnerID, NodeID: r.NodeID,
		TableFQN: r.TableFQN, Name: r.Name,
		FilterJSON: r.FilterJSON, SortJSON: r.SortJSON, ColumnsJSON: r.ColumnsJSON,
		IsDefault: r.IsDefault, UpdatedAt: r.UpdatedAt,
	}
}

func fromViewProfile(p ViewProfile) model.ViewProfile {
	return model.ViewProfile{
		ID: p.ID, OwnerID: p.OwnerID, NodeID: p.NodeID,
		TableFQN: p.TableFQN, Name: p.Name,
		FilterJSON: p.FilterJSON, SortJSON: p.SortJSON, ColumnsJSON: p.ColumnsJSON,
		IsDefault: p.IsDefault,
	}
}
