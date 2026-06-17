package webssh

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/config"
	"github.com/michongs/wayfort/internal/latency"
	"github.com/michongs/wayfort/internal/livewatch"
	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"
)

// Backend abstracts the remote side of the WebSocket so this file works for
// both an SSH ssh.Session and a Docker exec hijacked stream.
type Backend interface {
	io.Reader // stdout/stderr merged
	io.Writer // stdin
	Resize(cols, rows uint32) error
	Close() error
}

// Session ties a *websocket.Conn to a Backend with three goroutines:
//   - WS reader → backend.Write
//   - backend.Read → WS writer
//   - Recorder writer (managed inside Recorder.Run)
// All three exit cleanly when ctx is canceled or any of them fails.
type Session struct {
	ID        string
	Conn      *websocket.Conn
	Backend   Backend
	Recorder  *audit.Recorder
	Cfg       config.WebSSHConfig
	Logger    *zap.Logger
	BytesIn   atomic.Uint64
	BytesOut  atomic.Uint64
	onCommand func(string) // optional command tracker for audit
	// OnLatency, when set, receives the dual-path latency snapshots produced by
	// the prober on each tick (server = gateway↔target, client = browser↔gateway)
	// — feeds the connection-quality metric sink.
	OnLatency func(server, client latency.Stats)
	// ServerPing, when set, measures the gateway↔target RTT (SSH keepalive). Nil
	// for backends with no measurable server hop (anonymous container, telnet).
	ServerPing func(ctx context.Context) (time.Duration, error)
	// LiveHub, when set, mirrors this session's output to read-only observers.
	// All Hub methods are nil-safe, so the tee is free when monitoring is off.
	LiveHub *livewatch.Hub
}

func (s *Session) OnCommand(fn func(string)) { s.onCommand = fn }

func (s *Session) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Register for read-only monitoring for the lifetime of the session.
	if s.LiveHub != nil {
		s.LiveHub.EnsureSession(s.ID, livewatch.ModeTerminal)
		defer s.LiveHub.CloseSession(s.ID)
	}

	g, gctx := errgroup.WithContext(ctx)
	// Teardown unblock: the moment any goroutine exits (browser closed the WS,
	// an error, an admin force-off, or a dead-connection ping failure), close
	// the backend. Without this, pumpBackendToWS stays blocked on a quiet SSH
	// stdout Read — ctx cancellation can't interrupt it — so g.Wait() never
	// returns and the row lingers forever as a phantom "active" session. Closing
	// stdin+session makes that Read return EOF and the session tears down
	// promptly. Idempotent with the Close() after g.Wait().
	context.AfterFunc(gctx, func() { _ = s.Backend.Close() })
	// Recorder lives the lifetime of the session.
	if s.Recorder != nil {
		g.Go(func() error {
			err := s.Recorder.Run(gctx)
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		})
	}
	g.Go(func() error { return s.pumpWSToBackend(gctx) })
	g.Go(func() error { return s.pumpBackendToWS(gctx) })
	if s.Cfg.PingInterval > 0 {
		g.Go(func() error { return s.probe(gctx) })
	}

	_ = s.sendFrame(Frame{T: TReady})
	err := g.Wait()
	if s.Recorder != nil {
		s.Recorder.Close()
		s.Recorder.Wait()
	}
	_ = s.Backend.Close()
	if errors.Is(err, context.Canceled) || errors.Is(err, io.EOF) {
		return nil
	}
	return err
}

func (s *Session) pumpWSToBackend(ctx context.Context) error {
	for {
		typ, data, err := s.Conn.Read(ctx)
		if err != nil {
			return err
		}
		if typ != websocket.MessageText {
			continue
		}
		var f Frame
		if err := json.Unmarshal(data, &f); err != nil {
			_ = s.sendFrame(Frame{T: TError, Msg: "bad frame: " + err.Error()})
			continue
		}
		switch f.T {
		case TInput:
			payload, err := base64.StdEncoding.DecodeString(f.Data)
			if err != nil {
				_ = s.sendFrame(Frame{T: TError, Msg: "bad base64"})
				continue
			}
			if _, err := s.Backend.Write(payload); err != nil {
				return err
			}
			s.BytesIn.Add(uint64(len(payload)))
			if s.onCommand != nil {
				// Best-effort: line-buffered command tracker. Caller handles
				// command boundary detection.
				s.onCommand(string(payload))
			}
		case TResize:
			if f.Cols > 0 && f.Rows > 0 {
				_ = s.Backend.Resize(uint32(f.Cols), uint32(f.Rows))
				if s.Recorder != nil {
					s.Recorder.Resize(f.Cols, f.Rows)
				}
				if s.LiveHub != nil {
					s.LiveHub.Publish(s.ID, livewatch.Frame{Kind: livewatch.KindResize, Cols: f.Cols, Rows: f.Rows})
				}
			}
		case TPing:
			_ = s.sendFrame(Frame{T: TPong})
		case TClose:
			return io.EOF
		}
	}
}

func (s *Session) pumpBackendToWS(ctx context.Context) error {
	buf := make([]byte, s.Cfg.ReadBuffer)
	if len(buf) == 0 {
		buf = make([]byte, 8192)
	}
	for {
		n, err := s.Backend.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			if s.Recorder != nil {
				s.Recorder.WriteOutput(chunk)
			}
			// Mirror to read-only observers off the same bytes. Copy because the
			// shared buf is overwritten on the next Read; the Hub holds the slice.
			if s.LiveHub != nil {
				cp := make([]byte, n)
				copy(cp, chunk)
				s.LiveHub.Publish(s.ID, livewatch.Frame{Kind: livewatch.KindOutput, Data: cp})
			}
			s.BytesOut.Add(uint64(n))
			if werr := s.sendFrame(Frame{T: TOutput, Data: base64.StdEncoding.EncodeToString(chunk)}); werr != nil {
				return werr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				_ = s.sendFrame(Frame{T: TClose, Msg: "remote closed"})
				return io.EOF
			}
			return err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
}

// probeInterval is the latency-probe cadence. It is capped at 5s for a dense
// RTT curve and fast dead-connection detection, but honours a smaller configured
// keepalive interval. The WS ping doubles as the keepalive.
const probeInterval = 5 * time.Second

func (s *Session) probeEvery() time.Duration {
	if s.Cfg.PingInterval > 0 && s.Cfg.PingInterval < probeInterval {
		return s.Cfg.PingInterval
	}
	return probeInterval
}

// probe runs the dual-path latency prober: every tick it measures the
// client↔gateway RTT via a WebSocket ping (which also keeps the connection alive
// and detects a dead browser) and, when ServerPing is set, the gateway↔target
// RTT via an SSH keepalive. Both feed HdrHistogram/EWMA trackers; the smoothed
// snapshots are pushed to the metric sink. RTT is timed in microseconds and the
// tracker floors it at 1ms so a sub-ms LAN/loopback hop never reads as 0.
//
// A failed client ping is fatal (the browser is gone → tear the session down); a
// failed server ping is only counted as loss — a momentarily slow target must
// not kill an otherwise-healthy session.
func (s *Session) probe(ctx context.Context) error {
	interval := s.probeEvery()
	client := latency.New()
	var server *latency.Tracker
	if s.ServerPing != nil {
		server = latency.New()
	}

	tick := func() error {
		// client↔gateway via WS ping (bounded so a half-open TCP is detected
		// within one interval instead of waiting for the OS TCP timeout).
		start := time.Now()
		pctx, pcancel := context.WithTimeout(ctx, interval)
		err := s.Conn.Ping(pctx)
		pcancel()
		if err != nil {
			client.ObserveTimeout()
			return err
		}
		client.Observe(time.Since(start))

		// gateway↔target via SSH keepalive (best-effort).
		if server != nil {
			sctx, scancel := context.WithTimeout(ctx, interval)
			d, serr := s.ServerPing(sctx)
			scancel()
			if serr != nil {
				server.ObserveTimeout()
			} else {
				server.Observe(d)
			}
		}

		if s.OnLatency != nil {
			var ss latency.Stats
			if server != nil {
				ss = server.Snapshot()
			}
			s.OnLatency(ss, client.Snapshot())
		}
		return nil
	}

	// One immediate probe so latency is populated from the very first sample.
	if err := tick(); err != nil {
		return err
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if err := tick(); err != nil {
				return err
			}
		}
	}
}

func (s *Session) sendFrame(f Frame) error {
	b, err := json.Marshal(f)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), s.Cfg.WriteTimeout)
	defer cancel()
	return s.Conn.Write(ctx, websocket.MessageText, b)
}
