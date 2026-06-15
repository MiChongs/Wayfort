package model

import (
	"strings"
	"time"
)

// splitCSV splits a comma-separated string into trimmed, non-empty tokens.
func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}

// DomainKind enumerates how the gateway reaches the assets that belong to a
// network domain. A domain is the single source of truth for *connectivity*
// (how to get there); authorisation (who may connect) stays orthogonal in the
// asset-grant model. See docs/security-architecture.md §3.
type DomainKind string

const (
	// DomainDirect: the gateway dials the target itself with no proxy. The
	// built-in "default" domain is of this kind, so backfilled legacy nodes
	// behave exactly as they did before domains existed (no hops).
	DomainDirect DomainKind = "direct"
	// DomainProxy: the gateway dials through an ordered proxy chain (same
	// comma-separated proxy-id format as the legacy Node.ProxyChain), which may
	// terminate in a failover group. ProxyChain holds that chain.
	DomainProxy DomainKind = "proxy"
	// DomainAgent: a reverse-connect Gateway Agent living inside the target
	// network dials the target on the gateway's behalf (the gateway never makes
	// an outbound connection into that network). Implemented in M2; until then
	// the DomainDialer rejects agent-domain dials with a clear error.
	DomainAgent DomainKind = "agent"
)

// AllDomainKinds is the canonical allow-list used by validation and UI selectors.
var AllDomainKinds = []DomainKind{DomainDirect, DomainProxy, DomainAgent}

func (k DomainKind) Valid() bool {
	switch k {
	case DomainDirect, DomainProxy, DomainAgent:
		return true
	default:
		return false
	}
}

// DefaultDomainName is the name of the built-in, undeletable direct domain that
// every pre-existing node is backfilled into on first migration.
const DefaultDomainName = "default"

// Domain is a set of assets sharing one reachability strategy plus the policy
// that bounds them. It answers "how do we get there" so individual nodes no
// longer carry散装 proxy_chain configuration (the legacy column is kept as a
// per-node override during the compatibility window).
type Domain struct {
	ID          uint64     `gorm:"primaryKey" json:"id"`
	Name        string     `gorm:"size:128;uniqueIndex;not null" json:"name"`
	Kind        DomainKind `gorm:"size:16;not null" json:"kind"`
	Description string     `gorm:"size:512" json:"description,omitempty"`

	// ProxyChain is meaningful only when Kind == proxy: an ordered,
	// comma-separated list of Proxy IDs (same format as Node.ProxyChain),
	// applied outermost-first, optionally terminating in a failover group.
	// Stored as a string so the existing ResolveHops path consumes it verbatim.
	ProxyChain string `gorm:"size:512" json:"proxy_chain,omitempty"`

	// AllowedProtocols is a comma-separated whitelist of NodeProtocol values the
	// domain permits; empty means "all". Agent domains should default to
	// excluding plaintext protocols (telnet / non-TLS DB) — enforced by guard.
	AllowedProtocols string `gorm:"size:512" json:"allowed_protocols,omitempty"`

	// MaxConcurrentSessions caps live sessions routed through this domain; 0
	// means unlimited. Enforced by internal/guard (M5).
	MaxConcurrentSessions int `gorm:"default:0" json:"max_concurrent_sessions"`

	// IsDefault marks the built-in direct domain. Exactly one row carries it and
	// that row may not be deleted.
	IsDefault bool `gorm:"default:false;index" json:"is_default"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (Domain) TableName() string { return "domains" }

// ProtocolAllowed reports whether proto may be brokered in this domain.
// An empty AllowedProtocols whitelist permits everything.
func (d *Domain) ProtocolAllowed(proto NodeProtocol) bool {
	if d == nil {
		return true
	}
	list := splitCSV(d.AllowedProtocols)
	if len(list) == 0 {
		return true
	}
	for _, p := range list {
		if NodeProtocol(p) == proto {
			return true
		}
	}
	return false
}
