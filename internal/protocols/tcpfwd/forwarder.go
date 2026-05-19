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
	UserID   uint64
	Listener net.Listener
	Target   string
	Dialer   proxy.ContextDialer
	Logger   *zap.Logger

	BytesIn  atomic.Uint64
	BytesOut atomic.Uint64

	// Rolling counters for the 500ms throughput tick. lastIn/Out hold the
	// totals at the previous tick so we can derive Bps without keeping a
	// time-series window in memory. activeConns tracks the live socket
	// pair count for the conn_open/conn_close events.
	lastIn      atomic.Uint64
	lastOut     atomic.Uint64
	activeConns atomic.Int32

	bus *EventBus

	closing atomic.Bool
	done    chan struct{}
}

// StartOpts configures a freshly-built Forwarder. Bus is optional; when nil
// the forwarder runs without publishing any events (useful in tests).
type StartOpts struct {
	ID     string
	UserID uint64
	Host   string
	PortRange [2]int
	Dialer proxy.ContextDialer
	Target string
	Logger *zap.Logger
	Bus    *EventBus
}

// Start opens a listener on host:0, kicks off the accept loop, and returns
// the running forwarder. portRange is honoured if non-zero ([low, high]);
// otherwise the kernel picks a port. The caller is responsible for calling
// Close(). Events (opened / conn_open / conn_close / bytes_tick / closed /
// error) are published to opts.Bus when non-nil.
func Start(ctx context.Context, opts StartOpts) (*Forwarder, error) {
	host := opts.Host
	if host == "" {
		host = "127.0.0.1"
	}
	ln, err := listen(host, opts.PortRange)
	if err != nil {
		if opts.Bus != nil {
			opts.Bus.Publish(Event{
				Type: EventError, ForwardID: opts.ID, UserID: opts.UserID,
				ErrorMessage: "listen failed: " + err.Error(),
			})
		}
		return nil, err
	}
	f := &Forwarder{
		ID: opts.ID, UserID: opts.UserID,
		Listener: ln, Target: opts.Target, Dialer: opts.Dialer, Logger: opts.Logger,
		bus:  opts.Bus,
		done: make(chan struct{}),
	}
	if f.bus != nil {
		f.bus.Publish(Event{Type: EventOpened, ForwardID: f.ID, UserID: f.UserID})
	}
	go f.accept(ctx)
	go f.runMetrics(ctx)
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
	// Range exhausted — defer to the kernel to pick any free port.
	return net.Listen("tcp", net.JoinHostPort(host, "0"))
}

func (f *Forwarder) Addr() *net.TCPAddr { return f.Listener.Addr().(*net.TCPAddr) }

// ActiveConns returns the live socket pair count for the metrics tick.
func (f *Forwarder) ActiveConns() uint32 {
	n := f.activeConns.Load()
	if n < 0 {
		return 0
	}
	return uint32(n)
}

func (f *Forwarder) Close() error {
	if !f.closing.CompareAndSwap(false, true) {
		return nil
	}
	err := f.Listener.Close()
	close(f.done)
	if f.bus != nil {
		f.bus.Publish(Event{Type: EventClosed, ForwardID: f.ID, UserID: f.UserID})
	}
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
			if f.bus != nil {
				f.bus.Publish(Event{
					Type: EventError, ForwardID: f.ID, UserID: f.UserID,
					ErrorMessage: "accept: " + err.Error(),
				})
			}
			return
		}
		go f.handle(ctx, conn)
	}
}

func (f *Forwarder) handle(ctx context.Context, c net.Conn) {
	defer c.Close()
	f.activeConns.Add(1)
	if f.bus != nil {
		f.bus.Publish(Event{
			Type: EventConnOpen, ForwardID: f.ID, UserID: f.UserID,
			ActiveConns: f.ActiveConns(),
		})
	}
	defer func() {
		f.activeConns.Add(-1)
		if f.bus != nil {
			f.bus.Publish(Event{
				Type: EventConnClose, ForwardID: f.ID, UserID: f.UserID,
				ActiveConns: f.ActiveConns(),
			})
		}
	}()
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	dst, err := f.Dialer.DialContext(dctx, "tcp", f.Target)
	cancel()
	if err != nil {
		f.Logger.Debug("tcpfwd dial failed", zap.String("target", f.Target), zap.Error(err))
		if f.bus != nil {
			f.bus.Publish(Event{
				Type: EventError, ForwardID: f.ID, UserID: f.UserID,
				ErrorMessage: "dial: " + err.Error(),
			})
		}
		return
	}
	defer dst.Close()
	done := make(chan struct{}, 2)
	go func() { n, _ := io.Copy(dst, c); f.BytesIn.Add(uint64(n)); done <- struct{}{} }()
	go func() { n, _ := io.Copy(c, dst); f.BytesOut.Add(uint64(n)); done <- struct{}{} }()
	<-done
}

// runMetrics emits a bytes_tick event every 500ms while the forwarder is
// alive. It derives the per-tick byte rate by diffing against the previous
// snapshot — cheap and resilient to clock skew (uses elapsed wall-clock
// inside the same goroutine).
func (f *Forwarder) runMetrics(ctx context.Context) {
	if f.bus == nil {
		return
	}
	const tickInterval = 500 * time.Millisecond
	t := time.NewTicker(tickInterval)
	defer t.Stop()
	lastAt := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case <-f.done:
			return
		case now := <-t.C:
			in := f.BytesIn.Load()
			out := f.BytesOut.Load()
			elapsed := now.Sub(lastAt).Seconds()
			lastAt = now
			prevIn := f.lastIn.Swap(in)
			prevOut := f.lastOut.Swap(out)
			var inRate, outRate uint64
			if elapsed > 0 {
				if in > prevIn {
					inRate = uint64(float64(in-prevIn) / elapsed)
				}
				if out > prevOut {
					outRate = uint64(float64(out-prevOut) / elapsed)
				}
			}
			f.bus.Publish(Event{
				Type:        EventBytesTick,
				ForwardID:   f.ID,
				UserID:      f.UserID,
				BytesIn:     in,
				BytesOut:    out,
				InRateBps:   inRate,
				OutRateBps:  outRate,
				ActiveConns: f.ActiveConns(),
			})
		}
	}
}
