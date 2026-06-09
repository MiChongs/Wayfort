package audit

import (
	"context"
	"sync/atomic"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"go.uber.org/zap"
)

// MetricWriter batches connection-quality samples to the DB through a single
// worker, mirroring Writer. Samples are non-critical telemetry, so on
// backpressure they are dropped and counted rather than blocking a session.
type MetricWriter struct {
	repo    *repo.SessionRepo
	logger  *zap.Logger
	ch      chan model.SessionMetricSample
	dropped atomic.Uint64
	done    chan struct{}

	chanSize  int
	batchSize int
	interval  time.Duration
	timeout   time.Duration
}

// NewMetricWriter builds the queue with sensible fixed defaults (no config
// plumbing — telemetry tuning is not operator-facing).
func NewMetricWriter(r *repo.SessionRepo, logger *zap.Logger) *MetricWriter {
	return &MetricWriter{
		repo:      r,
		logger:    logger,
		ch:        make(chan model.SessionMetricSample, 4096),
		done:      make(chan struct{}),
		chanSize:  4096,
		batchSize: 128,
		interval:  time.Second,
		timeout:   15 * time.Second,
	}
}

// Enqueue adds a sample. Non-blocking; drops + counts on backpressure.
func (w *MetricWriter) Enqueue(s model.SessionMetricSample) {
	if s.At.IsZero() {
		s.At = time.Now()
	}
	select {
	case w.ch <- s:
	default:
		w.dropped.Add(1)
	}
}

func (w *MetricWriter) Run(ctx context.Context) error {
	buf := make([]model.SessionMetricSample, 0, w.batchSize)
	t := time.NewTicker(w.interval)
	defer t.Stop()
	flush := func() {
		if len(buf) == 0 {
			return
		}
		fctx, cancel := context.WithTimeout(context.Background(), w.timeout)
		if err := w.repo.AppendMetrics(fctx, buf); err != nil {
			w.logger.Warn("metric batch insert failed", zap.Error(err), zap.Int("count", len(buf)))
		}
		cancel()
		buf = buf[:0]
	}
	for {
		select {
		case <-ctx.Done():
			for {
				select {
				case s := <-w.ch:
					buf = append(buf, s)
					if len(buf) >= w.batchSize {
						flush()
					}
				default:
					flush()
					close(w.done)
					return ctx.Err()
				}
			}
		case s := <-w.ch:
			buf = append(buf, s)
			if len(buf) >= w.batchSize {
				flush()
			}
		case <-t.C:
			flush()
			if d := w.dropped.Swap(0); d > 0 {
				w.logger.Warn("metric samples dropped", zap.Uint64("dropped", d))
			}
		}
	}
}

func (w *MetricWriter) Wait() { <-w.done }

// Sink returns a per-session sampler bound to this writer. A nil writer yields a
// nil sink whose methods are all safe no-ops, so callers needn't nil-check.
func (w *MetricWriter) Sink(sessionID string) *MetricSink {
	if w == nil {
		return nil
	}
	return &MetricSink{w: w, sessionID: sessionID}
}

// MetricSink accumulates one session's readings and emits a sample on a fixed
// cadence. RTT and reconnects are fed in as they happen; Run ticks and folds the
// byte totals into per-window deltas.
type MetricSink struct {
	w         *MetricWriter
	sessionID string

	lastRTT    atomic.Uint32 // most recent observed RTT (ms)
	peakRTT    atomic.Uint32
	reconnects atomic.Uint32 // reconnects accumulated since the last sample
	lastIn     uint64
	lastOut    uint64
}

// ObserveRTT records the most recent round-trip time (ms). Safe on a nil sink.
func (s *MetricSink) ObserveRTT(rttMs uint32) {
	if s == nil || rttMs == 0 {
		return
	}
	s.lastRTT.Store(rttMs)
	for {
		p := s.peakRTT.Load()
		if rttMs <= p || s.peakRTT.CompareAndSwap(p, rttMs) {
			break
		}
	}
}

// AddReconnect bumps the reconnect counter for the current window. Safe on nil.
func (s *MetricSink) AddReconnect() {
	if s == nil {
		return
	}
	s.reconnects.Add(1)
}

// Run samples every interval until ctx is cancelled. totals returns the
// session's running byte counters; the sink diffs them into per-window deltas.
// Spawns a single goroutine; caller runs it as `go sink.Run(...)`. Use either
// Run OR Sample for a given sink, never both (they share unsynchronised
// last-byte state — fine because each session drives exactly one of them).
func (s *MetricSink) Run(ctx context.Context, interval time.Duration, totals func() (in, out uint64)) {
	if s == nil {
		return
	}
	if interval <= 0 {
		interval = 5 * time.Second
	}
	s.lastIn, s.lastOut = totals()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			in, out := totals()
			s.emit(now, in, out)
		}
	}
}

// Sample emits one reading immediately from the supplied running totals — for
// callers (e.g. the tcpfwd janitor) that drive their own cadence instead of Run.
func (s *MetricSink) Sample(in, out uint64) {
	if s == nil {
		return
	}
	s.emit(time.Now(), in, out)
}

// emit diffs the running totals into per-window deltas and enqueues one sample.
func (s *MetricSink) emit(at time.Time, in, out uint64) {
	var dIn, dOut uint64
	if in >= s.lastIn {
		dIn = in - s.lastIn
	}
	if out >= s.lastOut {
		dOut = out - s.lastOut
	}
	s.lastIn, s.lastOut = in, out
	s.w.Enqueue(model.SessionMetricSample{
		SessionID:     s.sessionID,
		At:            at,
		RTTMs:         s.lastRTT.Load(),
		BytesInDelta:  dIn,
		BytesOutDelta: dOut,
		Reconnects:    s.reconnects.Swap(0),
	})
}
