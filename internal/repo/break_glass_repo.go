package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// BreakGlassRepo persists break-glass policies + activations. Activations are
// the governance objects; the actual access lives in asset_grants /
// approval_grants and is referenced by id.
type BreakGlassRepo struct{ db *gorm.DB }

func NewBreakGlassRepo(db *gorm.DB) *BreakGlassRepo { return &BreakGlassRepo{db: db} }

// DB exposes the handle for the rare aggregate query the service needs.
func (r *BreakGlassRepo) DB() *gorm.DB { return r.db }

// ----- Policies -----

func (r *BreakGlassRepo) CreatePolicy(ctx context.Context, p *model.BreakGlassPolicy) error {
	now := time.Now()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	p.UpdatedAt = now
	return r.db.WithContext(ctx).Create(p).Error
}

func (r *BreakGlassRepo) UpdatePolicy(ctx context.Context, p *model.BreakGlassPolicy) error {
	p.UpdatedAt = time.Now()
	return r.db.WithContext(ctx).Save(p).Error
}

func (r *BreakGlassRepo) DeletePolicy(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.BreakGlassPolicy{}, id).Error
}

func (r *BreakGlassRepo) FindPolicy(ctx context.Context, id uint64) (*model.BreakGlassPolicy, error) {
	var p model.BreakGlassPolicy
	err := r.db.WithContext(ctx).First(&p, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &p, err
}

func (r *BreakGlassRepo) FindPolicyByName(ctx context.Context, name string) (*model.BreakGlassPolicy, error) {
	var p model.BreakGlassPolicy
	err := r.db.WithContext(ctx).Where("name = ?", name).First(&p).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &p, err
}

func (r *BreakGlassRepo) ListPolicies(ctx context.Context) ([]model.BreakGlassPolicy, error) {
	var out []model.BreakGlassPolicy
	err := r.db.WithContext(ctx).Order("id ASC").Find(&out).Error
	return out, err
}

// EnabledPolicies returns enabled policies (the service picks the most specific
// one that governs a given node: node > tag > all).
func (r *BreakGlassRepo) EnabledPolicies(ctx context.Context) ([]model.BreakGlassPolicy, error) {
	var out []model.BreakGlassPolicy
	err := r.db.WithContext(ctx).Where("enabled = ?", true).Order("id ASC").Find(&out).Error
	return out, err
}

// CountPolicies reports how many policy rows exist (used by the idempotent seeder).
func (r *BreakGlassRepo) CountPolicies(ctx context.Context) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).Model(&model.BreakGlassPolicy{}).Count(&n).Error
	return n, err
}

// ----- Activations -----

func (r *BreakGlassRepo) CreateActivation(ctx context.Context, a *model.BreakGlassActivation) error {
	now := time.Now()
	if a.CreatedAt.IsZero() {
		a.CreatedAt = now
	}
	a.UpdatedAt = now
	return r.db.WithContext(ctx).Create(a).Error
}

// SaveActivation persists the full row (the service mutates lifecycle fields and
// saves; activations are small and single-writer per id, so a full Save is safe).
func (r *BreakGlassRepo) SaveActivation(ctx context.Context, a *model.BreakGlassActivation) error {
	a.UpdatedAt = time.Now()
	return r.db.WithContext(ctx).Save(a).Error
}

func (r *BreakGlassRepo) FindActivation(ctx context.Context, id string) (*model.BreakGlassActivation, error) {
	var a model.BreakGlassActivation
	err := r.db.WithContext(ctx).First(&a, "id = ?", id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &a, err
}

// BreakGlassFilter narrows the admin activation list.
type BreakGlassFilter struct {
	RequesterID uint64
	Status      string
	Mode        string
	ResourceID  string
	Q           string // substring over requester_name / resource_name / incident_ref / justification
	From        *time.Time
	To          *time.Time
	Limit       int
	Offset      int
}

func (r *BreakGlassRepo) scope(ctx context.Context, f BreakGlassFilter) *gorm.DB {
	q := r.db.WithContext(ctx).Model(&model.BreakGlassActivation{})
	if f.RequesterID != 0 {
		q = q.Where("requester_id = ?", f.RequesterID)
	}
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	if f.Mode != "" {
		q = q.Where("mode = ?", f.Mode)
	}
	if f.ResourceID != "" {
		q = q.Where("resource_id = ?", f.ResourceID)
	}
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at <= ?", *f.To)
	}
	if f.Q != "" {
		like := "%" + f.Q + "%"
		q = q.Where(
			"requester_name LIKE ? OR resource_name LIKE ? OR incident_ref LIKE ? OR justification LIKE ?",
			like, like, like, like,
		)
	}
	return q
}

func (r *BreakGlassRepo) ListActivations(ctx context.Context, f BreakGlassFilter) ([]model.BreakGlassActivation, int64, error) {
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 50
	}
	var total int64
	if err := r.scope(ctx, f).Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var out []model.BreakGlassActivation
	err := r.scope(ctx, f).Order("created_at DESC").Limit(f.Limit).Offset(f.Offset).Find(&out).Error
	return out, total, err
}

// ListByStatus fetches activations in a given status (reconciler input). limit
// bounds a single sweep.
func (r *BreakGlassRepo) ListByStatus(ctx context.Context, status model.BreakGlassStatus, limit int) ([]model.BreakGlassActivation, error) {
	if limit <= 0 {
		limit = 200
	}
	var out []model.BreakGlassActivation
	err := r.db.WithContext(ctx).Where("status = ?", status).Order("created_at ASC").Limit(limit).Find(&out).Error
	return out, err
}

// BreakGlassStats backs the governance overview tiles.
type BreakGlassStats struct {
	Active        int64 `json:"active"`
	Pending       int64 `json:"pending"`
	UnderReview   int64 `json:"under_review"`
	Total         int64 `json:"total"`
	Today         int64 `json:"today"`
	RevokedTotal  int64 `json:"revoked_total"`
	FailOpenTotal int64 `json:"fail_open_total"`
}

func (r *BreakGlassRepo) Stats(ctx context.Context) (*BreakGlassStats, error) {
	out := &BreakGlassStats{}
	base := func() *gorm.DB { return r.db.WithContext(ctx).Model(&model.BreakGlassActivation{}) }
	if err := base().Count(&out.Total).Error; err != nil {
		return nil, err
	}
	if err := base().Where("status = ?", model.BreakGlassActive).Count(&out.Active).Error; err != nil {
		return nil, err
	}
	if err := base().Where("status = ?", model.BreakGlassPending).Count(&out.Pending).Error; err != nil {
		return nil, err
	}
	if err := base().Where("status = ?", model.BreakGlassUnderReview).Count(&out.UnderReview).Error; err != nil {
		return nil, err
	}
	if err := base().Where("status = ?", model.BreakGlassRevoked).Count(&out.RevokedTotal).Error; err != nil {
		return nil, err
	}
	if err := base().Where("mode = ?", model.BreakGlassModeFailOpen).Count(&out.FailOpenTotal).Error; err != nil {
		return nil, err
	}
	since := time.Now().Add(-24 * time.Hour)
	if err := base().Where("created_at >= ?", since).Count(&out.Today).Error; err != nil {
		return nil, err
	}
	return out, nil
}
