package audit

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/config"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"go.uber.org/zap"
)

// Writer batches audit events to the DB through a single worker so callers
// never block on disk I/O. Overflow drops command events first and counts
// drops; connection-level events always make it through if there is room.
type Writer struct {
	cfg     config.AuditConfig
	repo    *repo.AuditRepo
	logger  *zap.Logger
	ch      chan model.AuditLog
	dropped atomic.Uint64
	done    chan struct{}
}

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
	return &Writer{
		cfg:    cfg,
		repo:   r,
		logger: logger,
		ch:     make(chan model.AuditLog, cfg.ChanSize),
		done:   make(chan struct{}),
	}
}

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
	}
}

func (w *Writer) Run(ctx context.Context) error {
	buf := make([]model.AuditLog, 0, w.cfg.BatchSize)
	t := time.NewTicker(w.cfg.BatchInterval)
	defer t.Stop()
	flush := func() {
		if len(buf) == 0 {
			return
		}
		fctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		if err := w.repo.BatchInsert(fctx, buf); err != nil {
			w.logger.Warn("audit batch insert failed", zap.Error(err), zap.Int("count", len(buf)))
		}
		cancel()
		buf = buf[:0]
	}
	for {
		select {
		case <-ctx.Done():
			// Drain remaining events best-effort, then exit.
			for {
				select {
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
