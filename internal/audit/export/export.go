// Package export fans audit events out to external SIEM/alerting sinks
// (security-architecture.md §10) — CEF over syslog, signed webhooks. It hangs
// off the audit writer's post-insert path: each sink has its own bounded queue,
// so a slow or full sink drops (and counts) rather than back-pressuring the main
// audit write or the session. It imports only model, so the audit writer can
// import it without a cycle.
package export

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/michongs/wayfort/internal/model"
	"go.uber.org/zap"
)

// Sink delivers one audit event to an external system. Implementations must be
// safe for the single goroutine that drives them (one per sink).
type Sink interface {
	Name() string
	Send(ctx context.Context, ev model.AuditLog) error
}

// sinkRunner owns a sink's bounded queue + delivery goroutine.
type sinkRunner struct {
	sink    Sink
	ch      chan model.AuditLog
	dropped atomic.Uint64
	logger  *zap.Logger
}

func (r *sinkRunner) enqueue(ev model.AuditLog) {
	select {
	case r.ch <- ev:
	default:
		r.dropped.Add(1)
	}
}

func (r *sinkRunner) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case ev := <-r.ch:
			sctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			if err := r.sink.Send(sctx, ev); err != nil {
				r.logger.Warn("audit sink send failed", zap.String("sink", r.sink.Name()), zap.Error(err))
			}
			cancel()
		}
	}
}

// Exporter fans events to every registered sink. Fan never blocks the caller.
type Exporter struct {
	runners []*sinkRunner
	logger  *zap.Logger
}

// NewExporter builds an exporter over the given sinks. queueSize bounds each
// sink's backlog (0 → 1024). Returns nil when there are no sinks so the writer
// can cheaply skip fan-out.
func NewExporter(sinks []Sink, queueSize int, logger *zap.Logger) *Exporter {
	if len(sinks) == 0 {
		return nil
	}
	if queueSize <= 0 {
		queueSize = 1024
	}
	runners := make([]*sinkRunner, 0, len(sinks))
	for _, s := range sinks {
		runners = append(runners, &sinkRunner{
			sink:   s,
			ch:     make(chan model.AuditLog, queueSize),
			logger: logger,
		})
	}
	return &Exporter{runners: runners, logger: logger}
}

// Fan enqueues a copy of each event to every sink's queue. Non-blocking: a full
// sink queue drops the event (and counts it) rather than stalling the audit
// writer. The events MUST already carry their chain_id/entry_hash so a SIEM can
// cross-verify against the internal integrity chain.
func (e *Exporter) Fan(events []model.AuditLog) {
	if e == nil {
		return
	}
	for i := range events {
		ev := events[i] // value copy — the writer reuses its buffer
		for _, r := range e.runners {
			r.enqueue(ev)
		}
	}
}

// Run drives every sink's delivery goroutine until ctx is cancelled.
func (e *Exporter) Run(ctx context.Context) error {
	if e == nil {
		return nil
	}
	done := make(chan struct{}, len(e.runners))
	for _, r := range e.runners {
		go func(r *sinkRunner) {
			r.run(ctx)
			done <- struct{}{}
		}(r)
	}
	<-ctx.Done()
	for range e.runners {
		<-done
	}
	return nil
}

// DroppedTotal sums the drop counts across all sinks (for /metrics).
func (e *Exporter) DroppedTotal() uint64 {
	if e == nil {
		return 0
	}
	var total uint64
	for _, r := range e.runners {
		total += r.dropped.Load()
	}
	return total
}
