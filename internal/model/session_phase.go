package model

import "time"

// SessionPhaseKind labels one stage of a connection's lifecycle. A single
// session emits an ordered chain of phases (dial → auth → handshake → ready →
// … → closed) so the audit UI can show where time went and where a failed
// connection broke down, instead of collapsing everything into start/end.
type SessionPhaseKind string

const (
	PhaseDial      SessionPhaseKind = "dial"      // establish TCP / walk the proxy chain
	PhaseAuth      SessionPhaseKind = "auth"      // credential authentication
	PhaseHandshake SessionPhaseKind = "handshake" // protocol negotiation (SSH/RDP/guac/DB)
	PhaseReady     SessionPhaseKind = "ready"     // session usable, interactive loop running
	PhaseReconnect SessionPhaseKind = "reconnect" // a reconnect attempt
	PhaseClosed    SessionPhaseKind = "closed"    // teardown
)

// PhaseStatus is the outcome of a phase. A phase is created `running` and
// transitions to succeeded/failed when it ends.
type PhaseStatus string

const (
	PhaseRunning   PhaseStatus = "running"
	PhaseSucceeded PhaseStatus = "succeeded"
	PhaseFailed    PhaseStatus = "failed"
)

// SessionPhase is one stage record. Rows for a session are ordered by Seq
// (monotonic, assigned MAX(seq)+1 at append) so the timeline is stable even
// when two phases share a timestamp. DurationMs is backfilled at ClosePhase so
// the UI never has to diff timestamps row-by-row.
type SessionPhase struct {
	ID         uint64           `gorm:"primaryKey" json:"id"`
	SessionID  string           `gorm:"size:64;index:idx_phase_session_seq,priority:1" json:"session_id"`
	Seq        uint32           `gorm:"index:idx_phase_session_seq,priority:2" json:"seq"`
	Phase      SessionPhaseKind `gorm:"size:24" json:"phase"`
	Status     PhaseStatus      `gorm:"size:16" json:"status"`
	StartedAt  time.Time        `json:"started_at"`
	EndedAt    *time.Time       `json:"ended_at,omitempty"`
	DurationMs *int64           `json:"duration_ms,omitempty"`
	// Detail carries a short summary: failure reason, proxy hop count, or a
	// negotiated-parameter digest. Capped so it never holds large blobs.
	Detail string `gorm:"size:512" json:"detail,omitempty"`
}

func (SessionPhase) TableName() string { return "session_phases" }
