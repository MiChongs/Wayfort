package repo

import (
	"context"
	"errors"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// KMSProviderRepo persists kms_providers rows.
type KMSProviderRepo struct{ db *gorm.DB }

// NewKMSProviderRepo wraps the GORM handle.
func NewKMSProviderRepo(db *gorm.DB) *KMSProviderRepo { return &KMSProviderRepo{db: db} }

// Create persists a provider row. If IsPrimary is true on the new
// row, any existing primary is demoted in the same transaction so
// the system never has two primaries at once.
func (r *KMSProviderRepo) Create(ctx context.Context, row *model.KMSProvider) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if row.IsPrimary {
			if err := tx.Model(&model.KMSProvider{}).
				Where("is_primary = ?", true).
				Update("is_primary", false).Error; err != nil {
				return err
			}
		}
		return tx.Create(row).Error
	})
}

// Update persists changes to an existing provider, again with primary
// re-assignment serialised inside a transaction.
func (r *KMSProviderRepo) Update(ctx context.Context, row *model.KMSProvider) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if row.IsPrimary {
			if err := tx.Model(&model.KMSProvider{}).
				Where("is_primary = ? AND id <> ?", true, row.ID).
				Update("is_primary", false).Error; err != nil {
				return err
			}
		}
		return tx.Save(row).Error
	})
}

// Delete removes a provider row. The caller is responsible for
// verifying no envelopes still point at this provider; otherwise the
// envelopes become undecryptable.
func (r *KMSProviderRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.KMSProvider{}, id).Error
}

// FindByID returns the row. Returns (nil, nil) when missing.
func (r *KMSProviderRepo) FindByID(ctx context.Context, id uint64) (*model.KMSProvider, error) {
	var row model.KMSProvider
	if err := r.db.WithContext(ctx).First(&row, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &row, nil
}

// FindByName looks up by the human alias. Used by the setup wizard so
// administrators can refer to providers by name in scripts.
func (r *KMSProviderRepo) FindByName(ctx context.Context, name string) (*model.KMSProvider, error) {
	var row model.KMSProvider
	if err := r.db.WithContext(ctx).Where("name = ?", name).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &row, nil
}

// Primary returns the current primary provider. Required at boot — if
// nil, the gateway enters sealed mode and only /setup endpoints serve.
func (r *KMSProviderRepo) Primary(ctx context.Context) (*model.KMSProvider, error) {
	var row model.KMSProvider
	if err := r.db.WithContext(ctx).
		Where("is_primary = ? AND enabled = ?", true, true).
		First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &row, nil
}

// SetPrimary atomically promotes one provider to primary and demotes
// any others. Used by the setup wizard's "promote this provider"
// action after a successful Healthcheck.
func (r *KMSProviderRepo) SetPrimary(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.KMSProvider{}).
			Where("is_primary = ? AND id <> ?", true, id).
			Update("is_primary", false).Error; err != nil {
			return err
		}
		res := tx.Model(&model.KMSProvider{}).
			Where("id = ?", id).
			Update("is_primary", true)
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return fmt.Errorf("set primary: provider %d not found", id)
		}
		return nil
	})
}

// List returns every provider row, primary first then by id.
func (r *KMSProviderRepo) List(ctx context.Context) ([]model.KMSProvider, error) {
	var rows []model.KMSProvider
	if err := r.db.WithContext(ctx).
		Order("is_primary DESC, id ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}
