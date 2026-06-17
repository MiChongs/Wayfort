package repo

import (
	"context"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/gorm"
)

// SecretAuditRepo persists every credential-pool access — success or
// failure. Writes are best-effort: a failed audit insert is logged
// but never fails the original operation.
type SecretAuditRepo struct{ db *gorm.DB }

// NewSecretAuditRepo wraps the GORM handle.
func NewSecretAuditRepo(db *gorm.DB) *SecretAuditRepo { return &SecretAuditRepo{db: db} }

// Insert writes one audit row.
func (r *SecretAuditRepo) Insert(ctx context.Context, row *model.SecretAudit) error {
	return r.db.WithContext(ctx).Create(row).Error
}

// ListByEnvelope returns the audit rows attached to a given envelope,
// most recent first, bounded to `limit` rows. Used by the credential
// detail page.
func (r *SecretAuditRepo) ListByEnvelope(ctx context.Context, envelopeID uint64, limit int) ([]model.SecretAudit, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	var out []model.SecretAudit
	q := r.db.WithContext(ctx).
		Where("envelope_id = ?", envelopeID).
		Order("id DESC").
		Limit(limit).
		Find(&out)
	return out, q.Error
}

// ListByOwner returns the audit rows for a (owner_type, owner_id)
// tuple. Distinct from ListByEnvelope because credential rotation
// produces multiple envelopes for the same owner; this query spans
// them all.
func (r *SecretAuditRepo) ListByOwner(ctx context.Context, ownerType model.SecretEnvelopeOwnerType, ownerID uint64, limit int) ([]model.SecretAudit, error) {
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	var out []model.SecretAudit
	q := r.db.WithContext(ctx).
		Where("owner_type = ? AND owner_id = ?", ownerType, ownerID).
		Order("id DESC").
		Limit(limit).
		Find(&out)
	return out, q.Error
}

// ListFailures returns recent failed-decrypt rows across all owners.
// Used by the admin dashboard's "recent decrypt failures" widget.
func (r *SecretAuditRepo) ListFailures(ctx context.Context, limit int) ([]model.SecretAudit, error) {
	if limit <= 0 || limit > 1000 {
		limit = 50
	}
	var out []model.SecretAudit
	q := r.db.WithContext(ctx).
		Where("success = ? AND operation = ?", false, model.AuditOpDecrypt).
		Order("id DESC").
		Limit(limit).
		Find(&out)
	return out, q.Error
}
