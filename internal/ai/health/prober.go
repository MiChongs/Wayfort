package health

import (
	"context"
	"sync"
	"time"

	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	"github.com/michongs/jumpserver-anonymous/internal/ai/provider"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/panjf2000/ants/v2"
	"go.uber.org/zap"
)

// Config tunes the background prober.
type Config struct {
	Enabled     bool
	Interval    time.Duration // gap between probe cycles
	Timeout     time.Duration // per-provider probe deadline
	Concurrency int           // max concurrent probes
	DegradedMS  int64         // latency above which an online provider is "degraded"
	// ProbeModels, when true, also calls ListModels each cycle to populate the
	// model count + a sample id. Off by default — it can cost an extra upstream
	// round-trip (and, on some gateways, quota) beyond the cheap Ping.
	ProbeModels bool
}

// Prober periodically refreshes the health Registry by pinging every enabled
// provider through the shared provider.Registry (so it reuses built clients).
type Prober struct {
	reg       *Registry
	repo      *airepo.ProviderRepo
	providers *provider.Registry
	cfg       Config
	log       *zap.Logger
}

func NewProber(reg *Registry, repo *airepo.ProviderRepo, providers *provider.Registry, cfg Config, log *zap.Logger) *Prober {
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = 6
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 5 * time.Minute
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Second
	}
	if log == nil {
		log = zap.NewNop()
	}
	return &Prober{reg: reg, repo: repo, providers: providers, cfg: cfg, log: log}
}

// Run drives probe cycles until ctx is cancelled. Designed for an errgroup.
func (p *Prober) Run(ctx context.Context) error {
	if !p.cfg.Enabled {
		<-ctx.Done()
		return ctx.Err()
	}
	p.cycle(ctx) // probe once at startup so the UI isn't blank for a full interval
	t := time.NewTicker(p.cfg.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			p.cycle(ctx)
		}
	}
}

// ProbeNow runs one cycle synchronously and returns the resulting snapshot.
func (p *Prober) ProbeNow(ctx context.Context) SnapshotPayload {
	p.cycle(ctx)
	return p.reg.Snapshot()
}

func (p *Prober) cycle(ctx context.Context) {
	rows, err := p.repo.List(ctx)
	if err != nil {
		p.log.Warn("ai health: list providers failed", zap.Error(err))
		return
	}
	pool, err := ants.NewPool(p.cfg.Concurrency)
	if err != nil {
		p.log.Warn("ai health: pool init failed", zap.Error(err))
		return
	}
	defer pool.Release()

	keep := make(map[uint64]struct{}, len(rows))
	var wg sync.WaitGroup
	for i := range rows {
		row := rows[i]
		keep[row.ID] = struct{}{}
		if !row.Enabled {
			continue
		}
		wg.Add(1)
		_ = pool.Submit(func() {
			defer wg.Done()
			p.reg.Set(p.probeOne(ctx, &row))
		})
	}
	wg.Wait()
	p.reg.Forget(keep)
}

func (p *Prober) probeOne(ctx context.Context, row *aimodel.AIProvider) Status {
	st := Status{ProviderID: row.ID, Name: displayName(row), Kind: string(row.Kind), CheckedAt: time.Now()}
	pctx, cancel := context.WithTimeout(ctx, p.cfg.Timeout)
	defer cancel()
	prov, err := p.providers.BuildFor(pctx, row)
	if err != nil {
		st.LastError = err.Error()
		return st
	}
	start := time.Now()
	if err := prov.Ping(pctx); err != nil {
		st.LatencyMS = time.Since(start).Milliseconds()
		st.LastError = err.Error()
		return st
	}
	st.LatencyMS = time.Since(start).Milliseconds()
	if p.cfg.ProbeModels {
		if models, err := prov.ListModels(pctx); err == nil {
			st.ModelCount = len(models)
			if len(models) > 0 {
				st.SampleModel = models[0].ID
			}
		}
	}
	return st
}

func displayName(row *aimodel.AIProvider) string {
	if row.DisplayName != "" {
		return row.DisplayName
	}
	return row.Name
}
