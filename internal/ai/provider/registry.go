package provider

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
)

// Registry caches built Provider instances so we don't re-do API discovery on
// every chat turn. Invalidate must be called after admin changes a row.
type Registry struct {
	repo   *airepo.ProviderRepo
	sealer pkgcrypto.Vault

	mu    sync.RWMutex
	built map[uint64]cachedProvider
	ttl   time.Duration
}

type cachedProvider struct {
	p   Provider
	at  time.Time
}

func NewRegistry(repo *airepo.ProviderRepo, sealer pkgcrypto.Vault) *Registry {
	return &Registry{repo: repo, sealer: sealer, built: map[uint64]cachedProvider{}, ttl: 30 * time.Minute}
}

// Get returns a Provider instance for the supplied row id. The user id is used
// to enforce visibility: a non-admin can't use a provider that's neither global
// nor owned by them.
func (r *Registry) Get(ctx context.Context, providerID, userID uint64) (Provider, *aimodel.AIProvider, error) {
	row, err := r.repo.FindByID(ctx, providerID)
	if err != nil {
		return nil, nil, err
	}
	if row == nil {
		return nil, nil, errors.New("provider not found")
	}
	if !row.IsGlobal && (row.OwnerID == nil || *row.OwnerID != userID) {
		return nil, nil, errors.New("provider not visible to user")
	}
	p, err := r.getOrBuild(ctx, row)
	if err != nil {
		return nil, row, err
	}
	return p, row, nil
}

// BuildFor returns a cached/built Provider for a row the caller has already
// loaded, WITHOUT a per-user visibility check. Only trusted system callers (e.g.
// the background health prober) should use it.
func (r *Registry) BuildFor(ctx context.Context, row *aimodel.AIProvider) (Provider, error) {
	if row == nil {
		return nil, errors.New("nil provider row")
	}
	return r.getOrBuild(ctx, row)
}

// getOrBuild is the shared cache-or-construct path behind Get/BuildFor.
func (r *Registry) getOrBuild(ctx context.Context, row *aimodel.AIProvider) (Provider, error) {
	r.mu.RLock()
	if c, ok := r.built[row.ID]; ok && time.Since(c.at) < r.ttl {
		r.mu.RUnlock()
		return c.p, nil
	}
	r.mu.RUnlock()

	p, err := Build(ctx, row, r.sealer)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.built[row.ID] = cachedProvider{p: p, at: time.Now()}
	r.mu.Unlock()
	return p, nil
}

// Invalidate flushes the cache for one provider — call after admin updates it.
func (r *Registry) Invalidate(providerID uint64) {
	r.mu.Lock()
	delete(r.built, providerID)
	r.mu.Unlock()
}

// Resolve picks the provider to use for an agent + user. Order:
//  1. explicit overrideID (e.g. from the conversation row)
//  2. agent.DefaultProviderID
//  3. user's first visible provider
//  4. first enabled global provider
func (r *Registry) Resolve(ctx context.Context, userID uint64, overrideID *uint64, agent *aimodel.AIAgent) (Provider, *aimodel.AIProvider, error) {
	if overrideID != nil && *overrideID != 0 {
		return r.Get(ctx, *overrideID, userID)
	}
	if agent != nil && agent.DefaultProviderID != nil && *agent.DefaultProviderID != 0 {
		return r.Get(ctx, *agent.DefaultProviderID, userID)
	}
	rows, err := r.repo.VisibleTo(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	if len(rows) > 0 {
		return r.Get(ctx, rows[0].ID, userID)
	}
	row, err := r.repo.FirstGlobalEnabled(ctx)
	if err != nil {
		return nil, nil, err
	}
	if row == nil {
		return nil, nil, fmt.Errorf("no AI provider configured")
	}
	return r.Get(ctx, row.ID, userID)
}
