package dbquery

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/michongs/wayfort/internal/model"
)

// DatabaseScope describes how the engine partitions namespaces — does a
// connection bind to one *catalog* (PG: each database is isolated) or
// freely roams every *schema* (MySQL: information_schema is cluster-
// wide). Drives whether the UI's database-picker spawns a new pool on
// every change.
type DatabaseScope string

const (
	DatabaseScopeCatalog DatabaseScope = "catalog"
	DatabaseScopeSchema  DatabaseScope = "schema"
)

// Family is a coarse compatibility band. Adapter introspection /
// dialect / process-management code dispatches on family instead of
// per-engine NodeProtocol switches — TiDB / OceanBase ride the MySQL
// family; KingbaseES / Vastbase / openGauss ride the PG family;
// Dameng owns its own Oracle-flavoured family.
type Family string

const (
	FamilyMySQL    Family = "mysql"
	FamilyPostgres Family = "postgres"
	FamilyOracle   Family = "oracle" // Dameng (DM8) dialect
)

// Capabilities is the per-engine feature matrix the UI consumes. The
// front-end queries /api/v1/nodes/:id/db/capabilities once and toggles
// every relevant button accordingly (no EXPLAIN ANALYZE for engines
// that lack it, no KILL QUERY against engines that don't expose pids,
// etc.).
type Capabilities struct {
	ListDatabases  bool          `json:"list_databases"`
	Schemas        bool          `json:"schemas"`
	RowEdits       bool          `json:"row_edits"`
	Explain        bool          `json:"explain"`
	ExplainAnalyze bool          `json:"explain_analyze"`
	Processes      bool          `json:"processes"`
	KillProcess    bool          `json:"kill_process"`
	TableDDL       bool          `json:"table_ddl"`
	TableStats     bool          `json:"table_stats"`
	ForeignKeys    bool          `json:"foreign_keys"`
	Export         bool          `json:"export"`
	LastInsertID   bool          `json:"last_insert_id"`
	Sequences      bool          `json:"sequences"`
	Functions      bool          `json:"functions"`
	Transactions   bool          `json:"transactions"`
	DatabaseScope  DatabaseScope `json:"database_scope"`
	// VendorLabel is the Chinese-readable engine name shown in the UI
	// (e.g. "达梦 DM8"). Empty falls back to the protocol id.
	VendorLabel string `json:"vendor_label,omitempty"`
}

// Dialect groups every syntax-flavour decision the executor needs at
// runtime: identifier quoting, parameter placeholder shape, paged
// SELECT building.
type Dialect interface {
	QuoteIdent(string) string
	Placeholder(int) string
	BuildRowsSQL(schema, table, orderBy, orderDir string, limit, offset int) (string, error)
}

// Adapter is the per-engine plugin contract. Every adapter file owns
// one Adapter implementation + an init() that calls register(...).
// The gateway speaks to Adapters via the Registry; no consumer
// imports concrete engine types.
type Adapter interface {
	Protocol() model.NodeProtocol
	Family() Family
	Capabilities() Capabilities
	Dialect() Dialect
	Driver() Driver
}

// ----- Registry -------------------------------------------------------------

// Registry is the in-process plugin store. Adapter packages call
// register(adapter) from their init() functions. service.go looks up
// by protocol on every connection.
//
// Runtime mutation (Register / Unregister) is what makes the
// architecture hot-swappable — operators can replace a stub adapter
// for a vendor-licensed binary without a gateway restart.
type Registry struct {
	mu       sync.RWMutex
	adapters map[model.NodeProtocol]Adapter
}

// global is the package-level singleton init() functions populate.
// Tests can take a snapshot via Default().Snapshot() and restore.
var global = &Registry{adapters: map[model.NodeProtocol]Adapter{}}

// Default returns the process-wide adapter Registry.
func Default() *Registry { return global }

// NewRegistry produces an empty registry. Used by tests to isolate.
// Production code uses Default().
func NewRegistry(adapters ...Adapter) *Registry {
	r := &Registry{adapters: map[model.NodeProtocol]Adapter{}}
	for _, a := range adapters {
		r.Register(a)
	}
	return r
}

// DefaultRegistry is retained for backward compatibility with pre-
// Phase-22 callers; returns the global singleton.
func DefaultRegistry() *Registry { return global }

// Register inserts an adapter, replacing any prior entry for the same
// protocol id. Safe for concurrent use.
func (r *Registry) Register(adapter Adapter) {
	if r == nil || adapter == nil {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.adapters == nil {
		r.adapters = map[model.NodeProtocol]Adapter{}
	}
	r.adapters[adapter.Protocol()] = adapter
}

// Unregister removes the adapter for the given protocol. Returns
// whether one was actually evicted. Used by hot-swap flows.
func (r *Registry) Unregister(p model.NodeProtocol) bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.adapters[p]; !ok {
		return false
	}
	delete(r.adapters, p)
	return true
}

// Get returns the adapter for the supplied protocol id.
func (r *Registry) Get(protocol model.NodeProtocol) (Adapter, bool) {
	if r == nil {
		return nil, false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	a, ok := r.adapters[protocol]
	return a, ok
}

// List returns every registered protocol id, sorted lexicographically.
// Powers the /db/capabilities catalogue endpoint.
func (r *Registry) List() []model.NodeProtocol {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]model.NodeProtocol, 0, len(r.adapters))
	for p := range r.adapters {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return string(out[i]) < string(out[j]) })
	return out
}

// Snapshot returns a copy of the current adapter map. Tests use it to
// stash + restore around plugin-mutating cases.
func (r *Registry) Snapshot() map[model.NodeProtocol]Adapter {
	if r == nil {
		return nil
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make(map[model.NodeProtocol]Adapter, len(r.adapters))
	for k, v := range r.adapters {
		out[k] = v
	}
	return out
}

// register is the init-time helper every adapter file calls.
func register(adapter Adapter) { global.Register(adapter) }

// ----- dialect helper -------------------------------------------------------

// buildRowsSelectSQL is the dialect-aware paged SELECT builder.
// Adapters that don't override BuildRowsSQL delegate here.
func buildRowsSelectSQL(d Dialect, schema, table, orderBy, orderDir string, limit, offset int) (string, error) {
	if d == nil {
		return "", fmt.Errorf("dbquery: dialect not configured")
	}
	if limit < 0 || offset < 0 {
		return "", fmt.Errorf("dbquery: limit and offset must be non-negative")
	}
	orderDir = strings.ToUpper(strings.TrimSpace(orderDir))
	if orderDir != "" && orderDir != "ASC" && orderDir != "DESC" {
		return "", fmt.Errorf("dbquery: order direction must be ASC or DESC")
	}
	q := "SELECT * FROM " + d.QuoteIdent(schema) + "." + d.QuoteIdent(table)
	if orderBy != "" {
		q += " ORDER BY " + d.QuoteIdent(orderBy)
		if orderDir != "" {
			q += " " + orderDir
		}
	}
	q += fmt.Sprintf(" LIMIT %d OFFSET %d", limit, offset)
	return q, nil
}
