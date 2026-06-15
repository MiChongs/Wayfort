package audit

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/audit/export"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"go.uber.org/zap"
)

// Writer batches audit events to the DB through a single worker so callers
// never block on disk I/O. Overflow drops command events first and counts
// drops; connection-level events always make it through if there is room.
type Writer struct {
	cfg          config.AuditConfig
	repo         *repo.AuditRepo
	logger       *zap.Logger
	ch           chan model.AuditLog
	critCh       chan model.AuditLog // high-sensitivity, blocking (never dropped)
	dropped      atomic.Uint64       // since last tick (for the periodic warn log)
	droppedTotal atomic.Uint64       // cumulative (sealed into checkpoints)
	done         chan struct{}
	// chain stamps each batch with the per-instance tamper-evidence hash chain.
	// Nil-safe: when unset, events are written unchained (pre-M4 behaviour).
	chain *Chainer

	// exporter fans inserted (and chained) events to external SIEM/webhook sinks
	// after a successful batch insert. Nil-safe; never blocks the write.
	exporter *export.Exporter
}

// SetExporter wires the external-audit fan-out (M6). Pass nil to disable.
func (w *Writer) SetExporter(e *export.Exporter) { w.exporter = e }

// SetChainer wires the tamper-evidence hash chain after construction. Pass nil
// to disable chaining. Must be called before Run.
func (w *Writer) SetChainer(c *Chainer) { w.chain = c }

func NewWriter(cfg config.AuditConfig, r *repo.AuditRepo, logger *zap.Logger) *Writer {
	if cfg.ChanSize <= 0 {
		cfg.ChanSize = 4096
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 64
	}
	if cfg.BatchInterval <= 0 {
		cfg.BatchInterval = 200 * time.Millisecond
	}
	if cfg.BatchTimeout <= 0 {
		cfg.BatchTimeout = 15 * time.Second
	}
	return &Writer{
		cfg:    cfg,
		repo:   r,
		logger: logger,
		ch:     make(chan model.AuditLog, cfg.ChanSize),
		critCh: make(chan model.AuditLog, 256),
		done:   make(chan struct{}),
	}
}

// LogCritical enqueues a high-sensitivity event (credential decrypt, approval
// decision, PKI / agent lifecycle) on a SEPARATE, blocking queue. Unlike Log it
// never silently drops: under backpressure it blocks the caller until there is
// room or the context/timeout fires, in which case it returns an error so the
// caller can REFUSE the operation rather than let it proceed unaudited
// (security-architecture.md §9). A command-flood that fills the normal queue
// cannot suppress these events — that is the whole point of the separate channel.
func (w *Writer) LogCritical(ctx context.Context, ev model.AuditLog) error {
	if ev.CreatedAt.IsZero() {
		ev.CreatedAt = time.Now()
	}
	select {
	case w.critCh <- ev:
		return nil
	default:
	}
	// Blocked: wait for room, bounded by ctx and a hard ceiling.
	t := time.NewTimer(10 * time.Second)
	defer t.Stop()
	select {
	case w.critCh <- ev:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return errCriticalAuditBackpressure
	}
}

var errCriticalAuditBackpressure = errorString("audit: critical event queue full — operation refused to avoid an unaudited action")

type errorString string

func (e errorString) Error() string { return string(e) }

// Log enqueues an event. It is non-blocking; on backpressure it drops the
// event and increments the drop counter (lower-priority events are dropped
// first by the caller deciding what to send).
func (w *Writer) Log(ev model.AuditLog) {
	if ev.CreatedAt.IsZero() {
		ev.CreatedAt = time.Now()
	}
	select {
	case w.ch <- ev:
	default:
		w.dropped.Add(1)
		w.droppedTotal.Add(1)
	}
}

// DroppedTotal returns the cumulative count of dropped events since startup —
// sealed into the signed checkpoints so a verifier sees how much (if anything)
// was shed under backpressure.
func (w *Writer) DroppedTotal() uint64 { return w.droppedTotal.Load() }

// ChainID returns the writer's tamper-evidence chain id (empty when unchained).
func (w *Writer) ChainID() string {
	if w.chain == nil {
		return ""
	}
	return w.chain.InstanceID()
}

func (w *Writer) Run(ctx context.Context) error {
	buf := make([]model.AuditLog, 0, w.cfg.BatchSize)
	t := time.NewTicker(w.cfg.BatchInterval)
	defer t.Stop()
	flush := func() {
		if len(buf) == 0 {
			return
		}
		// Stamp the tamper-evidence chain before insert; advance the chain tip
		// only on success so a dropped batch never breaks continuity.
		var commit func()
		if w.chain != nil {
			_, commit = w.chain.Stamp(buf)
		}
		fctx, cancel := context.WithTimeout(context.Background(), w.cfg.BatchTimeout)
		if err := w.repo.BatchInsert(fctx, buf); err != nil {
			w.logger.Warn("audit batch insert failed", zap.Error(err), zap.Int("count", len(buf)))
		} else {
			if commit != nil {
				commit()
			}
			// Fan the durably-inserted, chained events to external sinks. Never
			// blocks: a full sink queue drops + counts (M6).
			w.exporter.Fan(buf)
		}
		cancel()
		buf = buf[:0]
	}
	for {
		select {
		case <-ctx.Done():
			// Drain remaining events (critical first) best-effort, then exit.
			for {
				select {
				case ev := <-w.critCh:
					buf = append(buf, ev)
					if len(buf) >= w.cfg.BatchSize {
						flush()
					}
				case ev := <-w.ch:
					buf = append(buf, ev)
					if len(buf) >= w.cfg.BatchSize {
						flush()
					}
				default:
					flush()
					close(w.done)
					return ctx.Err()
				}
			}
		case ev := <-w.critCh:
			// High-sensitivity events are batched alongside normal ones but
			// reach here via a blocking enqueue, so a flood can't suppress them.
			buf = append(buf, ev)
			if len(buf) >= w.cfg.BatchSize {
				flush()
			}
		case ev := <-w.ch:
			buf = append(buf, ev)
			if len(buf) >= w.cfg.BatchSize {
				flush()
			}
		case <-t.C:
			flush()
			if d := w.dropped.Swap(0); d > 0 {
				w.logger.Warn("audit events dropped", zap.Uint64("dropped", d))
			}
		}
	}
}

func (w *Writer) Wait() { <-w.done }
