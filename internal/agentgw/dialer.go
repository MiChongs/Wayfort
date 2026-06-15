package agentgw

import (
	"context"
	"net"

	"golang.org/x/net/proxy"
)

// domainDialer is a proxy.ContextDialer that routes every dial through the
// least-loaded connected agent in a fixed domain. It lets agent-domain nodes
// drop into the exact same dial seam as proxy chains: callers hold a
// proxy.ContextDialer and don't care whether bytes egress via a SOCKS hop or a
// reverse tunnel.
type domainDialer struct {
	reg       *Registry
	domainID  uint64
	requestID string
}

// DialerFor returns a proxy.ContextDialer bound to a domain's agents. requestID
// ties the resulting streams to a session for auditing. The dialer does no work
// until DialContext is called, and surfaces ErrNoAgent if the domain has no
// connected agent at dial time.
func (r *Registry) DialerFor(domainID uint64, requestID string) proxy.ContextDialer {
	return &domainDialer{reg: r, domainID: domainID, requestID: requestID}
}

func (d *domainDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	return d.reg.Dial(ctx, d.domainID, d.requestID, network, addr)
}

// Dial satisfies proxy.Dialer for callers that use the context-free interface.
func (d *domainDialer) Dial(network, addr string) (net.Conn, error) {
	return d.DialContext(context.Background(), network, addr)
}
