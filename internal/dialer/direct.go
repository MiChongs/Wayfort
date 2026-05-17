package dialer

import (
	"context"
	"net"
	"time"

	"golang.org/x/net/proxy"
)

// Direct is a ContextDialer backed by net.Dialer with a configurable timeout.
type Direct struct {
	Timeout   time.Duration
	KeepAlive time.Duration
}

var _ proxy.ContextDialer = (*Direct)(nil)

func (d *Direct) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	nd := &net.Dialer{Timeout: d.Timeout, KeepAlive: d.KeepAlive}
	return nd.DialContext(ctx, network, addr)
}

// Wrap an existing net.Dialer as a ContextDialer so callers can interchange it.
func Wrap(d *net.Dialer) proxy.ContextDialer { return contextDialerFunc(d.DialContext) }

type contextDialerFunc func(ctx context.Context, network, addr string) (net.Conn, error)

func (f contextDialerFunc) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	return f(ctx, network, addr)
}
