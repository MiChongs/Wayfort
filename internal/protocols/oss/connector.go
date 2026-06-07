package oss

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
)

// Connector resolves a node (or raw options + credential) into a ready
// ObjectStore, routing all traffic through the credential pool + proxy chain.
// Mirrors internal/sftp.Connector. Stores are short-lived (built per request);
// the returned closer releases both the SDK client and the proxy chain.
type Connector struct {
	Nodes   *repo.NodeRepo
	Creds   *repo.CredentialRepo
	Proxies *repo.ProxyRepo
	Chain   *dialer.ChainBuilder
	Vault   pkgcrypto.Vault
}

// Open resolves an OSS node into an ObjectStore + its parsed Options.
func (c *Connector) Open(ctx context.Context, nodeID uint64) (ObjectStore, Options, func(), error) {
	node, err := c.Nodes.FindByID(ctx, nodeID)
	if err != nil || node == nil {
		return nil, Options{}, nil, fmt.Errorf("node %d not found", nodeID)
	}
	if node.EffectiveProtocol() != model.NodeProtoOSS {
		return nil, Options{}, nil, fmt.Errorf("node %d is not an OSS target", nodeID)
	}
	opts := ParseOptions(node.ProtoOptions)
	if opts.Region == "" {
		opts.Region = node.Region
	}
	if opts.Endpoint == "" {
		opts.Endpoint = node.Host
	}
	store, release, err := c.openWith(ctx, opts, node.CredentialID, node.ProxyChain)
	if err != nil {
		return nil, Options{}, nil, err
	}
	return store, opts, release, nil
}

// OpenDiscover builds a store from raw options + a credential id (+ optional
// proxy chain) WITHOUT a persisted node — for the admin "test & discover" flow.
func (c *Connector) OpenDiscover(ctx context.Context, opts Options, credentialID uint64, proxyChain string) (ObjectStore, func(), error) {
	return c.openWith(ctx, opts, credentialID, proxyChain)
}

func (c *Connector) openWith(ctx context.Context, opts Options, credID uint64, proxyChain string) (ObjectStore, func(), error) {
	hops, err := resolveHops(ctx, c.Proxies, proxyChain)
	if err != nil {
		return nil, nil, err
	}
	finalDialer, releaseHops, err := c.Chain.Build(ctx, hops, nil)
	if err != nil {
		return nil, nil, err
	}
	cred, err := c.Creds.FindByID(ctx, credID)
	if err != nil || cred == nil {
		releaseHops()
		return nil, nil, fmt.Errorf("credential lookup failed")
	}
	secret, err := c.Vault.Open(cred.Secret)
	if err != nil {
		releaseHops()
		return nil, nil, fmt.Errorf("decrypt credential secret: %w", err)
	}
	httpClient := buildHTTPClient(finalDialer.DialContext, opts.InsecureTLS)
	store, err := Open(ctx, opts, cred.Username, string(secret), httpClient)
	if err != nil {
		releaseHops()
		return nil, nil, err
	}
	closer := func() {
		store.Close()
		releaseHops()
	}
	return store, closer, nil
}

// resolveHops parses a comma-separated proxy-id chain into Proxy rows (mirrors
// internal/sftp.resolveHops).
func resolveHops(ctx context.Context, proxies *repo.ProxyRepo, chain string) ([]*model.Proxy, error) {
	chain = strings.TrimSpace(chain)
	if chain == "" {
		return nil, nil
	}
	out := make([]*model.Proxy, 0, 4)
	for _, raw := range strings.Split(chain, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		id, err := strconv.ParseUint(raw, 10, 64)
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
