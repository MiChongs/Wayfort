package dbquery

import (
	"maps"
	"sync"

	"github.com/michongs/wayfort/internal/model"
)

// NativeDriverRegistry holds vendor-native database/sql Driver impls,
// keyed by NodeProtocol. Population happens at init-time from build-
// tagged files under internal/dbquery/native/<vendor>/ (operator opts
// in by passing `-tags <vendor>_driver` to `go build`).
//
// Each adapter's Driver() consults this registry FIRST. When a native
// driver is registered, the adapter delegates to it — that means
// vendor-specific protocol extensions (Dameng's Oracle wire,
// openGauss's SHA-256 / SM3 password auth, Kingbase's row-level
// security probes) all flow through the real driver, not a generic
// wire-protocol cousin.
//
// When no native is registered, the adapter falls back to the family-
// canonical wire driver: pgx for PG-family, go-sql-driver/mysql for
// MySQL-family. This keeps the default build working on every
// environment that can reach the standard Go module proxy, while
// operators with stricter compliance (or vendor-mandated commercial
// drivers) can swap in the real article without touching the rest
// of dbquery.
//
// Thread-safe: Register is intended for init() only, but the lock
// covers concurrent reads from getOrOpen() in the unlikely case
// someone wires a hot-swap path later.
type nativeDriverRegistry struct {
	mu      sync.RWMutex
	drivers map[model.NodeProtocol]Driver
	// labels carries the human-readable vendor tag a native registration
	// surfaces back to Capabilities.VendorLabel — e.g. registering DM
	// flips the label from "达梦 DM8 (wire-compat 占位)" to
	// "达梦 DM8 (官方 gitee.com/chunanyong/dm)". This is purely
	// observational; behaviour switches because the Driver instance
	// changes, not because the label does.
	labels map[model.NodeProtocol]string
}

var nativeReg = &nativeDriverRegistry{
	drivers: map[model.NodeProtocol]Driver{},
	labels:  map[model.NodeProtocol]string{},
}

// RegisterNativeDriver wires `d` as the native driver for `protocol`.
// Intended for build-tagged init() functions in internal/dbquery/native/
// subpackages. Calling twice overrides — the last writer wins, which
// matches Go's late-binding for side-effect imports.
//
// label is an optional human-readable annotation (returned via
// LookupNativeLabel) so the Capabilities surface can distinguish a
// vendor-native binding from a wire-compat fallback.
func RegisterNativeDriver(protocol model.NodeProtocol, d Driver, label string) {
	nativeReg.mu.Lock()
	defer nativeReg.mu.Unlock()
	nativeReg.drivers[protocol] = d
	if label != "" {
		nativeReg.labels[protocol] = label
	}
}

// UnregisterNativeDriver is the symmetric tear-down — useful in tests
// and for the rare hot-swap operator workflow where a faulty native
// driver needs to be evicted without restarting the server. The
// adapter immediately falls back to its wire-compat driver on the
// next Open.
func UnregisterNativeDriver(protocol model.NodeProtocol) {
	nativeReg.mu.Lock()
	defer nativeReg.mu.Unlock()
	delete(nativeReg.drivers, protocol)
	delete(nativeReg.labels, protocol)
}

// LookupNativeDriver returns the registered native driver and `true`
// if one exists; otherwise (nil, false). Adapters use this to decide
// whether to route through the vendor binding or fall back.
func LookupNativeDriver(protocol model.NodeProtocol) (Driver, bool) {
	nativeReg.mu.RLock()
	defer nativeReg.mu.RUnlock()
	d, ok := nativeReg.drivers[protocol]
	return d, ok
}

// LookupNativeLabel returns the operator-supplied vendor label for a
// registered native driver, or "" if no native is registered. The
// caller (Capabilities) appends this to VendorLabel so the DB Studio
// header chip can visibly distinguish "wire-compat" from "official
// native driver loaded".
func LookupNativeLabel(protocol model.NodeProtocol) string {
	nativeReg.mu.RLock()
	defer nativeReg.mu.RUnlock()
	return nativeReg.labels[protocol]
}

// ListNativeBindings snapshots every (protocol, label) pair currently
// registered. Used by the /db/engines endpoint to advertise to the
// frontend which adapters have a vendor-native binding loaded versus
// running through wire-compat fallbacks.
func ListNativeBindings() map[model.NodeProtocol]string {
	nativeReg.mu.RLock()
	defer nativeReg.mu.RUnlock()
	out := make(map[model.NodeProtocol]string, len(nativeReg.labels))
	maps.Copy(out, nativeReg.labels)
	return out
}
