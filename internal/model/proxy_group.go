package model

import "time"

// FailoverStrategy selects which member of a failover group a chain dials first
// (and the order it falls back through the rest).
type FailoverStrategy string

const (
	// FailoverOrdered tries members by ascending Priority (stable, predictable).
	FailoverOrdered FailoverStrategy = "ordered"
	// FailoverRoundRobin rotates the starting member each dial to spread load.
	FailoverRoundRobin FailoverStrategy = "round_robin"
	// FailoverHealthWeighted prefers members the prober reports up, lowest
	// latency first; falls back to the ordered list when health is unknown.
	FailoverHealthWeighted FailoverStrategy = "health_weighted"
)

// AllFailoverStrategies is the validation/UI allow-list.
var AllFailoverStrategies = []FailoverStrategy{FailoverOrdered, FailoverRoundRobin, FailoverHealthWeighted}

func (s FailoverStrategy) Valid() bool {
	for _, k := range AllFailoverStrategies {
		if s == k {
			return true
		}
	}
	return false
}

// ProxyGroupMember links a failover group proxy (GroupID, Kind==failover) to one
// member proxy (MemberID, any non-group kind). Priority orders ordered/weighted
// strategies; Weight biases health-weighted selection.
type ProxyGroupMember struct {
	ID        uint64    `gorm:"primaryKey" json:"id"`
	GroupID   uint64    `gorm:"index;not null" json:"group_id"`
	MemberID  uint64    `gorm:"index;not null" json:"member_id"`
	Priority  int       `gorm:"default:0" json:"priority"`
	Weight    int       `gorm:"default:1" json:"weight"`
	CreatedAt time.Time `json:"created_at"`
}

func (ProxyGroupMember) TableName() string { return "proxy_group_members" }

// ProxyGroupSpec is the API-facing payload for editing a failover hop. It is the
// transient Proxy.Group field; the handler maps it onto GroupStrategy/RetryMax/
// BackoffMS scalars plus the proxy_group_members rows.
type ProxyGroupSpec struct {
	Members   []uint64         `json:"members"`
	Strategy  FailoverStrategy `json:"strategy"`
	Retry     int              `json:"retry"`
	BackoffMS int              `json:"backoff_ms"`
}
