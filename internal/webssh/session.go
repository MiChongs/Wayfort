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
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"go.uber.org/zap"
	"golang.org/x/sync/errgroup"
)

// Backend abstracts the remote side of the WebSocket so this file works for
// both an SSH ssh.Session and a Docker exec hijacked stream.
type Backend interface {
	io.Reader            // stdout/stderr merged
	io.Writer            // stdin
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
}

func (s *Session) OnCommand(fn func(string)) { s.onCommand = fn }

func (s *Session) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	g, gctx := errgroup.WithContext(ctx)
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
		g.Go(func() error { return s.heartbeat(gctx) })
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

func (s *Session) heartbeat(ctx context.Context) error {
	t := time.NewTicker(s.Cfg.PingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			if err := s.Conn.Ping(ctx); err != nil {
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
