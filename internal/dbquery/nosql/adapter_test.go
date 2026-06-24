package nosql

import (
	"context"
	"testing"
)

// TestRegistryEmptyByDefault asserts a freshly constructed Registry has
// no adapters registered. Guards against package-level init() side
// effects leaking into the global state used by tests.
func TestRegistryEmptyByDefault(t *testing.T) {
	r := NewRegistry()
	if got := len(r.List()); got != 0 {
		t.Fatalf("expected empty registry, got %d (%v)", got, r.List())
	}
}

// TestRegistryRegisterAndGet registers a fake adapter and confirms Get
// round-trips it back keyed by Protocol(), and that List surfaces the
// protocol id once registered.
func TestRegistryRegisterAndGet(t *testing.T) {
	r := NewRegistry()
	r.Register(&fakeAdapter{proto: "mongo", family: FamilyMongoDB})

	ad, ok := r.Get("mongo")
	if !ok {
		t.Fatalf("Get(mongo): not found; list=%v", r.List())
	}
	if ad.Protocol() != "mongo" {
		t.Fatalf("Protocol() = %q, want %q", ad.Protocol(), "mongo")
	}
	if ad.Family() != FamilyMongoDB {
		t.Fatalf("Family() = %q, want %q", ad.Family(), FamilyMongoDB)
	}

	if got := r.List(); len(got) != 1 || got[0] != "mongo" {
		t.Fatalf("List() = %v, want [mongo]", got)
	}
}

// TestRegistryGetMissing confirms an unknown protocol returns ok=false
// rather than a zero-value adapter.
func TestRegistryGetMissing(t *testing.T) {
	r := NewRegistry()
	if _, ok := r.Get("nope"); ok {
		t.Fatalf("Get(unknown) should miss")
	}
}

// TestRegistryOverwrite confirms re-registering the same protocol id
// replaces the prior adapter (hot-swap semantics, mirroring dbquery).
func TestRegistryOverwrite(t *testing.T) {
	r := NewRegistry()
	r.Register(&fakeAdapter{proto: "redis", family: FamilyRedis})
	r.Register(&fakeAdapter{proto: "redis", family: FamilyRedis})
	if got := len(r.List()); got != 1 {
		t.Fatalf("duplicate register should overwrite, got list=%v", r.List())
	}
}

// TestDefaultRegistryIsUsable confirms the package-level Default()
// singleton is non-nil and initially empty — engine init()s in D2/D3
// will populate it.
func TestDefaultRegistryIsUsable(t *testing.T) {
	if Default() == nil {
		t.Fatalf("Default() returned nil")
	}
}

// fakeAdapter is a complete, no-op Adapter used only by registry tests.
// Real engines (mongo, redis) ship in D2/D3.
type fakeAdapter struct {
	proto  string
	family Family
}

func (f *fakeAdapter) Protocol() string { return f.proto }
func (f *fakeAdapter) Family() Family   { return f.family }
func (f *fakeAdapter) Info(ctx context.Context) (Info, error) {
	return Info{}, nil
}
