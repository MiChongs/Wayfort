package model

import (
	"sort"
	"strings"
	"time"

	"gorm.io/gorm"
)

type ProxyKind string

const (
	ProxyDirect   ProxyKind = "direct"
	ProxySOCKS5   ProxyKind = "socks5"
	ProxySOCKS4   ProxyKind = "socks4"
	ProxyBastion  ProxyKind = "bastion"
	ProxyHTTPConn ProxyKind = "http_connect"
	// ProxyFailover is a virtual hop that fans out to a set of member proxies
	// and dials through the first reachable one per its strategy. It carries no
	// endpoint of its own; its members live in proxy_group_members.
	ProxyFailover ProxyKind = "failover"
)

// AllProxyKinds is the canonical list of allowed proxy kinds. Used by
// validation, UI selectors and chain template gating.
var AllProxyKinds = []ProxyKind{ProxyDirect, ProxySOCKS5, ProxySOCKS4, ProxyBastion, ProxyHTTPConn, ProxyFailover}

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
	Tags string `gorm:"size:256" json:"tags,omitempty"`

	// TimeoutMS bounds the dial to reach THIS hop's server (0 → builder default).
	TimeoutMS int `gorm:"default:0" json:"timeout_ms,omitempty"`

	// --- http_connect transport knobs (ignored for other kinds) ---
	// TLSToProxy speaks TLS to the proxy itself (https:// CONNECT endpoint).
	TLSToProxy bool `gorm:"default:false" json:"tls_to_proxy,omitempty"`
	// ProxySNI overrides the TLS ServerName presented to the proxy.
	ProxySNI string `gorm:"size:255" json:"proxy_sni,omitempty"`
	// InsecureSkipVerify disables proxy TLS cert verification (lab use only).
	InsecureSkipVerify bool `gorm:"default:false" json:"insecure_tls,omitempty"`
	// ProxyHeader holds extra CONNECT request headers as "K: V" lines. Persisted
	// flat; the API exposes/accepts the structured Headers map instead.
	ProxyHeader string `gorm:"size:1024" json:"-"`

	// SOCKS4Remote requests SOCKS4a (proxy-side name resolution) instead of
	// resolving the destination locally. Ignored for non-socks4 kinds.
	SOCKS4Remote bool `gorm:"default:false" json:"socks4_remote,omitempty"`

	// --- failover group scalars (meaningful only when Kind == failover) ---
	GroupStrategy  FailoverStrategy `gorm:"size:32" json:"-"`
	GroupRetryMax  int              `gorm:"default:0" json:"-"`
	GroupBackoffMS int              `gorm:"default:0" json:"-"`

	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// Headers is the API-facing view of ProxyHeader (transient, not a column).
	Headers map[string]string `gorm:"-" json:"headers,omitempty"`
	// Group is the API-facing view of a failover hop (transient): member ids +
	// strategy + retry/backoff. The handler bridges it to GroupStrategy/… plus
	// the proxy_group_members table.
	Group *ProxyGroupSpec `gorm:"-" json:"group,omitempty"`
}

func (Proxy) TableName() string { return "proxies" }

// BeforeSave folds the structured Headers map into the flat ProxyHeader column
// so the API can keep speaking JSON objects while storage stays a single string.
func (p *Proxy) BeforeSave(*gorm.DB) error {
	p.ProxyHeader = encodeHeaders(p.Headers)
	return nil
}

// AfterFind rehydrates the structured Headers map from the flat column so reads
// round-trip the same shape writes accept.
func (p *Proxy) AfterFind(*gorm.DB) error {
	p.Headers = decodeHeaders(p.ProxyHeader)
	return nil
}

func encodeHeaders(h map[string]string) string {
	if len(h) == 0 {
		return ""
	}
	keys := make([]string, 0, len(h))
	for k := range h {
		if strings.TrimSpace(k) == "" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic persistence
	lines := make([]string, 0, len(keys))
	for _, k := range keys {
		lines = append(lines, k+": "+h[k])
	}
	return strings.Join(lines, "\n")
}

func decodeHeaders(s string) map[string]string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	out := map[string]string{}
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

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
