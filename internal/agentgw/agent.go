package agentgw

import (
	"context"
	"io"
	"net"
	"sync"
	"time"

	"github.com/hashicorp/yamux"
)

// DialFunc opens a connection to a target inside the agent's network. The
// default is a plain net.Dialer; tests inject a fake. The agent is a dumb pipe —
// it dials exactly what the gateway's OPEN frame asks for and nothing else.
type DialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// AgentServeOptions tunes the agent's stream handling.
type AgentServeOptions struct {
	// Dial overrides the target dialer (default: net.Dialer).
	Dial DialFunc
	// MaxStreams caps concurrent in-flight streams; 0 = 256. Excess streams are
	// rejected with an ACK error so a buggy/hostile gateway can't exhaust the
	// agent host's file descriptors.
	MaxStreams int
	// DialTimeout bounds each target dial when the OPEN frame carries no
	// deadline; 0 = 30s.
	DialTimeout time.Duration
}

// ServeAgent runs the AGENT side of the tunnel over conn: a yamux server that
// accepts streams, reads each OPEN frame, dials the requested target, ACKs, and
// bidirectionally copies bytes. It blocks until the session ends or ctx is
// cancelled. This is the counterpart to the gateway's Tunnel.DialTarget.
func ServeAgent(ctx context.Context, conn net.Conn, opts AgentServeOptions) error {
	dial := opts.Dial
	if dial == nil {
		var d net.Dialer
		dial = d.DialContext
	}
	maxStreams := opts.MaxStreams
	if maxStreams <= 0 {
		maxStreams = 256
	}
	dialTO := opts.DialTimeout
	if dialTO <= 0 {
		dialTO = 30 * time.Second
	}

	sess, err := yamux.Server(conn, yamuxConfig())
	if err != nil {
		return err
	}
	defer sess.Close()

	// Tear the session down when the caller's ctx ends.
	go func() {
		select {
		case <-ctx.Done():
			_ = sess.Close()
		case <-sess.CloseChan():
		}
	}()

	sem := make(chan struct{}, maxStreams)
	var wg sync.WaitGroup
	for {
		stream, err := sess.AcceptStream()
		if err != nil {
			wg.Wait()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		}
		select {
		case sem <- struct{}{}:
		default:
			// At capacity — refuse politely and drop the stream.
			_ = writeFrame(stream, AckFrame{OK: false, Error: "agent at stream capacity"})
			_ = stream.Close()
			continue
		}
		wg.Add(1)
		go func(s *yamux.Stream) {
			defer wg.Done()
			defer func() { <-sem }()
			handleStream(ctx, s, dial, dialTO)
		}(stream)
	}
}

// handleStream services one multiplexed stream: OPEN → dial → ACK → splice.
func handleStream(ctx context.Context, stream *yamux.Stream, dial DialFunc, dialTO time.Duration) {
	defer stream.Close()

	// Bound the control handshake read so a silent gateway can't pin the stream.
	_ = stream.SetReadDeadline(time.Now().Add(15 * time.Second))
	var open OpenFrame
	if err := readFrame(stream, &open); err != nil {
		return
	}
	_ = stream.SetReadDeadline(time.Time{})

	network := open.Network
	if network == "" {
		network = "tcp"
	}
	dctx := ctx
	if open.DeadlineMS > 0 {
		var cancel context.CancelFunc
		dctx, cancel = context.WithTimeout(ctx, time.Duration(open.DeadlineMS)*time.Millisecond)
		defer cancel()
	} else {
		var cancel context.CancelFunc
		dctx, cancel = context.WithTimeout(ctx, dialTO)
		defer cancel()
	}

	target, err := dial(dctx, network, open.Target)
	if err != nil {
		_ = writeFrame(stream, AckFrame{OK: false, Error: err.Error()})
		return
	}
	defer target.Close()

	if err := writeFrame(stream, AckFrame{OK: true}); err != nil {
		return
	}

	// Splice the stream and the target until either side ends.
	splice(stream, target)
}

// splice copies bytes both directions and returns once either copy finishes,
// closing both ends so the partner copy unblocks.
func splice(a, b io.ReadWriteCloser) {
	done := make(chan struct{}, 2)
	cp := func(dst io.WriteCloser, src io.Reader) {
		_, _ = io.Copy(dst, src)
		done <- struct{}{}
	}
	go cp(a, b)
	go cp(b, a)
	<-done
	_ = a.Close()
	_ = b.Close()
	<-done
}
