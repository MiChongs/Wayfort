package repo

import (
	"context"
	"errors"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/gorm"
)

// DomainRepo backs CRUD for network domains plus the one-time bootstrap that
// seeds the built-in "default" direct domain and backfills every pre-existing
// node into it. See docs/security-architecture.md §3 and §12.
type DomainRepo struct{ db *gorm.DB }

func NewDomainRepo(db *gorm.DB) *DomainRepo { return &DomainRepo{db: db} }

func (r *DomainRepo) Create(ctx context.Context, d *model.Domain) error {
	return r.db.WithContext(ctx).Create(d).Error
}

func (r *DomainRepo) Update(ctx context.Context, d *model.Domain) error {
	return r.db.WithContext(ctx).Save(d).Error
}

// Delete removes a domain. The built-in default domain and any domain still
// referenced by a node are protected by the handler; this is the raw delete.
func (r *DomainRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.Domain{}, id).Error
}

func (r *DomainRepo) FindByID(ctx context.Context, id uint64) (*model.Domain, error) {
	var d model.Domain
	err := r.db.WithContext(ctx).First(&d, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &d, err
}

func (r *DomainRepo) List(ctx context.Context) ([]model.Domain, error) {
	var out []model.Domain
	// Default domain first, then by name, for a stable UI ordering.
	err := r.db.WithContext(ctx).Order("is_default DESC, name").Find(&out).Error
	return out, err
}

// Default returns the built-in default domain, or nil if it has not been
// bootstrapped yet.
func (r *DomainRepo) Default(ctx context.Context) (*model.Domain, error) {
	var d model.Domain
	err := r.db.WithContext(ctx).Where("is_default = ?", true).First(&d).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &d, err
}

// CountNodes reports how many nodes still reference the domain — used by the
// handler to refuse deletion of a non-empty domain.
func (r *DomainRepo) CountNodes(ctx context.Context, id uint64) (int64, error) {
	var n int64
	err := r.db.WithContext(ctx).Model(&model.Node{}).Where("domain_id = ?", id).Count(&n).Error
	return n, err
}

// EnsureDefault seeds the built-in default direct domain (idempotent) and
// backfills every node that has no domain into it, so existing deployments keep
// dialing exactly as before. Safe to run on every boot.
func (r *DomainRepo) EnsureDefault(ctx context.Context) (*model.Domain, error) {
	def, err := r.Default(ctx)
	if err != nil {
		return nil, err
	}
	if def == nil {
		def = &model.Domain{
			Name:        model.DefaultDomainName,
			Kind:        model.DomainDirect,
			Description: "内置默认直连域：迁移前的所有资产归入此域，连接行为保持不变。",
			IsDefault:   true,
		}
		if err := r.db.WithContext(ctx).Create(def).Error; err != nil {
			return nil, err
		}
	}
	// Backfill: any node without a domain joins the default domain. A node's
	// legacy ProxyChain (if any) still overrides at dial time, so this is a
	// pure ownership backfill with no behavioural change.
	if err := r.db.WithContext(ctx).Model(&model.Node{}).
		Where("domain_id IS NULL").
		Update("domain_id", def.ID).Error; err != nil {
		return nil, err
	}
	return def, nil
}
