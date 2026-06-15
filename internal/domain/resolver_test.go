package domain

import (
	"context"
	"testing"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type fakeProxies map[uint64]*model.Proxy

func (f fakeProxies) FindByID(_ context.Context, id uint64) (*model.Proxy, error) {
	return f[id], nil
}

type fakeDomains map[uint64]*model.Domain

func (f fakeDomains) FindByID(_ context.Context, id uint64) (*model.Domain, error) {
	return f[id], nil
}

func u64(v uint64) *uint64 { return &v }

func TestResolve_DirectDefaultDomain_NoHops(t *testing.T) {
	// The most important invariant: a backfilled node (default direct domain,
	// no legacy chain) dials direct with zero hops — identical to pre-domains.
	r := NewResolver(fakeProxies{}, fakeDomains{1: {ID: 1, Kind: model.DomainDirect, IsDefault: true}})
	plan, err := r.Resolve(context.Background(), &model.Node{ID: 10, DomainID: u64(1)})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if plan.Kind != model.DomainDirect || len(plan.Hops) != 0 || plan.LegacyOverride {
		t.Fatalf("want direct/0-hops/no-override, got %+v", plan)
	}
}

func TestResolve_LegacyProxyChainOverridesDomain(t *testing.T) {
	// A node carrying the deprecated ProxyChain must keep using it verbatim even
	// when it also belongs to a domain — that's the compatibility guarantee.
	proxies := fakeProxies{
		3: {ID: 3, Kind: model.ProxySOCKS5, Host: "p3", Port: 1080},
		1: {ID: 1, Kind: model.ProxySOCKS5, Host: "p1", Port: 1080},
	}
	domains := fakeDomains{5: {ID: 5, Kind: model.DomainProxy, ProxyChain: "9"}}
	r := NewResolver(proxies, domains)
	plan, err := r.Resolve(context.Background(), &model.Node{ID: 11, DomainID: u64(5), ProxyChain: "3,1"})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if !plan.LegacyOverride {
		t.Fatalf("expected legacy override")
	}
	if len(plan.Hops) != 2 || plan.Hops[0].ID != 3 || plan.Hops[1].ID != 1 {
		t.Fatalf("want hops [3,1] from node chain, got %+v", plan.Hops)
	}
}

func TestResolve_ProxyDomainChain(t *testing.T) {
	proxies := fakeProxies{7: {ID: 7, Kind: model.ProxyBastion, Host: "b", Port: 22, CredentialID: u64(2)}}
	domains := fakeDomains{5: {ID: 5, Kind: model.DomainProxy, ProxyChain: "7"}}
	r := NewResolver(proxies, domains)
	plan, err := r.Resolve(context.Background(), &model.Node{ID: 12, DomainID: u64(5)})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if plan.Kind != model.DomainProxy || len(plan.Hops) != 1 || plan.Hops[0].ID != 7 || plan.LegacyOverride {
		t.Fatalf("want proxy domain single-hop, got %+v", plan)
	}
}

func TestResolve_AgentDomain(t *testing.T) {
	domains := fakeDomains{8: {ID: 8, Kind: model.DomainAgent}}
	r := NewResolver(fakeProxies{}, domains)
	plan, err := r.Resolve(context.Background(), &model.Node{ID: 13, DomainID: u64(8)})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if plan.Kind != model.DomainAgent || plan.AgentDomainID == nil || *plan.AgentDomainID != 8 {
		t.Fatalf("want agent domain with AgentDomainID=8, got %+v", plan)
	}
	if len(plan.Hops) != 0 {
		t.Fatalf("agent domain must carry no proxy hops, got %d", len(plan.Hops))
	}
}

func TestResolve_DanglingDomainFallsBackToDirect(t *testing.T) {
	// domain_id points at a row that no longer exists → dial direct, don't fail.
	r := NewResolver(fakeProxies{}, fakeDomains{})
	plan, err := r.Resolve(context.Background(), &model.Node{ID: 14, DomainID: u64(999)})
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if plan.Kind != model.DomainDirect || len(plan.Hops) != 0 {
		t.Fatalf("want direct fallback, got %+v", plan)
	}
}

func TestResolve_ProtocolAllowed(t *testing.T) {
	d := &model.Domain{AllowedProtocols: "ssh,rdp"}
	if !d.ProtocolAllowed(model.NodeProtoSSH) {
		t.Fatal("ssh should be allowed")
	}
	if d.ProtocolAllowed(model.NodeProtoTelnet) {
		t.Fatal("telnet should be rejected by whitelist")
	}
	empty := &model.Domain{}
	if !empty.ProtocolAllowed(model.NodeProtoTelnet) {
		t.Fatal("empty whitelist allows everything")
	}
}
