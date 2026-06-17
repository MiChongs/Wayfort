package repo

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/gorm"
)

type CredentialRepo struct{ db *gorm.DB }

func NewCredentialRepo(db *gorm.DB) *CredentialRepo { return &CredentialRepo{db: db} }

func (r *CredentialRepo) Create(ctx context.Context, c *model.Credential) error {
	return r.db.WithContext(ctx).Create(c).Error
}

func (r *CredentialRepo) Update(ctx context.Context, c *model.Credential) error {
	return r.db.WithContext(ctx).Save(c).Error
}

func (r *CredentialRepo) Delete(ctx context.Context, id uint64) error {
	return r.db.WithContext(ctx).Delete(&model.Credential{}, id).Error
}

func (r *CredentialRepo) FindByID(ctx context.Context, id uint64) (*model.Credential, error) {
	var c model.Credential
	err := r.db.WithContext(ctx).First(&c, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &c, err
}

func (r *CredentialRepo) List(ctx context.Context) ([]model.Credential, error) {
	var out []model.Credential
	err := r.db.WithContext(ctx).Order("id").Find(&out).Error
	return out, err
}

// CredUsageRef is a lightweight pointer to a Node or Proxy that references a
// credential. Returned by UsageOf so the UI can show "where is this used"
// before a destructive delete.
type CredUsageRef struct {
	ID   uint64 `json:"id"`
	Name string `json:"name"`
	Host string `json:"host"`
	// Kind carries the node protocol or the proxy kind for display.
	Kind string `json:"kind,omitempty"`
}

// CredUsageCount is the per-credential reference tally used to enrich the list
// view without N round-trips.
type CredUsageCount struct {
	Nodes   int `json:"nodes"`
	Proxies int `json:"proxies"`
}

// UsageOf returns the Nodes and Proxies that reference the given credential.
func (r *CredentialRepo) UsageOf(ctx context.Context, id uint64) (nodes, proxies []CredUsageRef, err error) {
	db := r.db.WithContext(ctx)
	if err = db.Model(&model.Node{}).
		Select("id, name, host, protocol as kind").
		Where("credential_id = ?", id).
		Order("name").
		Scan(&nodes).Error; err != nil {
		return nil, nil, err
	}
	if err = db.Model(&model.Proxy{}).
		Select("id, name, host, kind").
		Where("credential_id = ?", id).
		Order("name").
		Scan(&proxies).Error; err != nil {
		return nil, nil, err
	}
	return nodes, proxies, nil
}

// UsageCounts returns reference tallies for every credential in a single pass
// over the nodes + proxies tables. Credentials with no references are absent
// from the map (treated as zero by callers).
func (r *CredentialRepo) UsageCounts(ctx context.Context) (map[uint64]CredUsageCount, error) {
	db := r.db.WithContext(ctx)
	out := map[uint64]CredUsageCount{}
	type tally struct {
		CredentialID uint64
		C            int
	}
	var nodeRows []tally
	if err := db.Model(&model.Node{}).
		Select("credential_id, count(*) as c").
		Where("credential_id <> 0").
		Group("credential_id").
		Scan(&nodeRows).Error; err != nil {
		return nil, err
	}
	for _, x := range nodeRows {
		cc := out[x.CredentialID]
		cc.Nodes = x.C
		out[x.CredentialID] = cc
	}
	var proxyRows []tally
	if err := db.Model(&model.Proxy{}).
		Select("credential_id, count(*) as c").
		Where("credential_id IS NOT NULL").
		Group("credential_id").
		Scan(&proxyRows).Error; err != nil {
		return nil, err
	}
	for _, x := range proxyRows {
		cc := out[x.CredentialID]
		cc.Proxies = x.C
		out[x.CredentialID] = cc
	}
	return out, nil
}

// TouchLastUsed best-effort stamps last_used_at without bumping updated_at.
// Callers in hot session paths should ignore the returned error.
func (r *CredentialRepo) TouchLastUsed(ctx context.Context, id uint64) error {
	if id == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Model(&model.Credential{}).
		Where("id = ?", id).
		UpdateColumn("last_used_at", time.Now()).Error
}

// TouchLastTested records the outcome of a connectivity test.
func (r *CredentialRepo) TouchLastTested(ctx context.Context, id uint64, ok bool) error {
	if id == 0 {
		return nil
	}
	return r.db.WithContext(ctx).Model(&model.Credential{}).
		Where("id = ?", id).
		UpdateColumns(map[string]any{
			"last_tested_at": time.Now(),
			"last_test_ok":   ok,
		}).Error
}
