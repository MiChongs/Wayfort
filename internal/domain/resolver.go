// Package domain centralises connectivity resolution: given a node, it decides
// HOW the gateway reaches it (direct / proxy chain / reverse-connect agent),
// based on the node's network domain. It is the single seam every protocol
// gateway routes through, replacing the scattered "parse node.ProxyChain and
// build a chain" logic. See docs/security-architecture.md §3.
package domain

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// ErrAgentDomain is returned when a node belongs to an agent (reverse-connect)
// domain. The reverse tunnel is implemented in M2; until then callers get a
// clear, typed error instead of a silent direct-dial that would bypass the
// domain's intended isolation.
var ErrAgentDomain = errors.New("domain: agent (reverse-connect) domains are not yet available")

// ProxyFinder resolves a single proxy hop by ID. Satisfied by *repo.ProxyRepo.
type ProxyFinder interface {
	FindByID(ctx context.Context, id uint64) (*model.Proxy, error)
}

// DomainFinder loads a domain by ID. Satisfied by *repo.DomainRepo.
type DomainFinder interface {
	FindByID(ctx context.Context, id uint64) (*model.Domain, error)
}

// Resolver turns a node into the concrete proxy hops the dialer should apply.
// It is safe for concurrent use (its dependencies are).
type Resolver struct {
	proxies ProxyFinder
	domains DomainFinder
}

func NewResolver(proxies ProxyFinder, domains DomainFinder) *Resolver {
	return &Resolver{proxies: proxies, domains: domains}
}

// Plan is the resolved connectivity decision for a node: which hops to dial
// through, plus metadata for auditing the egress path.
type Plan struct {
	// Hops is the ordered proxy chain to apply (outermost first). Empty means a
	// direct dial. Always empty for agent domains (the tunnel replaces hops).
	Hops []*model.Proxy
	// Kind is the effective connectivity kind actually used.
	Kind model.DomainKind
	// DomainID is the resolved domain, or nil when the node had no domain and a
	// legacy ProxyChain override drove the decision.
	DomainID *uint64
	// AgentDomainID is set (and Kind == agent) when the node routes via a
	// reverse-connect agent domain, so the caller can dispatch to the agent
	// tunnel once M2 lands. Until then callers should treat this as ErrAgentDomain.
	AgentDomainID *uint64
	// LegacyOverride is true when the node's deprecated ProxyChain column drove
	// the chain instead of its domain — surfaced so the UI can flag it.
	LegacyOverride bool
	// MaxConcurrent is the domain's per-domain concurrent-session ceiling (0 =
	// unlimited), for the overload guard. AllowedProtocols is the domain's
	// protocol whitelist (empty = all). Both empty/zero when no domain applies.
	MaxConcurrent    int
	AllowedProtocols string
}

// Resolve computes the connectivity Plan for a node. Precedence:
//  1. A non-empty node.ProxyChain is a deprecated per-node override and wins
//     (preserves exact pre-domains behaviour during the compatibility window).
//  2. Otherwise the node's domain decides: direct → no hops, proxy → the
//     domain's chain, agent → Kind=agent with AgentDomainID set.
//  3. A node with neither a chain nor a (loadable) domain dials direct.
func (r *Resolver) Resolve(ctx context.Context, node *model.Node) (*Plan, error) {
	if node == nil {
		return nil, errors.New("domain: node is nil")
	}

	// (1) Legacy per-node override.
	if strings.TrimSpace(node.ProxyChain) != "" {
		hops, err := r.resolveChain(ctx, node.ProxyChain)
		if err != nil {
			return nil, err
		}
		return &Plan{
			Hops:           hops,
			Kind:           model.DomainProxy,
			DomainID:       node.DomainID,
			LegacyOverride: true,
		}, nil
	}

	// (2) Domain-driven connectivity.
	if node.DomainID != nil {
		d, err := r.domains.FindByID(ctx, *node.DomainID)
		if err != nil {
			return nil, fmt.Errorf("domain: load domain %d: %w", *node.DomainID, err)
		}
		if d != nil {
			pol := func(p *Plan) *Plan {
				p.MaxConcurrent = d.MaxConcurrentSessions
				p.AllowedProtocols = d.AllowedProtocols
				return p
			}
			switch d.Kind {
			case model.DomainDirect:
				return pol(&Plan{Kind: model.DomainDirect, DomainID: node.DomainID}), nil
			case model.DomainProxy:
				hops, err := r.resolveChain(ctx, d.ProxyChain)
				if err != nil {
					return nil, err
				}
				return pol(&Plan{Hops: hops, Kind: model.DomainProxy, DomainID: node.DomainID}), nil
			case model.DomainAgent:
				return pol(&Plan{Kind: model.DomainAgent, DomainID: node.DomainID, AgentDomainID: node.DomainID}), nil
			default:
				return nil, fmt.Errorf("domain: unsupported domain kind %q", d.Kind)
			}
		}
		// Domain id set but row missing → fall through to direct rather than
		// failing the connection; the dangling reference is a data-quality
		// issue, not a reason to lock the operator out of the asset.
	}

	// (3) No chain, no domain → direct.
	return &Plan{Kind: model.DomainDirect, DomainID: node.DomainID}, nil
}

// resolveChain parses a comma-separated proxy-id list ("3,1") into concrete
// Proxy rows, mirroring sshrun.ResolveHops but kept here so this package is the
// low-level connectivity primitive other packages (including sshrun) can build on.
func (r *Resolver) resolveChain(ctx context.Context, chain string) ([]*model.Proxy, error) {
	ids := splitChain(chain)
	if len(ids) == 0 {
		return nil, nil
	}
	out := make([]*model.Proxy, 0, len(ids))
	for _, raw := range ids {
		var id uint64
		if _, err := fmt.Sscanf(raw, "%d", &id); err != nil {
			return nil, fmt.Errorf("domain: invalid proxy id %q", raw)
		}
		p, err := r.proxies.FindByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if p == nil {
			return nil, fmt.Errorf("domain: proxy %d not found", id)
		}
		out = append(out, p)
	}
	return out, nil
}

func splitChain(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
