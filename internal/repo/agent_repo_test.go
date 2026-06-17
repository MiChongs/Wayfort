package repo

import (
	"context"
	"testing"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newAgentTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.GatewayAgent{}, &model.AgentEnrollToken{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

func TestEnrollToken_ConsumeIsSingleUse(t *testing.T) {
	db := newAgentTestDB(t)
	repo := NewAgentEnrollTokenRepo(db)
	ctx := context.Background()
	now := time.Now()

	tok := &model.AgentEnrollToken{
		DomainID:  7,
		TokenHash: "deadbeef",
		CreatedBy: 1,
		ExpiresAt: now.Add(15 * time.Minute),
	}
	if err := repo.Create(ctx, tok); err != nil {
		t.Fatalf("create token: %v", err)
	}

	// First consume succeeds and returns the row.
	got, err := repo.Consume(ctx, "deadbeef", now)
	if err != nil {
		t.Fatalf("first consume: %v", err)
	}
	if got == nil || got.DomainID != 7 {
		t.Fatalf("want domain 7 token, got %+v", got)
	}
	// Second consume of the same hash must fail (already burned).
	again, err := repo.Consume(ctx, "deadbeef", now)
	if err != nil {
		t.Fatalf("second consume: %v", err)
	}
	if again != nil {
		t.Fatalf("token must be single-use, got %+v on second consume", again)
	}
}

func TestEnrollToken_ExpiredRejected(t *testing.T) {
	db := newAgentTestDB(t)
	repo := NewAgentEnrollTokenRepo(db)
	ctx := context.Background()
	now := time.Now()

	if err := repo.Create(ctx, &model.AgentEnrollToken{
		DomainID: 1, TokenHash: "old", CreatedBy: 1, ExpiresAt: now.Add(-time.Minute),
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.Consume(ctx, "old", now)
	if err != nil {
		t.Fatalf("consume: %v", err)
	}
	if got != nil {
		t.Fatal("expired token must not be consumable")
	}
}

func TestGatewayAgent_LifecycleAndStaleReap(t *testing.T) {
	db := newAgentTestDB(t)
	repo := NewGatewayAgentRepo(db)
	ctx := context.Background()

	a := &model.GatewayAgent{DomainID: 3, Name: "edge-1", Status: model.AgentPending}
	if err := repo.Create(ctx, a); err != nil {
		t.Fatalf("create: %v", err)
	}
	if a.Schedulable() {
		t.Fatal("pending agent must not be schedulable")
	}

	// Activate → offline, then heartbeat → online.
	if err := repo.UpdateStatus(ctx, a.ID, model.AgentOffline); err != nil {
		t.Fatalf("activate: %v", err)
	}
	now := time.Now()
	if err := repo.Touch(ctx, a.ID, "gw-1", `{"streams":2}`, now); err != nil {
		t.Fatalf("touch: %v", err)
	}
	got, _ := repo.FindByID(ctx, a.ID)
	if got.Status != model.AgentOnline || got.LastGateway != "gw-1" {
		t.Fatalf("want online via gw-1, got %+v", got)
	}
	if !got.Schedulable() {
		t.Fatal("online agent must be schedulable")
	}

	// A heartbeat older than the cutoff flips it back to offline.
	n, err := repo.MarkOfflineStale(ctx, now.Add(time.Minute))
	if err != nil {
		t.Fatalf("reap: %v", err)
	}
	if n != 1 {
		t.Fatalf("want 1 agent reaped, got %d", n)
	}
	got, _ = repo.FindByID(ctx, a.ID)
	if got.Status != model.AgentOffline {
		t.Fatalf("want offline after reap, got %s", got.Status)
	}
}

func TestGatewayAgent_FindByFingerprint(t *testing.T) {
	db := newAgentTestDB(t)
	repo := NewGatewayAgentRepo(db)
	ctx := context.Background()

	if err := repo.Create(ctx, &model.GatewayAgent{
		DomainID: 1, Name: "a", Status: model.AgentOnline, Fingerprint: "fp-abc",
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, err := repo.FindByFingerprint(ctx, "fp-abc")
	if err != nil {
		t.Fatalf("find: %v", err)
	}
	if got == nil || got.Name != "a" {
		t.Fatalf("want agent a by fingerprint, got %+v", got)
	}
	miss, _ := repo.FindByFingerprint(ctx, "nope")
	if miss != nil {
		t.Fatal("unknown fingerprint must return nil")
	}
}
