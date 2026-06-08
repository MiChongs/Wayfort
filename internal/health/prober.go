package health

import (
	"context"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/panjf2000/ants/v2"
	"go.uber.org/zap"
)

// Config tunes the background prober.
type Config struct {
	Enabled     bool
	Interval    time.Duration // gap between probe cycles
	Timeout     time.Duration // per-proxy probe deadline
	Concurrency int           // max concurrent probes
	DegradedMS  int64         // latency above which an up proxy is "degraded"
	// ProbeTarget, when set, switches probing from L4 reachability (TCP-connect
	// the proxy's own endpoint) to end-to-end: dial this host:port THROUGH each
	// proxy, exercising the full handshake (and credentials). Empty is the safe
	// default — no tunnel traffic leaves the proxy.
	ProbeTarget string
}

// ProxyLister enumerates the proxy catalog. internal/repo.ProxyRepo satisfies it.
type ProxyLister interface {
	List(ctx context.Context) ([]model.Proxy, error)
}

// Prober periodically refreshes the health Registry.
type Prober struct {
	reg     *Registry
	proxies ProxyLister
	builder *dialer.ChainBuilder
	groups  dialer.GroupReader
	cfg     Config
	log     *zap.Logger
}

func NewProber(reg *Registry, proxies ProxyLister, builder *dialer.ChainBuilder, groups dialer.GroupReader, cfg Config, log *zap.Logger) *Prober {
	if cfg.Concurrency <= 0 {
		cfg.Concurrency = 8
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 30 * time.Second
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Second
	}
	if log == nil {
		log = zap.NewNop()
	}
	return &Prober{reg: reg, proxies: proxies, builder: builder, groups: groups, cfg: cfg, log: log}
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
	proxies, err := p.proxies.List(ctx)
	if err != nil {
		p.log.Warn("health: list proxies failed", zap.Error(err))
		return
	}
	pool, err := ants.NewPool(p.cfg.Concurrency)
	if err != nil {
		p.log.Warn("health: pool init failed", zap.Error(err))
		return
	}
	defer pool.Release()

	keep := make(map[uint64]struct{}, len(proxies))
	var groups []model.Proxy
	var wg sync.WaitGroup
	for i := range proxies {
		pr := proxies[i]
		keep[pr.ID] = struct{}{}
		if pr.Disabled {
			continue
		}
		if pr.Kind == model.ProxyFailover {
			groups = append(groups, pr) // derived after members are probed
			continue
		}
		wg.Add(1)
		_ = pool.Submit(func() {
			defer wg.Done()
			p.reg.Set(p.probeOne(ctx, &pr))
		})
	}
	wg.Wait()
	// Derive group health from already-probed members.
	for i := range groups {
		p.reg.Set(p.deriveGroup(ctx, &groups[i]))
	}
	p.reg.Forget(keep)
}

func (p *Prober) probeOne(ctx context.Context, pr *model.Proxy) Status {
	st := Status{ProxyID: pr.ID, Name: pr.Name, Kind: string(pr.Kind), CheckedAt: time.Now()}
	if pr.Kind == model.ProxyDirect {
		st.Up = true // a direct hop is a no-op; nothing to reach
		return st
	}
	pctx, cancel := context.WithTimeout(ctx, p.cfg.Timeout)
	defer cancel()
	start := time.Now()
	var err error
	if p.cfg.ProbeTarget != "" {
		// End-to-end: dial the canary through this proxy.
		d, release, berr := p.builder.Build(pctx, []*model.Proxy{pr}, nil)
		if berr != nil {
			err = berr
		} else {
			conn, derr := d.DialContext(pctx, "tcp", p.cfg.ProbeTarget)
			if conn != nil {
				_ = conn.Close()
			}
			err = derr
			release()
		}
	} else if endpoint := endpointOf(pr); endpoint != "" {
		// L4 reachability: is the proxy's own port open?
		var nd net.Dialer
		conn, derr := nd.DialContext(pctx, "tcp", endpoint)
		if conn != nil {
			_ = conn.Close()
		}
		err = derr
	} else {
		err = fmt.Errorf("proxy has no endpoint to probe")
	}
	st.LatencyMS = time.Since(start).Milliseconds()
	if err != nil {
		st.Up = false
		st.LastError = err.Error()
	} else {
		st.Up = true
	}
	return st
}

// deriveGroup aggregates a failover group's health from its members: up when any
// member is up, latency = the best (lowest) up-member latency.
func (p *Prober) deriveGroup(ctx context.Context, g *model.Proxy) Status {
	st := Status{ProxyID: g.ID, Name: g.Name, Kind: string(g.Kind), CheckedAt: time.Now()}
	if p.groups == nil {
		st.Up = false
		st.LastError = "group reader unavailable"
		return st
	}
	members, err := p.groups.MembersOf(ctx, g.ID)
	if err != nil {
		st.Up = false
		st.LastError = err.Error()
		return st
	}
	best := int64(-1)
	for _, m := range members {
		if m.Proxy == nil {
			continue
		}
		ms := p.reg.Get(m.Proxy.ID)
		if ms.Up {
			st.Up = true
			if best < 0 || (ms.LatencyMS > 0 && ms.LatencyMS < best) {
				best = ms.LatencyMS
			}
		}
	}
	if st.Up {
		if best > 0 {
			st.LatencyMS = best
		}
	} else {
		st.LastError = "no member online"
	}
	return st
}

func endpointOf(p *model.Proxy) string {
	if p == nil || strings.TrimSpace(p.Host) == "" || p.Port <= 0 {
		return ""
	}
	return fmt.Sprintf("%s:%d", p.Host, p.Port)
}
