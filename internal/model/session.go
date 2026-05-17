package model

import "time"

type SessionKind string

const (
	SessionInteractive SessionKind = "interactive"
	SessionAnonymous   SessionKind = "anonymous"
	SessionSFTP        SessionKind = "sftp"
	SessionGraphical   SessionKind = "graphical"
	SessionTCPForward  SessionKind = "tcp_forward"
)

// RecordingType discriminates the format of the on-disk recording so the
// download endpoint can set the right Content-Type and the player knows how to
// interpret it.
type RecordingType string

const (
	RecordingAsciicast RecordingType = "asciicast"
	RecordingGuac      RecordingType = "guac"
	RecordingNone      RecordingType = ""
)

type SessionStatus string

const (
	SessionActive     SessionStatus = "active"
	SessionClosed     SessionStatus = "closed"
	SessionTerminated SessionStatus = "terminated"
	SessionErrored    SessionStatus = "errored"
)

// Session records a single end-to-end connection. CastPath points at the
// asciinema v2 recording on local disk when present.
type Session struct {
	ID        string        `gorm:"primaryKey;size:64" json:"id"`
	Kind      SessionKind   `gorm:"size:32;not null" json:"kind"`
	UserID    uint64        `gorm:"index" json:"user_id"`
	Username  string        `gorm:"size:64" json:"username"`
	NodeID    *uint64       `json:"node_id,omitempty"`
	NodeName  string        `gorm:"size:128" json:"node_name"`
	ClientIP  string        `gorm:"size:64" json:"client_ip"`
	StartedAt time.Time     `json:"started_at"`
	EndedAt   *time.Time    `json:"ended_at,omitempty"`
	Status    SessionStatus `gorm:"size:32" json:"status"`
	// RecordingPath is the cast/.guac file on disk; the cast_path column name
	// is retained for backward compatibility with the v1 schema.
	RecordingPath string        `gorm:"column:cast_path;size:512" json:"recording_path,omitempty"`
	RecordingType RecordingType `gorm:"size:16" json:"recording_type,omitempty"`
	BytesIn   uint64        `json:"bytes_in"`
	BytesOut  uint64        `json:"bytes_out"`
	Reason    string        `gorm:"size:255" json:"reason,omitempty"`
}

func (Session) TableName() string { return "sessions" }
