package agentgw

import (
	"context"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/hashicorp/yamux"
)

// yamuxConfig returns the shared multiplexer config: keepalive pings detect a
// dead agent fast, and a bounded accept backlog avoids unbounded buffering.
func yamuxConfig() *yamux.Config {
	c := yamux.DefaultConfig()
	c.EnableKeepAlive = true
	c.KeepAliveInterval = 15 * time.Second
	c.ConnectionWriteTimeout = 10 * time.Second
	// The library logs to stderr by default; silence it — tunnel errors surface
	// through returned errors and the registry's bookkeeping instead.
	c.LogOutput = io.Discard
	return c
}

// Tunnel is the gateway's handle on one connected agent. The gateway is the
// yamux *client*: it opens a stream whenever it needs the agent to dial a
// target. The agent is the yamux server. One Tunnel == one live agent.
type Tunnel struct {
	AgentID  uint64
	DomainID uint64
	sess     *yamux.Session
}

// NewGatewayTunnel wraps an established agent connection (a net.Conn over the
// WSS transport) in a yamux client session.
func NewGatewayTunnel(agentID, domainID uint64, conn net.Conn) (*Tunnel, error) {
	sess, err := yamux.Client(conn, yamuxConfig())
	if err != nil {
		return nil, fmt.Errorf("agentgw: start yamux client: %w", err)
	}
	return &Tunnel{AgentID: agentID, DomainID: domainID, sess: sess}, nil
}

// DialTarget opens a new multiplexed stream, sends the OPEN frame, waits for the
// agent's ACK, and returns the stream as a net.Conn bound to the target. The
// caller copies bytes both ways and closes the returned conn when done.
func (t *Tunnel) DialTarget(ctx context.Context, requestID, network, addr string) (net.Conn, error) {
	stream, err := t.sess.OpenStream()
	if err != nil {
		return nil, fmt.Errorf("agentgw: open stream: %w", err)
	}
	deadline, ok := ctx.Deadline()
	var deadlineMS int64
	if ok {
		deadlineMS = time.Until(deadline).Milliseconds()
		if deadlineMS < 0 {
			deadlineMS = 0
		}
	}
	// Bound the control handshake so a wedged agent can't hang the caller.
	_ = stream.SetDeadline(time.Now().Add(15 * time.Second))
	if err := writeFrame(stream, OpenFrame{
		RequestID:  requestID,
		Network:    network,
		Target:     addr,
		DeadlineMS: deadlineMS,
	}); err != nil {
		_ = stream.Close()
		return nil, fmt.Errorf("agentgw: write open frame: %w", err)
	}
	var ack AckFrame
	if err := readFrame(stream, &ack); err != nil {
		_ = stream.Close()
		return nil, fmt.Errorf("agentgw: read ack: %w", err)
	}
	if !ack.OK {
		_ = stream.Close()
		return nil, fmt.Errorf("agentgw: agent dial failed: %s", ack.Error)
	}
	// Hand a clean byte pipe to the caller — clear the handshake deadline.
	_ = stream.SetDeadline(time.Time{})
	return stream, nil
}

// NumStreams reports the count of live streams, used by the registry to pick the
// least-loaded agent in a domain.
func (t *Tunnel) NumStreams() int { return t.sess.NumStreams() }

// IsClosed reports whether the underlying session has gone away.
func (t *Tunnel) IsClosed() bool { return t.sess.IsClosed() }

// Ping round-trips a keepalive and returns the RTT — surfaced as agent health.
func (t *Tunnel) Ping() (time.Duration, error) { return t.sess.Ping() }

// Wait blocks until the tunnel's session ends (agent disconnect, network drop,
// or Close). The WSS handler parks on this to keep the connection alive for the
// tunnel's lifetime.
func (t *Tunnel) Wait() { <-t.sess.CloseChan() }

// Close tears the tunnel (and all its streams) down.
func (t *Tunnel) Close() error { return t.sess.Close() }
