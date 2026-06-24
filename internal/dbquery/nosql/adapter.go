// Package nosql defines the contract for non-relational database
// adapters in Db Studio. It is the NoSQL sibling of internal/dbquery:
// where dbquery handles SQL engines (MySQL/PostgreSQL/Dameng & their
// wire-compatible cousins), nosql handles document stores (MongoDB) and
// KV stores (Redis).
//
// Each engine is owned by a leaf sub-package (mongo, redis) that
// registers a concrete Adapter from its init(). The gateway speaks to
// adapters exclusively through the package-level Default() Registry;
// no consumer imports a concrete engine type.
//
// Phase 3D Task D1 lands only this interface + the Registry. Engine
// implementations arrive in D2 (mongo) and D3 (redis); HTTP handlers
// arrive in D4.
package nosql

import (
	"context"
	"sort"
	"sync"
)

// Family is the coarse compatibility band: document store vs KV store.
// The front-end routes to a different shell per family because the two
// have no shared data model (collections of documents vs flat keys).
type Family string

const (
	// FamilyMongoDB covers document stores. Today only MongoDB; future
	// document engines (e.g. CouchDB) would ride the same family.
	FamilyMongoDB Family = "document"
	// FamilyRedis covers flat key-value stores. Today only Redis.
	FamilyRedis Family = "kv"
)

// Info reports server-side metadata shown in the connection panel.
// ServerStatus carries engine-specific extras as an opaque any so each
// adapter can surface its own gauge set without bloating this struct.
type Info struct {
	Version       string `json:"version"`
	Uptime        int64  `json:"uptime_seconds"`
	StorageEngine string `json:"storage_engine"`
	ServerStatus  any    `json:"server_status,omitempty"`
}

// Adapter is the per-engine NoSQL plugin contract. Two implementations
// ship in Phase 3D: mongo.Adapter and redis.Adapter. Methods beyond
// Protocol/Family/Info (document & key CRUD, index management) are
// added by the engine leaf packages as their handlers in D4 require
// them; this file deliberately defines only the contract the Registry
// and the capabilities catalogue need today, so D2/D3 pin the exact
// signatures their drivers support rather than inheriting guesses.
type Adapter interface {
	// Protocol returns the model.NodeProtocol string this adapter
	// serves (e.g. "mongodb", "redis"). Keys the Registry.
	Protocol() string
	// Family returns the compatibility band; drives UI shell routing.
	Family() Family
	// Info reports version / uptime / storage-engine for the panel.
	Info(ctx context.Context) (Info, error)
}

// Registry is the in-process plugin store, mirroring dbquery.Registry.
// Engine sub-packages call Register from their init(); service code
// looks up by protocol on every connection. Runtime mutation makes the
// architecture hot-swappable without a gateway restart.
type Registry struct {
	mu       sync.RWMutex
	adapters map[string]Adapter
}

// global is the package-level singleton init() functions populate.
var global = &Registry{adapters: map[string]Adapter{}}

// Default returns the process-wide adapter Registry.
func Default() *Registry { return global }

// NewRegistry produces an empty registry, optionally seeded with the
// supplied adapters. Used by tests to isolate from the global state
// that production init()s mutate.
func NewRegistry(adapters ...Adapter) *Registry {
	r := &Registry{adapters: map[string]Adapter{}}
	for _, a := range adapters {
		r.Register(a)
	}
	return r
}

// Register inserts an adapter, replacing any prior entry for the same
// protocol id. Safe for concurrent use.
func (r *Registry) Register(a Adapter) {
	if r == nil || a == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.adapters == nil {
		r.adapters = map[string]Adapter{}
	}
	r.adapters[a.Protocol()] = a
}

// Get returns the adapter for the supplied protocol id.
func (r *Registry) Get(protocol string) (Adapter, bool) {
	if r == nil {
		return nil, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.adapters[protocol]
	return a, ok
}

// List returns every registered protocol id, sorted lexicographically.
// Powers the NoSQL capabilities catalogue endpoint.
func (r *Registry) List() []string {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]string, 0, len(r.adapters))
	for p := range r.adapters {
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}
