package dialer

import (
	"context"
	"net"
	"sync/atomic"
	"time"

	"golang.org/x/net/proxy"
)

// MetricsSink receives connection-level telemetry from the chain. It is the
// consumer interface the dialer owns; internal/metrics implements it. All calls
// must be safe for concurrent use and cheap (they run on the hot dial path).
type MetricsSink interface {
	// OnDial records one attempt to reach proxyID's server (success or not) and
	// how long establishing the transport to it took.
	OnDial(proxyID uint64, ok bool, d time.Duration)
	// OnConnOpen / OnConnClose move the active-connection gauge for proxyID.
	OnConnOpen(proxyID uint64)
	OnConnClose(proxyID uint64)
	// AddBytes accumulates bytes read from / written to the chain, attributed to
	// proxyID (the chain's egress hop).
	AddBytes(proxyID uint64, in, out int64)
}

// dialMeter times and counts the dial that establishes the transport to a single
// hop's proxy server, attributing it to that hop. It returns the raw conn — byte
// accounting is done once at the outermost connMeter to avoid per-hop double
// counting. Installed per-hop in ChainBuilder.wrap.
type dialMeter struct {
	inner   proxy.ContextDialer
	sink    MetricsSink
	proxyID uint64
}

func (m *dialMeter) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	start := time.Now()
	c, err := m.inner.DialContext(ctx, network, addr)
	m.sink.OnDial(m.proxyID, err == nil, time.Since(start))
	return c, err
}

// connMeter is the single outermost wrapper installed by Build. It tags every
// chain conn with the egress (terminal) proxy id so active-connection and byte
// counters reflect real session usage exactly once.
type connMeter struct {
	inner      proxy.ContextDialer
	sink       MetricsSink
	terminalID uint64
}

func (m *connMeter) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	c, err := m.inner.DialContext(ctx, network, addr)
	if err != nil || c == nil {
		return c, err
	}
	m.sink.OnConnOpen(m.terminalID)
	return &meteredConn{Conn: c, sink: m.sink, id: m.terminalID}, nil
}

// meteredConn counts bytes in both directions and emits OnConnClose exactly once.
type meteredConn struct {
	net.Conn
	sink   MetricsSink
	id     uint64
	closed atomic.Bool
}

func (c *meteredConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.sink.AddBytes(c.id, int64(n), 0)
	}
	return n, err
}

func (c *meteredConn) Write(p []byte) (int, error) {
	n, err := c.Conn.Write(p)
	if n > 0 {
		c.sink.AddBytes(c.id, 0, int64(n))
	}
	return n, err
}

func (c *meteredConn) Close() error {
	if c.closed.CompareAndSwap(false, true) {
		c.sink.OnConnClose(c.id)
	}
	return c.Conn.Close()
}
