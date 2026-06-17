package audit

import (
	"context"
	"testing"

	"github.com/michongs/wayfort/internal/config"
	"github.com/michongs/wayfort/internal/model"
	"go.uber.org/zap"
)

func TestLogCritical_EnqueuesSeparately(t *testing.T) {
	w := NewWriter(config.AuditConfig{}, nil, zap.NewNop())
	// With room, a critical event enqueues without blocking.
	if err := w.LogCritical(context.Background(), model.AuditLog{Kind: model.AuditConfigChange}); err != nil {
		t.Fatalf("critical enqueue should succeed: %v", err)
	}
	if len(w.critCh) != 1 {
		t.Fatalf("critical event must land on the dedicated channel, len=%d", len(w.critCh))
	}
	// It must NOT have touched the normal (droppable) channel.
	if len(w.ch) != 0 {
		t.Fatalf("critical event must not use the normal channel, len=%d", len(w.ch))
	}
}

func TestLogCritical_BlocksThenErrorsUnderBackpressure(t *testing.T) {
	w := NewWriter(config.AuditConfig{}, nil, zap.NewNop())
	// Fill the critical channel to capacity (no consumer running).
	for i := 0; i < cap(w.critCh); i++ {
		w.critCh <- model.AuditLog{Kind: model.AuditCommand}
	}
	// A further critical log must NOT silently drop — it blocks, and with an
	// already-cancelled context it returns an error so the caller can refuse the
	// operation rather than let it run unaudited.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := w.LogCritical(ctx, model.AuditLog{Kind: model.AuditCommand})
	if err == nil {
		t.Fatal("a full critical queue must return an error, never drop silently")
	}
}

func TestLog_NormalChannelStillDrops(t *testing.T) {
	// Sanity: the normal path keeps its non-blocking drop semantics, so a flood
	// on it can never block a caller (and thus can't be used to stall criticals).
	cfg := config.AuditConfig{ChanSize: 2}
	w := NewWriter(cfg, nil, zap.NewNop())
	for i := 0; i < 10; i++ {
		w.Log(model.AuditLog{Kind: model.AuditCommand})
	}
	if w.DroppedTotal() == 0 {
		t.Fatal("normal channel should have dropped under a flood")
	}
	// Even after a normal-channel flood, a critical event still gets through.
	if err := w.LogCritical(context.Background(), model.AuditLog{Kind: model.AuditConfigChange}); err != nil {
		t.Fatalf("critical must survive a normal-channel flood: %v", err)
	}
}
