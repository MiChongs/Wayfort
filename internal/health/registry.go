// Package health probes proxy reachability in the background and serves the
// latest verdict to the failover dialer (via dialer.HealthReader) and the UI
// (via a JSON snapshot + SSE stream).
package health

import (
	"sync"
	"time"
)

// State is the coarse health bucket the UI renders as a colored dot.
type State string

const (
	StateOnline   State = "online"
	StateDegraded State = "degraded"
	StateDown     State = "down"
	StateUnknown  State = "unknown"
)

// Status is one proxy's latest probe verdict. The JSON shape is the per-proxy
// value the frontend consumes (keyed by proxy id in the snapshot map).
type Status struct {
	ProxyID         uint64    `json:"proxy_id"`
	Name            string    `json:"name"`
	Kind            string    `json:"kind"`
	Up              bool      `json:"up"`
	State           State     `json:"state"`
	LatencyMS       int64     `json:"latency_ms"`
	LastError       string    `json:"last_error,omitempty"`
	CheckedAt       time.Time `json:"checked_at"`
	ConsecutiveUp   int       `json:"consecutive_up"`
	ConsecutiveDown int       `json:"consecutive_down"`
}

// Registry is a thread-safe store of the latest Status per proxy. It implements
// dialer.HealthReader.
type Registry struct {
	mu         sync.RWMutex
	m          map[uint64]Status
	degradedMS int64
}

// NewRegistry builds a registry; degradedMS is the latency above which an "up"
// proxy is reported as degraded rather than online (0 → 800ms default).
func NewRegistry(degradedMS int64) *Registry {
	if degradedMS <= 0 {
		degradedMS = 800
	}
	return &Registry{m: map[uint64]Status{}, degradedMS: degradedMS}
}

// Set records a fresh probe result, folding in the consecutive up/down streak
// from the previous verdict and computing the coarse State.
func (r *Registry) Set(s Status) {
	r.mu.Lock()
	defer r.mu.Unlock()
	prev := r.m[s.ProxyID]
	if s.Up {
		s.ConsecutiveUp = prev.ConsecutiveUp + 1
		s.ConsecutiveDown = 0
		if s.LatencyMS > r.degradedMS {
			s.State = StateDegraded
		} else {
			s.State = StateOnline
		}
	} else {
		s.ConsecutiveDown = prev.ConsecutiveDown + 1
		s.ConsecutiveUp = 0
		s.State = StateDown
	}
	if s.CheckedAt.IsZero() {
		s.CheckedAt = time.Now()
	}
	r.m[s.ProxyID] = s
}

// Get returns the stored status for a proxy (zero Status if never probed).
func (r *Registry) Get(id uint64) Status {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.m[id]
}

// Forget drops proxies no longer in the catalog so the snapshot doesn't leak
// deleted ids. keep is the set of currently-known proxy ids.
func (r *Registry) Forget(keep map[uint64]struct{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id := range r.m {
		if _, ok := keep[id]; !ok {
			delete(r.m, id)
		}
	}
}

// --- dialer.HealthReader ---

func (r *Registry) IsUp(id uint64) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	s, ok := r.m[id]
	if !ok {
		return true // unknown → optimistic, so failover still tries it
	}
	return s.Up
}

func (r *Registry) LatencyMS(id uint64) int64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.m[id].LatencyMS
}

// SnapshotPayload is the SSE/JSON frame: proxies keyed by id + a sample stamp.
type SnapshotPayload struct {
	Proxies   map[uint64]Status `json:"proxies"`
	SampledAt time.Time         `json:"sampled_at"`
}

func (r *Registry) Snapshot() SnapshotPayload {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := SnapshotPayload{Proxies: make(map[uint64]Status, len(r.m)), SampledAt: time.Now()}
	for id, s := range r.m {
		out.Proxies[id] = s
	}
	return out
}
