package dialer

import (
	"time"

	"github.com/wzshiming/socks5"
	"golang.org/x/net/proxy"
)

// NewSOCKS5 wraps the upstream ContextDialer so connections traverse a SOCKS5
// server first. Unlike the previous golang.org/x/net/proxy bridge, the wzshiming
// dialer threads the caller's context through to the transport dial via
// ProxyDial, so per-hop timeouts and cancellation propagate end-to-end.
func NewSOCKS5(addr, user, pass string, timeout time.Duration, upstream proxy.ContextDialer) (proxy.ContextDialer, error) {
	d := &socks5.Dialer{
		ProxyNetwork: "tcp",
		ProxyAddress: addr,
		Username:     user,
		Password:     pass,
		Timeout:      timeout,
		ProxyDial:    upstream.DialContext,
	}
	return d, nil
}
