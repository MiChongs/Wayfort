package repo

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// SecretEnvelopeRepo persists per-credential envelope rows. The
// envelope is the authoritative ciphertext + wrapping-key reference;
// the owning row (Credential, OIDCClient, UserMFA, AIProvider, ...)
// holds an opaque pointer that the Vault adapter resolves.
type SecretEnvelopeRepo struct{ db *gorm.DB }

// NewSecretEnvelopeRepo wraps the GORM handle.
func NewSecretEnvelopeRepo(db *gorm.DB) *SecretEnvelopeRepo { return &SecretEnvelopeRepo{db: db} }

// Create persists a fresh envelope. CreatedAt is filled by GORM.
func (r *SecretEnvelopeRepo) Create(ctx context.Context, env *model.SecretEnvelope) error {
	return r.db.WithContext(ctx).Create(env).Error
}

// FindByID returns the envelope row. Returns (nil, nil) when no such
// row exists — callers treat that as "secret missing", not an error.
func (r *SecretEnvelopeRepo) FindByID(ctx context.Context, id uint64) (*model.SecretEnvelope, error) {
	var env model.SecretEnvelope
	if err := r.db.WithContext(ctx).First(&env, id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &env, nil
}

// FindActive returns the currently-active envelope for the given owner
// tuple. Returns (nil, nil) when nothing is active. Used by Rewrap and
// by the credential read paths that need the latest version without
// chasing pointer columns first.
func (r *SecretEnvelopeRepo) FindActive(ctx context.Context, ownerType model.SecretEnvelopeOwnerType, ownerID uint64) (*model.SecretEnvelope, error) {
	var env model.SecretEnvelope
	q := r.db.WithContext(ctx).
		Where("owner_type = ? AND owner_id = ? AND status = ?", ownerType, ownerID, model.EnvelopeActive).
		Order("version DESC").
		First(&env)
	if err := q.Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}
	return &env, nil
}

// MarkRotated transitions an active envelope to "rotated" and stamps
// RotatedAt. Used by the rotation job after a successful rewrap.
func (r *SecretEnvelopeRepo) MarkRotated(ctx context.Context, id uint64) error {
	now := time.Now().UTC()
	return r.db.WithContext(ctx).Model(&model.SecretEnvelope{}).
		Where("id = ?", id).
		Updates(map[string]interface{}{
			"status":     model.EnvelopeRotated,
			"rotated_at": &now,
		}).Error
}

// MarkRevoked transitions any envelope (active or rotated) to revoked.
// A revoked envelope must never be decrypted again; the service layer
// refuses to call Decrypt on it.
func (r *SecretEnvelopeRepo) MarkRevoked(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Model(&model.SecretEnvelope{}).
		Where("id = ?", id).
		Update("status", model.EnvelopeRevoked).Error
}

// UpdateRewrap atomically swaps the encrypted DEK + KMS pointer fields
// after a successful rewrap. The DEK itself + Ciphertext stay the
// same; only the KEK wrapping changes.
func (r *SecretEnvelopeRepo) UpdateRewrap(ctx context.Context, id uint64, newCiphertext []byte, providerID uint64, keyID string, keyVersion int) error {
	res := r.db.WithContext(ctx).Model(&model.SecretEnvelope{}).
		Where("id = ?", id).
		Updates(map[string]interface{}{
			"encrypted_dek": newCiphertext,
			"provider_id":   providerID,
			"key_id":        keyID,
			"key_version":   keyVersion,
		})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return fmt.Errorf("rewrap: envelope %d not found", id)
	}
	return nil
}

// ListByProvider returns envelopes wrapped under the given KMS
// provider. Used by the rotation job to drive a "migrate from
// provider X to provider Y" sweep, paged 256 rows at a time.
func (r *SecretEnvelopeRepo) ListByProvider(ctx context.Context, providerID uint64, status model.SecretEnvelopeStatus, limit int, afterID uint64) ([]model.SecretEnvelope, error) {
	if limit <= 0 || limit > 1024 {
		limit = 256
	}
	var out []model.SecretEnvelope
	q := r.db.WithContext(ctx).
		Where("provider_id = ? AND status = ? AND id > ?", providerID, status, afterID).
		Order("id ASC").
		Limit(limit).
		Find(&out)
	return out, q.Error
}

// CountByProvider returns the total envelope count for a provider.
// Used by the setup UI to surface "5 envelopes still wrapped under
// the legacy local KMS — click to rotate".
func (r *SecretEnvelopeRepo) CountByProvider(ctx context.Context, providerID uint64) (active, rotated int64, err error) {
	if err = r.db.WithContext(ctx).Model(&model.SecretEnvelope{}).
		Where("provider_id = ? AND status = ?", providerID, model.EnvelopeActive).
		Count(&active).Error; err != nil {
		return 0, 0, err
	}
	if err = r.db.WithContext(ctx).Model(&model.SecretEnvelope{}).
		Where("provider_id = ? AND status = ?", providerID, model.EnvelopeRotated).
		Count(&rotated).Error; err != nil {
		return 0, 0, err
	}
	return active, rotated, nil
}

// Delete removes an envelope by ID. Used only by the explicit
// credential-delete path; the audit row keeps the historical record.
func (r *SecretEnvelopeRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.SecretEnvelope{}, id).Error
}
