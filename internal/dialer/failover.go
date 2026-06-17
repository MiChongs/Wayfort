package dialer

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sort"
	"sync/atomic"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"golang.org/x/net/proxy"
)

// HealthReader exposes the latest probe verdict for a proxy. It is the consumer
// interface the failover dialer reads; internal/health implements it. A nil
// HealthReader is treated as "everything healthy" so failover degrades to its
// configured static order when probing is disabled.
type HealthReader interface {
	IsUp(proxyID uint64) bool
	LatencyMS(proxyID uint64) int64
}

// GroupMemberSpec is one resolved member of a failover group: the member proxy
// row plus its ordering knobs. Returned by GroupReader so wrapGroup can compose
// each member over the shared upstream.
type GroupMemberSpec struct {
	Proxy    *model.Proxy
	Priority int
	Weight   int
}

// GroupReader resolves a failover group's members (joined to their proxy rows,
// any order). internal/repo implements it.
type GroupReader interface {
	MembersOf(ctx context.Context, groupID uint64) ([]GroupMemberSpec, error)
}

// builtMember is a member whose per-protocol dialer has already been composed
// over the group's shared upstream.
type builtMember struct {
	proxyID  uint64
	priority int
	weight   int
	dialer   proxy.ContextDialer
}

// failoverDialer dials through the first reachable member of a failover group,
// applying the group's strategy for ordering and a per-member retry/backoff.
type failoverDialer struct {
	groupID     uint64
	members     []builtMember
	strategy    model.FailoverStrategy
	retryMax    int
	backoffBase time.Duration
	backoffMax  time.Duration
	health      HealthReader
	metrics     MetricsSink
	rr          atomic.Uint64
}

var _ proxy.ContextDialer = (*failoverDialer)(nil)

func (f *failoverDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	order := f.order()
	start := time.Now()
	var lastErr error
	for i := range order {
		conn, err := f.tryMember(ctx, order[i], network, addr)
		if err == nil {
			if f.metrics != nil {
				f.metrics.OnDial(f.groupID, true, time.Since(start))
			}
			return conn, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			break
		}
	}
	if f.metrics != nil {
		f.metrics.OnDial(f.groupID, false, time.Since(start))
	}
	if lastErr == nil {
		lastErr = errors.New("no usable members")
	}
	return nil, fmt.Errorf("failover group %d exhausted: %w", f.groupID, lastErr)
}

// tryMember attempts one member with exponential backoff up to retryMax+1 tries.
func (f *failoverDialer) tryMember(ctx context.Context, m builtMember, network, addr string) (net.Conn, error) {
	attempts := f.retryMax + 1
	if attempts < 1 {
		attempts = 1
	}
	backoff := f.backoffBase
	if backoff <= 0 {
		backoff = 200 * time.Millisecond
	}
	var err error
	for i := 0; i < attempts; i++ {
		var conn net.Conn
		conn, err = m.dialer.DialContext(ctx, network, addr)
		if err == nil {
			return conn, nil
		}
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if i < attempts-1 {
			t := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				t.Stop()
				return nil, ctx.Err()
			case <-t.C:
			}
			backoff *= 2
			if f.backoffMax > 0 && backoff > f.backoffMax {
				backoff = f.backoffMax
			}
		}
	}
	return nil, err
}

// order returns members in the sequence to attempt them for this dial.
func (f *failoverDialer) order() []builtMember {
	ms := make([]builtMember, len(f.members))
	copy(ms, f.members)
	switch f.strategy {
	case model.FailoverRoundRobin:
		if n := len(ms); n > 1 {
			off := int(f.rr.Add(1)-1) % n
			ms = append(ms[off:], ms[:off]...)
		}
	case model.FailoverHealthWeighted:
		// Up members first; among them lowest latency, then heavier weight, then
		// lower priority. Down members keep their static order at the tail so we
		// still try them when nothing is known to be up.
		sort.SliceStable(ms, func(i, j int) bool {
			iu, ju := f.isUp(ms[i].proxyID), f.isUp(ms[j].proxyID)
			if iu != ju {
				return iu
			}
			li, lj := f.latency(ms[i].proxyID), f.latency(ms[j].proxyID)
			if li != lj {
				return li < lj
			}
			if ms[i].weight != ms[j].weight {
				return ms[i].weight > ms[j].weight
			}
			return ms[i].priority < ms[j].priority
		})
	default: // ordered
		sort.SliceStable(ms, func(i, j int) bool { return ms[i].priority < ms[j].priority })
	}
	return ms
}

func (f *failoverDialer) isUp(id uint64) bool {
	if f.health == nil {
		return true
	}
	return f.health.IsUp(id)
}

// latency returns the member's probe latency, mapping "unknown" to a large
// sentinel so measured members sort ahead of unmeasured ones.
func (f *failoverDialer) latency(id uint64) int64 {
	if f.health == nil {
		return 0
	}
	l := f.health.LatencyMS(id)
	if l <= 0 {
		return 1 << 62
	}
	return l
}
