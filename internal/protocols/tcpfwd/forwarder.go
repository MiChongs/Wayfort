// Package tcpfwd exposes ad-hoc TCP tunnels through the gateway's proxy chain.
//
// Two modes:
//   - Local listener: the gateway opens a port on 127.0.0.1; the user connects
//     a local client (mysql, RDP, anything TCP) which is tunnelled to the node.
//   - WebSocket relay: the gateway upgrades a WS connection to a binary tunnel
//     that's bridged to the target TCP stream, for browser-side clients.
package tcpfwd

import (
	"context"
	"errors"
	"io"
	"net"
	"strconv"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
	"golang.org/x/net/proxy"
)

// Forwarder is one outbound tunnel: a local TCP listener that pipes every
// accepted connection through dialer to target.
type Forwarder struct {
	ID       string
	Listener net.Listener
	Target   string
	Dialer   proxy.ContextDialer
	Logger   *zap.Logger

	BytesIn  atomic.Uint64
	BytesOut atomic.Uint64

	closing atomic.Bool
	done    chan struct{}
}

// Start opens a listener on host:0, kicks off the accept loop, and returns it.
// portRange is honoured if non-zero ([low, high]); otherwise the kernel picks
// a port. The caller is responsible for calling Close().
func Start(ctx context.Context, host string, portRange [2]int, dialer proxy.ContextDialer, target string, logger *zap.Logger) (*Forwarder, error) {
	if host == "" {
		host = "127.0.0.1"
	}
	ln, err := listen(host, portRange)
	if err != nil {
		return nil, err
	}
	f := &Forwarder{Listener: ln, Target: target, Dialer: dialer, Logger: logger, done: make(chan struct{})}
	go f.accept(ctx)
	return f, nil
}

func listen(host string, r [2]int) (net.Listener, error) {
	if r[0] <= 0 || r[1] <= 0 || r[1] < r[0] {
		return net.Listen("tcp", net.JoinHostPort(host, "0"))
	}
	// Best-effort: try a few random ports in the range. We're not strict —
	// failing means another listener took the port; we keep trying.
	for attempt := 0; attempt < 32; attempt++ {
		port := r[0] + int(time.Now().UnixNano()%int64(r[1]-r[0]+1))
		ln, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
		if err == nil {
			return ln, nil
		}
	}
	// Fallback: let the kernel pick anything.
	return net.Listen("tcp", net.JoinHostPort(host, "0"))
}

func (f *Forwarder) Addr() *net.TCPAddr { return f.Listener.Addr().(*net.TCPAddr) }

func (f *Forwarder) Close() error {
	if !f.closing.CompareAndSwap(false, true) {
		return nil
	}
	err := f.Listener.Close()
	close(f.done)
	return err
}

// Done is closed when Close is called.
func (f *Forwarder) Done() <-chan struct{} { return f.done }

func (f *Forwarder) accept(ctx context.Context) {
	for {
		conn, err := f.Listener.Accept()
		if err != nil {
			if f.closing.Load() || errors.Is(err, net.ErrClosed) {
				return
			}
			f.Logger.Warn("tcpfwd accept failed", zap.Error(err))
			return
		}
		go f.handle(ctx, conn)
	}
}

func (f *Forwarder) handle(ctx context.Context, c net.Conn) {
	defer c.Close()
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	dst, err := f.Dialer.DialContext(dctx, "tcp", f.Target)
	cancel()
	if err != nil {
		f.Logger.Debug("tcpfwd dial failed", zap.String("target", f.Target), zap.Error(err))
		return
	}
	defer dst.Close()
	done := make(chan struct{}, 2)
	go func() { n, _ := io.Copy(dst, c); f.BytesIn.Add(uint64(n)); done <- struct{}{} }()
	go func() { n, _ := io.Copy(c, dst); f.BytesOut.Add(uint64(n)); done <- struct{}{} }()
	<-done
}
