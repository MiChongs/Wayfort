package dialer

import (
	"context"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"golang.org/x/net/proxy"
)

// BastionConnector opens (or fetches from a pool) an SSH client to the given
// bastion using outer as the underlying transport. Implementations live in
// internal/sshpool so this package stays decoupled from the SSH stack.
type BastionConnector interface {
	Acquire(ctx context.Context, p *model.Proxy, outer proxy.ContextDialer) (*BastionDialer, func(), error)
}

// CredentialResolver knows how to fetch SOCKS5 credentials by ID. It is only
// called for proxies that point to a Credential row.
type CredentialResolver interface {
	UserPassByCredentialID(ctx context.Context, id uint64) (user, pass string, err error)
}

type ChainBuilder struct {
	Bastion BastionConnector
	Creds   CredentialResolver
}

// Build composes the chain of proxies and returns a ContextDialer that, when
// used, will tunnel through every hop in order. release MUST be called once
// the resulting dialer is no longer needed so bastion clients can decrement
// their refcounts. release is safe to call exactly once and is never nil.
func (b *ChainBuilder) Build(ctx context.Context, hops []*model.Proxy, base proxy.ContextDialer) (proxy.ContextDialer, func(), error) {
	if base == nil {
		base = &Direct{}
	}
	releases := make([]func(), 0, len(hops))
	release := func() {
		// Release in reverse order so inner clients drop their refs before the
		// outer transports they depend on are torn down.
		for i := len(releases) - 1; i >= 0; i-- {
			if releases[i] != nil {
				releases[i]()
			}
		}
	}
	current := base
	for _, hop := range hops {
		next, rel, err := b.wrap(ctx, hop, current)
		if err != nil {
			release()
			return nil, func() {}, fmt.Errorf("chain hop %s: %w", hop.Name, err)
		}
		releases = append(releases, rel)
		current = next
	}
	return current, release, nil
}

func (b *ChainBuilder) wrap(ctx context.Context, p *model.Proxy, outer proxy.ContextDialer) (proxy.ContextDialer, func(), error) {
	switch p.Kind {
	case model.ProxyDirect:
		return outer, nil, nil
	case model.ProxySOCKS5:
		var user, pass string
		if p.CredentialID != nil && b.Creds != nil {
			u, pw, err := b.Creds.UserPassByCredentialID(ctx, *p.CredentialID)
			if err != nil {
				return nil, nil, err
			}
			user, pass = u, pw
		}
		addr := fmt.Sprintf("%s:%d", p.Host, p.Port)
		d, err := NewSOCKS5(addr, user, pass, outer)
		return d, nil, err
	case model.ProxyBastion:
		if b.Bastion == nil {
			return nil, nil, fmt.Errorf("bastion connector not configured")
		}
		bd, rel, err := b.Bastion.Acquire(ctx, p, outer)
		if err != nil {
			return nil, nil, err
		}
		return bd, rel, nil
	default:
		return nil, nil, fmt.Errorf("unsupported proxy kind %q", p.Kind)
	}
}
