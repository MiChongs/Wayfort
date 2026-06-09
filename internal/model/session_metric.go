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
	// RTTMs is the primary round-trip time for this window: the gateway↔target
	// (server) RTT when measurable, else the client↔gateway RTT. Kept for
	// back-compat and as the headline series.
	RTTMs uint32 `json:"rtt_ms"`
	// ServerRTTMs is the gateway↔target SSH RTT (keepalive round-trip) — the
	// latency of the actual session path. 0 when not measured (telnet/anon/oss).
	ServerRTTMs uint32 `json:"server_rtt_ms"`
	// ClientRTTMs is the browser↔gateway WebSocket RTT (the operator's link).
	ClientRTTMs uint32 `json:"client_rtt_ms"`
	// JitterMs is the RTT variation (EWMA of |Δrtt|) — connection stability.
	JitterMs uint32 `json:"jitter_ms"`
	// LossPct is the probe-loss percentage ×100 (e.g. 250 == 2.50%).
	LossPct uint16 `json:"loss_pct"`
	// Byte deltas are the increment since the previous sample — handy for a
	// bandwidth curve without diffing the running totals on the Session row.
	BytesInDelta  uint64 `json:"bytes_in_delta"`
	BytesOutDelta uint64 `json:"bytes_out_delta"`
	// Reconnects is the count of reconnects observed within this window.
	Reconnects uint32 `json:"reconnects"`
}

func (SessionMetricSample) TableName() string { return "session_metric_samples" }
