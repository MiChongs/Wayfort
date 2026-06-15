package model

import "time"

// AgentStatus is the lifecycle state of a reverse-connect Gateway Agent. New
// registrations land in pending and must be activated by an admin (after
// verifying the fingerprint + source IP) before they can carry any session —
// this is the defence against an attacker who races a leaked enrollment token.
// See docs/security-architecture.md §4.
type AgentStatus string

const (
	// AgentPending: enrolled but not yet activated; carries no sessions.
	AgentPending AgentStatus = "pending"
	// AgentOnline: activated and currently connected (heartbeat fresh).
	AgentOnline AgentStatus = "online"
	// AgentOffline: activated but no live tunnel (missed heartbeats / restart).
	AgentOffline AgentStatus = "offline"
	// AgentRevoked: administratively disabled; tunnel refused, cert revoked.
	AgentRevoked AgentStatus = "revoked"
)

func (s AgentStatus) Valid() bool {
	switch s {
	case AgentPending, AgentOnline, AgentOffline, AgentRevoked:
		return true
	default:
		return false
	}
}

// GatewayAgent is a registered reverse-connect agent that lives inside an
// isolated network and dials targets on the gateway's behalf. It only ever
// connects outbound to the gateway; it never listens. One agent domain may hold
// several agents (that set is the domain's HA). See §4 / §12.
type GatewayAgent struct {
	ID       uint64 `gorm:"primaryKey" json:"id"`
	DomainID uint64 `gorm:"index;not null" json:"domain_id"`
	Name     string `gorm:"size:128;not null" json:"name"`

	// SecretHash is the SHA-256 (hex) of the M2 tunnel bearer secret handed back
	// at enrollment. The plaintext is shown to the agent exactly once and never
	// stored. Superseded by mTLS client certificates in M3.
	SecretHash string `gorm:"size:64" json:"-"`
	// Fingerprint is the SHA-256 of the agent's current client certificate (set
	// once the cert is issued; empty while only an enroll token has been minted).
	Fingerprint string `gorm:"size:95;index" json:"fingerprint,omitempty"`
	// EnrollIP is the source IP the agent enrolled from, recorded so an admin can
	// verify it together with the fingerprint before activating — the human check
	// against a raced/leaked enrollment token (§4).
	EnrollIP string `gorm:"size:64" json:"enroll_ip,omitempty"`
	// CertSerial / CertExpiresAt track the active client certificate so the UI
	// can warn before expiry and the renew path can validate.
	CertSerial    string     `gorm:"size:64" json:"cert_serial,omitempty"`
	CertExpiresAt *time.Time `json:"cert_expires_at,omitempty"`

	Status  AgentStatus `gorm:"size:16;not null;default:pending" json:"status"`
	Version string      `gorm:"size:32" json:"version,omitempty"`

	// LastSeenAt is the last heartbeat time; LastGateway records which gateway
	// instance currently owns the tunnel (HA bookkeeping).
	LastSeenAt  *time.Time `json:"last_seen_at,omitempty"`
	LastGateway string     `gorm:"size:64" json:"last_gateway,omitempty"`

	// Stats is a JSON blob of the latest heartbeat payload (active streams, CPU,
	// memory). Stored as text so the absence of a JSON column type never breaks
	// migration; the handler marshals/unmarshals it.
	Stats string `gorm:"type:text" json:"stats,omitempty"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (GatewayAgent) TableName() string { return "gateway_agents" }

// Schedulable reports whether the agent may currently carry new sessions: it
// must be activated (online/offline, not pending/revoked). Online vs offline is
// decided at dispatch time from the live registry, not this row.
func (a *GatewayAgent) Schedulable() bool {
	return a != nil && (a.Status == AgentOnline || a.Status == AgentOffline)
}

// AgentEnrollToken is a one-time, short-TTL secret that lets a fresh agent prove
// it was authorised to enroll into a domain. Only its SHA-256 hash is stored;
// the plaintext is shown to the admin exactly once. Consuming it (UsedAt set)
// invalidates it. May optionally pin the source CIDR it can be consumed from.
// See §4.
type AgentEnrollToken struct {
	ID        uint64 `gorm:"primaryKey" json:"id"`
	DomainID  uint64 `gorm:"index;not null" json:"domain_id"`
	TokenHash string `gorm:"size:64;uniqueIndex;not null" json:"-"`
	// AllowedCIDR optionally restricts which source network may consume the
	// token (empty = any). Belt-and-suspenders against token interception.
	AllowedCIDR string `gorm:"size:64" json:"allowed_cidr,omitempty"`

	CreatedBy uint64     `json:"created_by"`
	ExpiresAt time.Time  `gorm:"not null" json:"expires_at"`
	UsedAt    *time.Time `json:"used_at,omitempty"`

	CreatedAt time.Time `json:"created_at"`
}

func (AgentEnrollToken) TableName() string { return "agent_enroll_tokens" }

// Consumed reports whether the token has already been used.
func (t *AgentEnrollToken) Consumed() bool { return t != nil && t.UsedAt != nil }
