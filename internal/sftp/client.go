package sftp

import (
	"context"
	"fmt"

	"github.com/michongs/wayfort/internal/dialer"
	"github.com/michongs/wayfort/internal/domain"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	pkgssh "github.com/michongs/wayfort/internal/ssh"
	pkgsftp "github.com/pkg/sftp"
	xssh "golang.org/x/crypto/ssh"
)

// Connector builds a short-lived SFTP client for a given node. Callers must
// call the returned Close in a defer; it tears down both the SFTP session and
// the underlying SSH client (the bastion chain is refcounted separately).
type Connector struct {
	Nodes    *repo.NodeRepo
	Creds    *repo.CredentialRepo
	Proxies  *repo.ProxyRepo
	Domains  *domain.Resolver
	Resolver *pkgssh.Resolver
	Chain    *dialer.ChainBuilder
	HostKey  xssh.HostKeyCallback
	DialTO   func() (timeoutSeconds int)
}

// hopsFor resolves the proxy hops to reach node, preferring the network-domain
// resolver when wired and falling back to the legacy per-node ProxyChain.
func (c *Connector) hopsFor(ctx context.Context, node *model.Node) ([]*model.Proxy, error) {
	if c.Domains != nil {
		plan, err := c.Domains.Resolve(ctx, node)
		if err != nil {
			return nil, err
		}
		return plan.Hops, nil
	}
	return resolveHops(ctx, c.Proxies, node.ProxyChain)
}

func (c *Connector) Open(ctx context.Context, nodeID uint64) (*pkgsftp.Client, func(), error) {
	node, err := c.Nodes.FindByID(ctx, nodeID)
	if err != nil || node == nil {
		return nil, nil, fmt.Errorf("node %d not found", nodeID)
	}
	hops, err := c.hopsFor(ctx, node)
	if err != nil {
		return nil, nil, err
	}
	finalDialer, releaseHops, err := c.Chain.Build(ctx, hops, nil)
	if err != nil {
		return nil, nil, err
	}
	cred, err := c.Creds.FindByID(ctx, node.CredentialID)
	if err != nil || cred == nil {
		releaseHops()
		return nil, nil, fmt.Errorf("credential lookup failed")
	}
	methods, err := c.Resolver.AuthMethods(cred)
	if err != nil {
		releaseHops()
		return nil, nil, err
	}
	sshClient, err := pkgssh.Connect(ctx, finalDialer, pkgssh.DialConfig{
		Addr:    pkgssh.AddrOf(node.Host, node.Port),
		User:    pkgssh.PreferredUser(cred, node.Username),
		Auth:    methods,
		HostKey: c.HostKey,
	})
	if err != nil {
		releaseHops()
		return nil, nil, err
	}
	sftpClient, err := pkgsftp.NewClient(sshClient)
	if err != nil {
		_ = sshClient.Close()
		releaseHops()
		return nil, nil, err
	}
	closer := func() {
		_ = sftpClient.Close()
		_ = sshClient.Close()
		releaseHops()
	}
	return sftpClient, closer, nil
}

func resolveHops(ctx context.Context, proxies *repo.ProxyRepo, chain string) ([]*model.Proxy, error) {
	if chain == "" {
		return nil, nil
	}
	out := make([]*model.Proxy, 0, 4)
	for _, raw := range splitChain(chain) {
		var id uint64
		_, err := fmt.Sscanf(raw, "%d", &id)
		if err != nil {
			return nil, fmt.Errorf("invalid proxy id %q", raw)
		}
		p, err := proxies.FindByID(ctx, id)
		if err != nil {
			return nil, err
		}
		if p == nil {
			return nil, fmt.Errorf("proxy %d not found", id)
		}
		out = append(out, p)
	}
	return out, nil
}

func splitChain(s string) []string {
	var out []string
	start := 0
	for i, r := range s {
		if r == ',' {
			if i > start {
				out = append(out, s[start:i])
			}
			start = i + 1
		}
	}
	if start < len(s) {
		out = append(out, s[start:])
	}
	return out
}
