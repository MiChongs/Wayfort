// Package health probes AI provider reachability in the background and serves
// the latest verdict to the UI (a JSON snapshot + an SSE stream). It mirrors the
// proxy health subsystem (internal/health) but is keyed by provider id and adds
// model-count / sample-model probe detail plus passthrough rate-limit budget.
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
	StateOffline  State = "offline"
	StateUnknown  State = "unknown"
)

// Status is one provider's latest probe verdict (plus passthrough rate-limit
// budget the handler folds in at snapshot time). Keyed by provider id in the
// snapshot map the frontend consumes.
type Status struct {
	ProviderID      uint64    `json:"provider_id"`
	Name            string    `json:"name"`
	Kind            string    `json:"kind"`
	State           State     `json:"state"`
	LatencyMS       int64     `json:"latency_ms"`
	ModelCount      int       `json:"model_count,omitempty"`
	SampleModel     string    `json:"sample_model,omitempty"`
	LastError       string    `json:"last_error,omitempty"`
	CheckedAt       time.Time `json:"checked_at"`
	ConsecutiveUp   int       `json:"consecutive_up"`
	ConsecutiveDown int       `json:"consecutive_down"`
	// Rate-limit budget (folded in by the handler from the live limiter; omitted
	// when the provider has no configured ceiling).
	ReqLimit     int `json:"req_limit,omitempty"`
	ReqRemaining int `json:"req_remaining,omitempty"`
	TokLimit     int `json:"tok_limit,omitempty"`
	TokRemaining int `json:"tok_remaining,omitempty"`
}

// Registry is a thread-safe store of the latest Status per provider.
type Registry struct {
	mu         sync.RWMutex
	m          map[uint64]Status
	degradedMS int64
}

// NewRegistry builds a registry; degradedMS is the round-trip latency above
// which an online provider is reported degraded (0 → 1500ms default — LLM calls
// are slower than a TCP connect, so the threshold is higher than proxy health).
func NewRegistry(degradedMS int64) *Registry {
	if degradedMS <= 0 {
		degradedMS = 1500
	}
	return &Registry{m: map[uint64]Status{}, degradedMS: degradedMS}
}

// Set records a probe result. Success is encoded by an empty LastError; the
// coarse State folds in the consecutive up/down streak and the latency band.
func (r *Registry) Set(s Status) {
	r.mu.Lock()
	defer r.mu.Unlock()
	prev := r.m[s.ProviderID]
	if s.LastError == "" {
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
		s.State = StateOffline
	}
	if s.CheckedAt.IsZero() {
		s.CheckedAt = time.Now()
	}
	r.m[s.ProviderID] = s
}

// Get returns the stored status for a provider (zero Status if never probed).
func (r *Registry) Get(id uint64) Status {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.m[id]
}

// Forget drops providers no longer in the catalog so the snapshot doesn't leak
// deleted ids. keep is the set of currently-known provider ids.
func (r *Registry) Forget(keep map[uint64]struct{}) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id := range r.m {
		if _, ok := keep[id]; !ok {
			delete(r.m, id)
		}
	}
}

// SnapshotPayload is the SSE/JSON frame: providers keyed by id + a sample stamp.
type SnapshotPayload struct {
	Providers map[uint64]Status `json:"providers"`
	SampledAt time.Time         `json:"sampled_at"`
}

// Snapshot returns a fresh copy of every known status (safe for the caller to
// mutate, e.g. to fold in live rate-limit budget).
func (r *Registry) Snapshot() SnapshotPayload {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := SnapshotPayload{Providers: make(map[uint64]Status, len(r.m)), SampledAt: time.Now()}
	for id, s := range r.m {
		out.Providers[id] = s
	}
	return out
}
