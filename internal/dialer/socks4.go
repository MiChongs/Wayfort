package dialer

import (
	"time"

	"github.com/wzshiming/socks4"
	"golang.org/x/net/proxy"
)

// NewSOCKS4 wraps the upstream ContextDialer so connections traverse a SOCKS4 /
// SOCKS4a server first. When remote is true the proxy resolves the destination
// name (SOCKS4a); otherwise the name is resolved locally before the request.
// SOCKS4 carries only an optional username (ident) — there is no password.
func NewSOCKS4(addr, user string, remote bool, timeout time.Duration, upstream proxy.ContextDialer) (proxy.ContextDialer, error) {
	d := &socks4.Dialer{
		ProxyNetwork: "tcp",
		ProxyAddress: addr,
		Username:     user,
		IsResolve:    !remote, // IsResolve = resolve locally; remote → SOCKS4a
		Timeout:      timeout,
		ProxyDial:    upstream.DialContext,
	}
	return d, nil
}
