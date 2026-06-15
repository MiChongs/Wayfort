package agentgw

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
)

// fakeAgent runs the agent side of the protocol over conn: yamux server that
// accepts streams, reads the OPEN frame, ACKs, then echoes bytes back. It
// records the last requested target so the test can assert on it.
func fakeAgent(t *testing.T, conn net.Conn, gotTarget chan<- string) {
	t.Helper()
	sess, err := yamux.Server(conn, yamuxConfig())
	if err != nil {
		t.Errorf("agent yamux server: %v", err)
		return
	}
	for {
		stream, err := sess.AcceptStream()
		if err != nil {
			return // session closed
		}
		go func(s *yamux.Stream) {
			var open OpenFrame
			if err := readFrame(s, &open); err != nil {
				_ = s.Close()
				return
			}
			select {
			case gotTarget <- open.Target:
			default:
			}
			if err := writeFrame(s, AckFrame{OK: true}); err != nil {
				_ = s.Close()
				return
			}
			_, _ = io.Copy(s, s) // echo
		}(stream)
	}
}

func TestRegistryDial_EndToEnd(t *testing.T) {
	agentConn, gwConn := net.Pipe()
	gotTarget := make(chan string, 1)
	go fakeAgent(t, agentConn, gotTarget)

	tun, err := NewGatewayTunnel(42, 7, gwConn)
	if err != nil {
		t.Fatalf("new tunnel: %v", err)
	}
	defer tun.Close()

	reg := NewRegistry()
	reg.Register(tun)

	if !reg.Has(42) {
		t.Fatal("agent 42 should be registered")
	}
	if ids := reg.AgentsInDomain(7); len(ids) != 1 || ids[0] != 42 {
		t.Fatalf("want [42] in domain 7, got %v", ids)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := reg.Dial(ctx, 7, "req-1", "tcp", "10.1.2.3:22")
	if err != nil {
		t.Fatalf("dial through agent: %v", err)
	}
	defer conn.Close()

	select {
	case tgt := <-gotTarget:
		if tgt != "10.1.2.3:22" {
			t.Fatalf("agent received wrong target %q", tgt)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("agent never received OPEN frame")
	}

	// The stream is now a raw byte pipe to the (echoing) target.
	msg := []byte("hello-agent")
	if _, err := conn.Write(msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read echo: %v", err)
	}
	if string(buf) != string(msg) {
		t.Fatalf("echo mismatch: got %q", buf)
	}
}

// TestServeAgent_RealEcho drives BOTH production sides: the gateway Tunnel +
// Registry dial through yamux into the real ServeAgent loop, which net.Dials a
// live TCP echo server. Proves the agent actually reaches a target and splices.
func TestServeAgent_RealEcho(t *testing.T) {
	// Live echo target inside the "agent's network".
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) { _, _ = io.Copy(c, c); c.Close() }(c)
		}
	}()

	agentConn, gwConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = ServeAgent(ctx, agentConn, AgentServeOptions{}) }()

	tun, err := NewGatewayTunnel(1, 1, gwConn)
	if err != nil {
		t.Fatalf("tunnel: %v", err)
	}
	defer tun.Close()
	reg := NewRegistry()
	reg.Register(tun)

	dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dcancel()
	conn, err := reg.Dial(dctx, 1, "req", "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial through real agent: %v", err)
	}
	defer conn.Close()

	msg := []byte("round-trip-via-agent")
	if _, err := conn.Write(msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != string(msg) {
		t.Fatalf("echo mismatch: %q", buf)
	}
}

// TestServeAgent_DialFailureAcks verifies a target dial failure comes back as a
// clean ACK error rather than hanging the gateway caller.
func TestServeAgent_DialFailureAcks(t *testing.T) {
	agentConn, gwConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		_ = ServeAgent(ctx, agentConn, AgentServeOptions{
			Dial: func(context.Context, string, string) (net.Conn, error) {
				return nil, io.EOF // simulate unreachable target
			},
		})
	}()

	tun, err := NewGatewayTunnel(1, 1, gwConn)
	if err != nil {
		t.Fatalf("tunnel: %v", err)
	}
	defer tun.Close()

	dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dcancel()
	_, err = tun.DialTarget(dctx, "req", "tcp", "10.0.0.9:22")
	if err == nil {
		t.Fatal("expected dial error surfaced from agent ACK")
	}
}

func TestRegistryDial_NoAgent(t *testing.T) {
	reg := NewRegistry()
	_, err := reg.Dial(context.Background(), 99, "r", "tcp", "1.2.3.4:22")
	if err != ErrNoAgent {
		t.Fatalf("want ErrNoAgent, got %v", err)
	}
}

// TestDialerFor_RoutesThroughAgent proves the proxy.ContextDialer adapter (the
// exact value DialerForNode hands every protocol for an agent domain) tunnels a
// dial through the domain's connected agent to a live target.
func TestDialerFor_RoutesThroughAgent(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) { _, _ = io.Copy(c, c); c.Close() }(c)
		}
	}()

	agentConn, gwConn := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = ServeAgent(ctx, agentConn, AgentServeOptions{}) }()

	tun, err := NewGatewayTunnel(5, 3, gwConn)
	if err != nil {
		t.Fatalf("tunnel: %v", err)
	}
	defer tun.Close()
	reg := NewRegistry()
	reg.Register(tun)

	// This is exactly what DialerForNode returns for an agent-domain node.
	d := reg.DialerFor(3, "session-xyz")
	dctx, dcancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dcancel()
	conn, err := d.DialContext(dctx, "tcp", ln.Addr().String())
	if err != nil {
		t.Fatalf("dial via DialerFor: %v", err)
	}
	defer conn.Close()

	msg := []byte("via-dialer-adapter")
	if _, err := conn.Write(msg); err != nil {
		t.Fatalf("write: %v", err)
	}
	buf := make([]byte, len(msg))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(buf) != string(msg) {
		t.Fatalf("echo mismatch: %q", buf)
	}

	// A dialer for a domain with no agent surfaces ErrNoAgent at dial time.
	empty := reg.DialerFor(999, "s")
	if _, err := empty.DialContext(dctx, "tcp", "1.2.3.4:22"); err != ErrNoAgent {
		t.Fatalf("want ErrNoAgent for empty domain, got %v", err)
	}
}

func TestRegistry_UnregisterAndReplace(t *testing.T) {
	a1, _ := net.Pipe()
	t1 := &Tunnel{AgentID: 1, DomainID: 5}
	// Build a real session so IsClosed()/NumStreams() don't panic on pick().
	go func() { _, _ = yamux.Server(a1, yamuxConfig()) }()
	sess, err := yamux.Client(mustPipeClient(t), yamuxConfig())
	if err != nil {
		t.Fatalf("client: %v", err)
	}
	t1.sess = sess

	reg := NewRegistry()
	reg.Register(t1)
	if !reg.Has(1) {
		t.Fatal("agent 1 should be present")
	}
	reg.Unregister(1)
	if reg.Has(1) {
		t.Fatal("agent 1 should be gone")
	}
	if ids := reg.AgentsInDomain(5); len(ids) != 0 {
		t.Fatalf("domain 5 should be empty, got %v", ids)
	}
}

// mustPipeClient gives the client end of a pipe whose server end is drained, so
// a yamux client session can be created for registry bookkeeping tests.
func mustPipeClient(t *testing.T) net.Conn {
	t.Helper()
	c, s := net.Pipe()
	go func() { _, _ = yamux.Server(s, yamuxConfig()) }()
	return c
}
