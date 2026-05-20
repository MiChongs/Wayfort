package model

import "time"

type ProxyKind string

const (
	ProxyDirect   ProxyKind = "direct"
	ProxySOCKS5   ProxyKind = "socks5"
	ProxyBastion  ProxyKind = "bastion"
	ProxyHTTPConn ProxyKind = "http_connect"
)

// AllProxyKinds is the canonical list of allowed proxy kinds. Used by
// validation, UI selectors and chain template gating.
var AllProxyKinds = []ProxyKind{ProxyDirect, ProxySOCKS5, ProxyBastion, ProxyHTTPConn}

// Proxy is one hop in a connection chain. A bastion proxy references a
// Credential so we know how to SSH into it; a SOCKS5 proxy may optionally
// reference one for username/password auth.
type Proxy struct {
	ID           uint64    `gorm:"primaryKey" json:"id"`
	Name         string    `gorm:"size:128;not null" json:"name"`
	Kind         ProxyKind `gorm:"size:32;not null" json:"kind"`
	Host         string    `gorm:"size:255" json:"host"`
	Port         int       `json:"port"`
	CredentialID *uint64   `json:"credential_id,omitempty"`
	// Description is a free-form note shown in the chain builder so operators
	// can document "what is this hop for" (region, owner, purpose).
	Description string `gorm:"size:512" json:"description,omitempty"`
	// Disabled hops are kept in the catalog but excluded from new chains; the
	// builder surfaces them with a warning if an existing chain still uses
	// them.
	Disabled bool `gorm:"default:false" json:"disabled"`
	// Tags is a comma-separated string of grouping tokens (e.g. "prod,asia,
	// audit-only"). Used by the chain builder for filtering and templates.
	Tags      string    `gorm:"size:256" json:"tags,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (Proxy) TableName() string { return "proxies" }

// ProxyChainTemplate stores reusable chain presets so operators don't have to
// type the same hop sequence on every node. Chain is the comma-separated proxy
// id list (same format as Node.ProxyChain) so the existing resolveHops path
// works unchanged when a template is applied.
type ProxyChainTemplate struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"size:128;not null;uniqueIndex" json:"name"`
	Description string    `gorm:"size:512" json:"description,omitempty"`
	Chain       string    `gorm:"size:512;not null" json:"chain"`
	Tags        string    `gorm:"size:256" json:"tags,omitempty"`
	CreatedBy   *uint64   `json:"created_by,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (ProxyChainTemplate) TableName() string { return "proxy_chain_templates" }
