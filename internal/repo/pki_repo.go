package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// PKIRepo backs the embedded CA row and the issued-certificate ledger
// (security-architecture.md §6 / §12).
type PKIRepo struct{ db *gorm.DB }

func NewPKIRepo(db *gorm.DB) *PKIRepo { return &PKIRepo{db: db} }

// ActiveCA returns the active CA row, or nil if none has been bootstrapped.
func (r *PKIRepo) ActiveCA(ctx context.Context) (*model.PKICA, error) {
	var ca model.PKICA
	err := r.db.WithContext(ctx).Where("active = ?", true).First(&ca).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &ca, err
}

// CreateCA inserts a new CA row.
func (r *PKIRepo) CreateCA(ctx context.Context, ca *model.PKICA) error {
	return r.db.WithContext(ctx).Create(ca).Error
}

// RecordCert appends a row to the issued-certificate ledger.
func (r *PKIRepo) RecordCert(ctx context.Context, cert *model.PKICertificate) error {
	return r.db.WithContext(ctx).Create(cert).Error
}

// FindCertBySerial looks up a ledger row by serial.
func (r *PKIRepo) FindCertBySerial(ctx context.Context, serial string) (*model.PKICertificate, error) {
	var cert model.PKICertificate
	err := r.db.WithContext(ctx).Where("serial = ?", serial).First(&cert).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &cert, err
}

// IsRevoked reports whether the serial has been revoked. An unknown serial is
// treated as revoked (fail-closed): the gateway only ever presents serials it
// issued, so an unrecognised one is suspect.
func (r *PKIRepo) IsRevoked(ctx context.Context, serial string) (bool, error) {
	cert, err := r.FindCertBySerial(ctx, serial)
	if err != nil {
		return true, err
	}
	if cert == nil {
		return true, nil
	}
	return cert.Revoked(), nil
}

// RevokeBySerial marks a certificate revoked. Idempotent.
func (r *PKIRepo) RevokeBySerial(ctx context.Context, serial, reason string, at time.Time) error {
	return r.db.WithContext(ctx).Model(&model.PKICertificate{}).
		Where("serial = ? AND revoked_at IS NULL", serial).
		Updates(map[string]any{"revoked_at": at, "revoke_reason": reason}).Error
}

// RevokeBySubject revokes all live certs for a subject (e.g. when an agent is
// revoked, kill every cert it ever held).
func (r *PKIRepo) RevokeBySubject(ctx context.Context, kind string, subjectID uint64, reason string, at time.Time) error {
	return r.db.WithContext(ctx).Model(&model.PKICertificate{}).
		Where("subject_kind = ? AND subject_id = ? AND revoked_at IS NULL", kind, subjectID).
		Updates(map[string]any{"revoked_at": at, "revoke_reason": reason}).Error
}

// ListCerts returns the ledger, newest first, optionally filtered by subject.
func (r *PKIRepo) ListCerts(ctx context.Context, subjectKind string, subjectID uint64) ([]model.PKICertificate, error) {
	q := r.db.WithContext(ctx).Model(&model.PKICertificate{})
	if subjectKind != "" {
		q = q.Where("subject_kind = ?", subjectKind)
	}
	if subjectID != 0 {
		q = q.Where("subject_id = ?", subjectID)
	}
	var out []model.PKICertificate
	err := q.Order("created_at DESC").Find(&out).Error
	return out, err
}
