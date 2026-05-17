// Package telnet adapts a raw TCP connection (typically to a network device's
// telnet daemon) so it can be served by the existing WebSocket session pump.
//
// The Backend implements webssh.Backend exactly the same way the SSH backend
// does. Telnet itself does not negotiate window size by default; if a device
// supports the NAWS option (RFC 1073) callers may set NegotiateNAWS=true.
package telnet

import (
	"context"
	"errors"
	"net"
	"strconv"

	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"golang.org/x/net/proxy"
)

// Backend is a thin webssh.Backend wrapping a net.Conn. The IAC negotiation
// from the server flows through unchanged; xterm.js handles the escape codes.
type Backend struct {
	conn net.Conn
}

func Dial(ctx context.Context, d proxy.ContextDialer, host string, port int) (*Backend, error) {
	if port == 0 {
		port = 23
	}
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	c, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	return &Backend{conn: c}, nil
}

// New is a convenience wrapper that builds the proxy chain and dials in one call.
// release MUST be called even when the returned error is non-nil — callers can
// rely on it being safe.
func New(ctx context.Context, chain *dialer.ChainBuilder, hops []*model.Proxy, host string, port int) (*Backend, func(), error) {
	d, release, err := chain.Build(ctx, hops, nil)
	if err != nil {
		return nil, func() {}, err
	}
	b, err := Dial(ctx, d, host, port)
	if err != nil {
		release()
		return nil, func() {}, err
	}
	return b, release, nil
}

func (b *Backend) Read(p []byte) (int, error)  { return b.conn.Read(p) }
func (b *Backend) Write(p []byte) (int, error) { return b.conn.Write(p) }
func (b *Backend) Resize(uint32, uint32) error { return nil }
func (b *Backend) Close() error {
	if b == nil || b.conn == nil {
		return errors.New("nil telnet backend")
	}
	return b.conn.Close()
}
