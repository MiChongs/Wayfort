package model

import "time"

type PortForwardStatus string

const (
	PortForwardActive  PortForwardStatus = "active"
	PortForwardExpired PortForwardStatus = "expired"
	PortForwardClosed  PortForwardStatus = "closed"
)

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
	Status     PortForwardStatus `gorm:"size:16;index" json:"status"`
	BytesIn    uint64            `json:"bytes_in"`
	BytesOut   uint64            `json:"bytes_out"`
}

func (PortForward) TableName() string { return "port_forwards" }
