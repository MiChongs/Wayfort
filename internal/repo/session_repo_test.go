package repo

import (
	"context"
	"testing"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func newSessionTestDB(t *testing.T) (*gorm.DB, *SessionRepo) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(&model.Session{}, &model.SessionPhase{}, &model.SessionMetricSample{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db, NewSessionRepo(db)
}

func TestSessionPhaseLifecycle(t *testing.T) {
	db, r := newSessionTestDB(t)
	ctx := context.Background()
	now := time.Now()

	if err := r.Create(ctx, &model.Session{ID: "s1", Kind: model.SessionInteractive, Username: "alice", StartedAt: now, Status: model.SessionActive}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	// Append dial → auth → ready, closing each before opening the next.
	mustAppend := func(phase model.SessionPhaseKind, at time.Time) {
		if err := r.AppendPhase(ctx, &model.SessionPhase{SessionID: "s1", Phase: phase, Status: model.PhaseRunning, StartedAt: at}); err != nil {
			t.Fatalf("append %s: %v", phase, err)
		}
	}
	mustAppend(model.PhaseDial, now)
	if err := r.ClosePhase(ctx, "s1", model.PhaseDial, model.PhaseSucceeded, "", now.Add(120*time.Millisecond)); err != nil {
		t.Fatalf("close dial: %v", err)
	}
	mustAppend(model.PhaseAuth, now.Add(120*time.Millisecond))
	if err := r.ClosePhase(ctx, "s1", model.PhaseAuth, model.PhaseSucceeded, "", now.Add(300*time.Millisecond)); err != nil {
		t.Fatalf("close auth: %v", err)
	}
	mustAppend(model.PhaseReady, now.Add(300*time.Millisecond))

	phases, err := r.Phases(ctx, "s1")
	if err != nil {
		t.Fatalf("phases: %v", err)
	}
	if len(phases) != 3 {
		t.Fatalf("phases = %d, want 3", len(phases))
	}
	// Seq must be monotonic 1,2,3 in dial/auth/ready order.
	for i, want := range []model.SessionPhaseKind{model.PhaseDial, model.PhaseAuth, model.PhaseReady} {
		if phases[i].Seq != uint32(i+1) {
			t.Fatalf("phase %d seq = %d, want %d", i, phases[i].Seq, i+1)
		}
		if phases[i].Phase != want {
			t.Fatalf("phase %d = %s, want %s", i, phases[i].Phase, want)
		}
	}
	// Closed phases carry duration; the still-running ready phase does not.
	if phases[0].DurationMs == nil || *phases[0].DurationMs != 120 {
		t.Fatalf("dial duration = %v, want 120", phases[0].DurationMs)
	}
	if phases[2].Status != model.PhaseRunning || phases[2].EndedAt != nil {
		t.Fatalf("ready should still be running: %+v", phases[2])
	}

	// ClosePhase on a phase with no running row is a no-op, not an error.
	if err := r.ClosePhase(ctx, "s1", model.PhaseHandshake, model.PhaseSucceeded, "", now); err != nil {
		t.Fatalf("close non-existent phase should be nil: %v", err)
	}

	// UpdateCurrentPhase / SetReadyAt patch only their columns.
	if err := r.UpdateCurrentPhase(ctx, "s1", model.PhaseReady); err != nil {
		t.Fatalf("update current phase: %v", err)
	}
	if err := r.SetReadyAt(ctx, "s1", now.Add(300*time.Millisecond)); err != nil {
		t.Fatalf("set ready_at: %v", err)
	}
	s, _ := r.FindByID(ctx, "s1")
	if s.CurrentPhase != model.PhaseReady || s.ReadyAt == nil {
		t.Fatalf("session rollups not patched: %+v", s)
	}
	_ = db
}

func TestSessionMetrics(t *testing.T) {
	_, r := newSessionTestDB(t)
	ctx := context.Background()
	base := time.Now()

	samples := []model.SessionMetricSample{
		{SessionID: "s1", At: base, RTTMs: 20, BytesInDelta: 100, BytesOutDelta: 50},
		{SessionID: "s1", At: base.Add(5 * time.Second), RTTMs: 60, BytesInDelta: 200, Reconnects: 1},
		{SessionID: "s1", At: base.Add(10 * time.Second), RTTMs: 40, BytesInDelta: 0},
		{SessionID: "other", At: base, RTTMs: 999},
	}
	if err := r.AppendMetrics(ctx, samples); err != nil {
		t.Fatalf("append metrics: %v", err)
	}

	got, err := r.Metrics(ctx, "s1", nil, nil, 0)
	if err != nil {
		t.Fatalf("metrics: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("metrics for s1 = %d, want 3 (other session excluded)", len(got))
	}
	// Oldest-first ordering.
	if !got[0].At.Before(got[1].At) {
		t.Fatalf("metrics not oldest-first")
	}

	// Time-window filter.
	from := base.Add(4 * time.Second)
	windowed, err := r.Metrics(ctx, "s1", &from, nil, 0)
	if err != nil {
		t.Fatalf("windowed metrics: %v", err)
	}
	if len(windowed) != 2 {
		t.Fatalf("windowed = %d, want 2", len(windowed))
	}

	// Summary: peak=60, avg over non-zero RTT = (20+60+40)/3 = 40, reconnects=1.
	peak, avg, reconnects, err := r.MetricSummary(ctx, "s1")
	if err != nil {
		t.Fatalf("summary: %v", err)
	}
	if peak != 60 || avg != 40 || reconnects != 1 {
		t.Fatalf("summary peak=%d avg=%d reconnects=%d, want 60/40/1", peak, avg, reconnects)
	}

	// AppendMetrics on empty slice is a no-op.
	if err := r.AppendMetrics(ctx, nil); err != nil {
		t.Fatalf("empty append: %v", err)
	}
}
