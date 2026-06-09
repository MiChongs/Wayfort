// Package latency turns a stream of round-trip-time observations into accurate,
// cheap-to-query connection-quality statistics. It is the measurement core
// behind the session quality chart.
//
// Two mainstream libraries do the heavy lifting:
//   - HdrHistogram (github.com/HdrHistogram/hdrhistogram-go): a fixed-memory,
//     high-dynamic-range histogram that yields accurate p50/p95/p99/max over a
//     1µs–120s range without storing every sample. This is the industry-standard
//     way to report latency percentiles (used by wrk2, Cassandra, etc.).
//   - EWMA (github.com/VividCortex/ewma): an exponentially weighted moving
//     average for a stable "current" reading and for smoothing jitter, instead
//     of a noisy last-sample value.
//
// Jitter is the EWMA of the absolute change between consecutive RTTs (the same
// idea as RFC 3550 interarrival jitter). Loss is the fraction of probes that
// timed out. The tracker is safe for concurrent Observe/Snapshot.
package latency

import (
	"math"
	"sync"
	"time"

	hdr "github.com/HdrHistogram/hdrhistogram-go"
	"github.com/VividCortex/ewma"
)

// Tracker accumulates RTT observations for one measurement path (e.g. the
// client↔gateway WebSocket, or the gateway↔target SSH connection).
type Tracker struct {
	mu       sync.Mutex
	hist     *hdr.Histogram     // microseconds
	smoothed ewma.MovingAverage // EWMA of RTT (ms)
	jitter   ewma.MovingAverage // EWMA of |Δrtt| (ms)
	lastMs   float64
	havePrev bool
	peakUs   int64
	probes   uint64
	timeouts uint64
}

// New builds a tracker spanning 1µs–120s with 3 significant figures — ample for
// anything from a loopback hop to a satellite link, at a few KB of memory.
func New() *Tracker {
	return &Tracker{
		hist:     hdr.New(1, 120_000_000, 3),
		smoothed: ewma.NewMovingAverage(),
		jitter:   ewma.NewMovingAverage(),
	}
}

// Observe records one successful round trip.
func (t *Tracker) Observe(d time.Duration) {
	us := max(d.Microseconds(), 1) // sub-µs loopback still counts as a real probe
	ms := float64(us) / 1000.0
	t.mu.Lock()
	_ = t.hist.RecordValue(us)
	if us > t.peakUs {
		t.peakUs = us
	}
	t.smoothed.Add(ms)
	if t.havePrev {
		t.jitter.Add(math.Abs(ms - t.lastMs))
	}
	t.lastMs = ms
	t.havePrev = true
	t.probes++
	t.mu.Unlock()
}

// ObserveTimeout records a probe that never came back — feeds the loss rate.
func (t *Tracker) ObserveTimeout() {
	t.mu.Lock()
	t.timeouts++
	t.probes++
	t.mu.Unlock()
}

// Stats is an immutable snapshot of a path's quality. Durations are whole
// milliseconds (rounded up so a sub-ms hop is 1ms, never 0); LossPct is ×100
// (250 == 2.50%) to match SessionMetricSample.
type Stats struct {
	CurrentMs uint32 // EWMA-smoothed current RTT
	LastMs    uint32 // most recent raw sample
	P50Ms     uint32
	P95Ms     uint32
	P99Ms     uint32
	MaxMs     uint32
	JitterMs  uint32
	LossPct   uint16
	Probes    uint64
}

func usToMs(us int64) uint32 {
	if us <= 0 {
		return 0
	}
	return uint32((us + 999) / 1000)
}

func roundMs(ms float64) uint32 {
	if ms <= 0 {
		return 0
	}
	// Floor at 1: a measured round trip under 0.5ms is still a real, non-zero
	// latency — never report it as 0.
	if r := uint32(math.Round(ms)); r > 0 {
		return r
	}
	return 1
}

// Snapshot returns the current statistics. Cheap (no allocation beyond the
// returned value); safe to call from the metric sampler.
func (t *Tracker) Snapshot() Stats {
	t.mu.Lock()
	defer t.mu.Unlock()
	var loss uint16
	if t.probes > 0 {
		loss = uint16(t.timeouts * 10000 / t.probes)
	}
	return Stats{
		CurrentMs: roundMs(t.smoothed.Value()),
		LastMs:    roundMs(t.lastMs),
		P50Ms:     usToMs(t.hist.ValueAtQuantile(50)),
		P95Ms:     usToMs(t.hist.ValueAtQuantile(95)),
		P99Ms:     usToMs(t.hist.ValueAtQuantile(99)),
		MaxMs:     usToMs(t.peakUs),
		JitterMs:  roundMs(t.jitter.Value()),
		LossPct:   loss,
		Probes:    t.probes,
	}
}
