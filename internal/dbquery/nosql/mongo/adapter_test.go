package mongo

import (
	"context"
	"errors"
	"testing"

	"github.com/michongs/wayfort/internal/dbquery/nosql"
)

// TestAdapterProtocol confirms the Registry key the front-end matches
// against node config.
func TestAdapterProtocol(t *testing.T) {
	a := New(nil)
	if got := a.Protocol(); got != "mongodb" {
		t.Fatalf("Protocol() = %q, want %q", got, "mongodb")
	}
}

// TestAdapterFamily confirms the UI-shell routing band.
func TestAdapterFamily(t *testing.T) {
	a := New(nil)
	if got := a.Family(); got != nosql.FamilyMongoDB {
		t.Fatalf("Family() = %q, want %q", got, nosql.FamilyMongoDB)
	}
}

// TestAdapterSatisfiesInterface wires a *Adapter through the nosql.Adapter
// interface to prove the compile-time contract holds at runtime too — the
// Registry in D1 stores values as nosql.Adapter, so a missing method would
// surface as a failed Register, not a build error.
func TestAdapterSatisfiesInterface(t *testing.T) {
	var ad nosql.Adapter = New(nil) //nolint:vardecl // interface assertion is the test
	if ad.Protocol() != "mongodb" {
		t.Fatalf("via interface: Protocol() = %q", ad.Protocol())
	}
}

// TestIsForbiddenPipeline exercises the default security policy: read-only
// stages pass, $out and $merge are rejected, and the guard scans the whole
// pipeline (not just the first stage).
func TestIsForbiddenPipeline(t *testing.T) {
	cases := []struct {
		name   string
		stages []map[string]any
		want   bool
	}{
		{"empty pipeline", nil, false},
		{"plain match", []map[string]any{{"$match": map[string]any{"x": 1}}}, false},
		{"group + sort", []map[string]any{
			{"$group": map[string]any{"_id": "$x"}},
			{"$sort": map[string]any{"_id": 1}},
		}, false},
		{"$out first stage", []map[string]any{{"$out": "leak"}}, true},
		{"$out after match", []map[string]any{
			{"$match": map[string]any{"x": 1}},
			{"$out": "leak"},
		}, true},
		{"$merge", []map[string]any{{"$merge": map[string]any{"into": "leak"}}}, true},
		{"$merge buried", []map[string]any{
			{"$match": map[string]any{"x": 1}},
			{"$sort": map[string]any{"x": 1}},
			{"$merge": map[string]any{"into": "leak"}},
		}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := IsForbiddenPipeline(c.stages); got != c.want {
				t.Fatalf("IsForbiddenPipeline(%v) = %v, want %v", c.stages, got, c.want)
			}
		})
	}
}

// TestAdapterNilClientNotConnected asserts every server-touching method on
// an adapter built with New(nil) returns errNotConnected rather than
// panicking. This is the nil-safety contract the gateway relies on when it
// constructs an adapter before the connection is dialled.
func TestAdapterNilClientNotConnected(t *testing.T) {
	a := New(nil)
	ctx := context.Background()

	if _, err := a.Info(ctx); !errors.Is(err, errNotConnected) {
		t.Fatalf("Info: err = %v, want errNotConnected", err)
	}
	if _, err := a.Databases(ctx); !errors.Is(err, errNotConnected) {
		t.Fatalf("Databases: err = %v, want errNotConnected", err)
	}
	if _, err := a.Collections(ctx, "db"); !errors.Is(err, errNotConnected) {
		t.Fatalf("Collections: err = %v, want errNotConnected", err)
	}
	if _, _, err := a.Documents(ctx, "db", "c", nil, nil, nil, 0, 0); !errors.Is(err, errNotConnected) {
		t.Fatalf("Documents: err = %v, want errNotConnected", err)
	}
	if _, err := a.FindOne(ctx, "db", "c", nil); !errors.Is(err, errNotConnected) {
		t.Fatalf("FindOne: err = %v, want errNotConnected", err)
	}
	if _, err := a.InsertOne(ctx, "db", "c", nil); !errors.Is(err, errNotConnected) {
		t.Fatalf("InsertOne: err = %v, want errNotConnected", err)
	}
	if _, err := a.UpdateOne(ctx, "db", "c", nil, nil); !errors.Is(err, errNotConnected) {
		t.Fatalf("UpdateOne: err = %v, want errNotConnected", err)
	}
	if _, err := a.DeleteOne(ctx, "db", "c", nil); !errors.Is(err, errNotConnected) {
		t.Fatalf("DeleteOne: err = %v, want errNotConnected", err)
	}
	if _, err := a.Aggregate(ctx, "db", "c", nil); !errors.Is(err, errNotConnected) {
		t.Fatalf("Aggregate: err = %v, want errNotConnected", err)
	}
	if _, err := a.Indexes(ctx, "db", "c"); !errors.Is(err, errNotConnected) {
		t.Fatalf("Indexes: err = %v, want errNotConnected", err)
	}
	if err := a.CreateIndex(ctx, "db", "c", map[string]any{"keys": map[string]any{"x": 1}}); !errors.Is(err, errNotConnected) {
		t.Fatalf("CreateIndex: err = %v, want errNotConnected", err)
	}
}

// TestAdapterNilReceiverNotConnected asserts the methods are safe when
// invoked on a nil *Adapter (e.g. a nil interface assertion). Guards the
// mustClient nil-receiver branch.
func TestAdapterNilReceiverNotConnected(t *testing.T) {
	var a *Adapter // typed nil, not New(nil)
	ctx := context.Background()

	if _, err := a.Info(ctx); !errors.Is(err, errNotConnected) {
		t.Fatalf("nil-receiver Info: err = %v, want errNotConnected", err)
	}
	if _, err := a.Databases(ctx); !errors.Is(err, errNotConnected) {
		t.Fatalf("nil-receiver Databases: err = %v, want errNotConnected", err)
	}
}

// TestAdapterNilReceiverProtocolStillWorks confirms the pure accessors do
// not consult the client and so remain callable on a typed-nil receiver.
func TestAdapterNilReceiverProtocolStillWorks(t *testing.T) {
	var a *Adapter
	if got := a.Protocol(); got != "mongodb" {
		t.Fatalf("nil-receiver Protocol() = %q, want mongodb", got)
	}
	if got := a.Family(); got != nosql.FamilyMongoDB {
		t.Fatalf("nil-receiver Family() = %q, want %q", got, nosql.FamilyMongoDB)
	}
}
