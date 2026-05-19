package model

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
	"time"
)

type PortForwardStatus string

const (
	PortForwardActive          PortForwardStatus = "active"
	PortForwardExpired         PortForwardStatus = "expired"
	PortForwardClosed          PortForwardStatus = "closed"
	PortForwardPortUnavailable PortForwardStatus = "port_unavailable"
)

// StringSlice persists []string as a JSON text column. GORM's default tag
// reflection doesn't know how to round-trip a Go slice into MySQL TEXT, so we
// implement Scan/Value ourselves. nil becomes "[]" on disk to keep selects
// trivial; missing rows still decode into a nil slice.
type StringSlice []string

func (s StringSlice) Value() (driver.Value, error) {
	if s == nil {
		return "[]", nil
	}
	b, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	return string(b), nil
}

func (s *StringSlice) Scan(src any) error {
	if src == nil {
		*s = nil
		return nil
	}
	var raw []byte
	switch v := src.(type) {
	case string:
		raw = []byte(v)
	case []byte:
		raw = v
	default:
		return errors.New("portforward tags: unsupported scan type")
	}
	if len(raw) == 0 {
		*s = nil
		return nil
	}
	return json.Unmarshal(raw, s)
}

// PortForward records a gateway-local TCP listener that tunnels through the
// proxy chain to a target node. The listener is bound to LocalHost:LocalPort
// on the gateway machine.
type PortForward struct {
	ID         string            `gorm:"primaryKey;size:64" json:"id"`
	UserID     uint64            `gorm:"index" json:"user_id"`
	Username   string            `gorm:"size:64" json:"username"`
	NodeID     uint64            `gorm:"index" json:"node_id"`
	LocalHost  string            `gorm:"size:64" json:"local_host"`
	LocalPort  int               `json:"local_port"`
	TargetHost string            `gorm:"size:255" json:"target_host"`
	TargetPort int               `json:"target_port"`
	CreatedAt  time.Time         `json:"created_at"`
	ExpiresAt  time.Time         `gorm:"index" json:"expires_at"`
	ClosedAt   *time.Time        `json:"closed_at,omitempty"`
	Status     PortForwardStatus `gorm:"size:24;index" json:"status"`
	BytesIn    uint64            `json:"bytes_in"`
	BytesOut   uint64            `json:"bytes_out"`

	// Phase 7 metadata — user-supplied label, free-form tag list, and a
	// pinned flag that the workspace UI honours. All three are optional so
	// older rows that pre-date this column read back as zero values without
	// needing a backfill migration.
	Label  string      `gorm:"size:128" json:"label"`
	Tags   StringSlice `gorm:"type:text" json:"tags"`
	Pinned bool        `gorm:"index" json:"pinned"`
}

func (PortForward) TableName() string { return "port_forwards" }
