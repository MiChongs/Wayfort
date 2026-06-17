package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/gorm"
)

// KMSSealRepo persists the (singleton) kms_seal_material row.
type KMSSealRepo struct{ db *gorm.DB }

// NewKMSSealRepo wraps the GORM handle.
func NewKMSSealRepo(db *gorm.DB) *KMSSealRepo { return &KMSSealRepo{db: db} }

// Get returns the singleton row. Returns (nil, nil) if it has never
// been initialised — the caller treats that as "first boot, run the
// setup wizard".
func (r *KMSSealRepo) Get(ctx context.Context) (*model.KMSSealMaterial, error) {
	var row model.KMSSealMaterial
	if err := r.db.WithContext(ctx).Order("id ASC").First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &row, nil
}

// Initialise stores the Argon2id salt + verifier pair. Only called
// once during setup — refuses to overwrite an existing row to avoid
// accidentally locking the operator out of their own envelopes.
func (r *KMSSealRepo) Initialise(ctx context.Context, salt, verifier []byte) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		var count int64
		if err := tx.Model(&model.KMSSealMaterial{}).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return errors.New("kms seal: already initialised")
		}
		row := &model.KMSSealMaterial{Salt: salt, Verifier: verifier}
		return tx.Create(row).Error
	})
}

// TouchUnseal stamps UnsealedAt = now on the singleton row. Best-
// effort; used by the setup-status endpoint to surface "last unseal
// successful at …".
func (r *KMSSealRepo) TouchUnseal(ctx context.Context) error {
	now := time.Now().UTC()
	return r.db.WithContext(ctx).Model(&model.KMSSealMaterial{}).
		Where("1 = 1").
		Update("unsealed_at", &now).Error
}
