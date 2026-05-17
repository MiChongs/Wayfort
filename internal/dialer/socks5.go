package dialer

import (
	"context"
	"fmt"
	"net"

	"golang.org/x/net/proxy"
)

// NewSOCKS5 wraps the upstream ContextDialer so that connections traverse a
// SOCKS5 server first.
func NewSOCKS5(addr, user, pass string, upstream proxy.ContextDialer) (proxy.ContextDialer, error) {
	var auth *proxy.Auth
	if user != "" {
		auth = &proxy.Auth{User: user, Password: pass}
	}
	// proxy.SOCKS5 takes a proxy.Dialer (non-context). We bridge by adapting
	// upstream.DialContext into a context-less Dial.
	d, err := proxy.SOCKS5("tcp", addr, auth, dialerAdapter{upstream})
	if err != nil {
		return nil, err
	}
	cd, ok := d.(proxy.ContextDialer)
	if !ok {
		return nil, fmt.Errorf("socks5 dialer does not implement ContextDialer")
	}
	return cd, nil
}

type dialerAdapter struct{ cd proxy.ContextDialer }

func (a dialerAdapter) Dial(network, addr string) (net.Conn, error) {
	return a.cd.DialContext(context.Background(), network, addr)
}
