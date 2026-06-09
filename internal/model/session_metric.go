package model

import "time"

// SessionMetricSample is one connection-quality reading. Samples are written on
// a fixed cadence (≈5s) by the per-session MetricSink so the session detail
// page can draw RTT / loss / bandwidth time-series and mark reconnects.
//
// Integer-only columns on purpose: LossPct is stored ×100 (0–10000) and all
// counters are unsigned ints, so there is no floating-point/decimal column to
// behave differently across sqlite / MySQL / Postgres.
type SessionMetricSample struct {
	ID        uint64    `gorm:"primaryKey" json:"id"`
	SessionID string    `gorm:"size:64;index:idx_metric_session_at,priority:1" json:"session_id"`
	At        time.Time `gorm:"index:idx_metric_session_at,priority:2" json:"at"`
	// RTTMs is the most recent round-trip time observed in this window.
	RTTMs uint32 `json:"rtt_ms"`
	// LossPct is the packet-loss percentage ×100 (e.g. 250 == 2.50%).
	LossPct uint16 `json:"loss_pct"`
	// Byte deltas are the increment since the previous sample — handy for a
	// bandwidth curve without diffing the running totals on the Session row.
	BytesInDelta  uint64 `json:"bytes_in_delta"`
	BytesOutDelta uint64 `json:"bytes_out_delta"`
	// Reconnects is the count of reconnects observed within this window.
	Reconnects uint32 `json:"reconnects"`
}

func (SessionMetricSample) TableName() string { return "session_metric_samples" }
