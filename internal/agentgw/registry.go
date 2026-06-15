package agentgw

import (
	"context"
	"errors"
	"net"
	"sync"
)

// ErrNoAgent is returned when a domain has no connected agent to dial through.
var ErrNoAgent = errors.New("agentgw: no connected agent for domain")

// Registry tracks the live agent tunnels owned by THIS gateway instance and
// routes a domain's dials to one of its connected agents. It is the in-memory
// counterpart to the gateway_agents table: the table is the durable roster, the
// registry is who is actually connected here right now.
//
// In an HA deployment each gateway instance has its own Registry holding only
// the agents whose tunnels landed on it; cross-instance routing (an instance
// dialing through an agent connected elsewhere) is a later step — for now the
// LB pins an agent's tunnel and the sessions it serves to the same instance.
type Registry struct {
	mu       sync.RWMutex
	byAgent  map[uint64]*Tunnel            // agentID -> tunnel
	byDomain map[uint64]map[uint64]*Tunnel // domainID -> set of tunnels
}

func NewRegistry() *Registry {
	return &Registry{
		byAgent:  make(map[uint64]*Tunnel),
		byDomain: make(map[uint64]map[uint64]*Tunnel),
	}
}

// Register adds a freshly-connected agent tunnel. If the same agent reconnects,
// the previous tunnel is closed and replaced.
func (r *Registry) Register(t *Tunnel) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if prev, ok := r.byAgent[t.AgentID]; ok && prev != t {
		_ = prev.Close()
		if set := r.byDomain[prev.DomainID]; set != nil {
			delete(set, prev.AgentID)
		}
	}
	r.byAgent[t.AgentID] = t
	set := r.byDomain[t.DomainID]
	if set == nil {
		set = make(map[uint64]*Tunnel)
		r.byDomain[t.DomainID] = set
	}
	set[t.AgentID] = t
}

// Unregister removes an agent (e.g. on disconnect) without closing it — the
// caller owns teardown. Safe to call for an unknown agent.
func (r *Registry) Unregister(agentID uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	t, ok := r.byAgent[agentID]
	if !ok {
		return
	}
	delete(r.byAgent, agentID)
	if set := r.byDomain[t.DomainID]; set != nil {
		delete(set, agentID)
		if len(set) == 0 {
			delete(r.byDomain, t.DomainID)
		}
	}
}

// Count returns the number of agents currently connected to this gateway — for
// the /metrics exporter.
func (r *Registry) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.byAgent)
}

// Has reports whether an agent is currently connected to this gateway.
func (r *Registry) Has(agentID uint64) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	_, ok := r.byAgent[agentID]
	return ok
}

// Disconnect forcibly tears down an agent's tunnel (and all its streams) and
// removes it from the registry — used when an admin revokes the agent. Returns
// whether a live tunnel was found. The tunnel's Wait() in the WSS handler
// unblocks as a result, so the handler's own cleanup also runs.
func (r *Registry) Disconnect(agentID uint64) bool {
	r.mu.Lock()
	t, ok := r.byAgent[agentID]
	if ok {
		delete(r.byAgent, agentID)
		if set := r.byDomain[t.DomainID]; set != nil {
			delete(set, agentID)
			if len(set) == 0 {
				delete(r.byDomain, t.DomainID)
			}
		}
	}
	r.mu.Unlock()
	if ok {
		_ = t.Close()
	}
	return ok
}

// AgentsInDomain returns the ids of agents connected for a domain (for status).
func (r *Registry) AgentsInDomain(domainID uint64) []uint64 {
	r.mu.RLock()
	defer r.mu.RUnlock()
	set := r.byDomain[domainID]
	out := make([]uint64, 0, len(set))
	for id := range set {
		out = append(out, id)
	}
	return out
}

// pick selects the least-loaded live tunnel in a domain (fewest active streams),
// skipping any whose session has gone away. Returns nil if none usable.
func (r *Registry) pick(domainID uint64) *Tunnel {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var best *Tunnel
	bestLoad := int(^uint(0) >> 1) // max int
	for _, t := range r.byDomain[domainID] {
		if t.IsClosed() {
			continue
		}
		if n := t.NumStreams(); n < bestLoad {
			best, bestLoad = t, n
		}
	}
	return best
}

// Dial routes a connection for an agent-domain node through the least-loaded
// connected agent in that domain, returning a net.Conn bound to addr (dialed on
// the agent side). requestID ties the stream to a session for auditing.
//
// addr MUST be the node's own host:port (the caller derives it from the node
// being connected), which is how target-in-domain membership is guaranteed — an
// agent never dials an address the gateway didn't resolve from a domain asset.
func (r *Registry) Dial(ctx context.Context, domainID uint64, requestID, network, addr string) (net.Conn, error) {
	t := r.pick(domainID)
	if t == nil {
		return nil, ErrNoAgent
	}
	return t.DialTarget(ctx, requestID, network, addr)
}
