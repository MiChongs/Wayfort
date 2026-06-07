package desktop

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// FreeRDPWorker — Plan 17 subprocess driver. Spawns `freerdp-worker`,
// writes/reads length-prefixed JSON frames over stdio. In M1 the worker
// binary contains a stub that delegates to DummyWorker; M2 replaces the
// inside of cmd/freerdp-worker with libfreerdp 3.x via CGo.
//
// Decoupling layout: this file never imports anything from cgo; the
// subprocess is just an opaque external program. That means everything
// in internal/desktop/ keeps compiling on machines without libfreerdp —
// only `go build ./cmd/freerdp-worker` will refuse there.
type FreeRDPWorker struct {
	logger     *zap.Logger
	workerPath string
	debugLog   bool
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	stdout     io.ReadCloser
	stderr     io.ReadCloser
	out        chan ServerMessage
	closeOnce  sync.Once
	done       chan struct{}
	// pumpDone is closed when pumpStdout has fully returned. Close waits on
	// it before close(out) so a frame in flight on the pumpStdout select can
	// never be sent on a closed channel (which would panic the whole gateway
	// process and tear down every concurrent session).
	pumpDone chan struct{}
	closing  atomic.Bool
	mu       sync.Mutex // guards writes to stdin
}

// WorkerOption tweaks NewFreeRDPWorker without exploding the constructor's
// arg list when we add more diagnostics knobs.
type WorkerOption func(*FreeRDPWorker)

// WithDebugLog injects WLOG_LEVEL=DEBUG into the worker process env so
// libfreerdp emits its full state-machine trace via stderr.
func WithDebugLog(enabled bool) WorkerOption {
	return func(w *FreeRDPWorker) { w.debugLog = enabled }
}

func NewFreeRDPWorker(logger *zap.Logger, workerPath string, opts ...WorkerOption) *FreeRDPWorker {
	w := &FreeRDPWorker{
		logger:     logger,
		workerPath: workerPath,
		out:        make(chan ServerMessage, 256),
		done:       make(chan struct{}),
		pumpDone:   make(chan struct{}),
	}
	for _, opt := range opts {
		opt(w)
	}
	return w
}

func (w *FreeRDPWorker) Start(ctx context.Context, p StartParams) error {
	if w.workerPath == "" {
		return errors.New("freerdp worker path not configured")
	}
	w.cmd = exec.CommandContext(ctx, w.workerPath)
	// libfreerdp reads WLOG_LEVEL natively at WLog init; setting it on the
	// child's env is enough to enable DEBUG / TRACE logging without any cgo
	// bridge from our side. (The rdpdr + drive channels are always bumped to
	// DEBUG by the worker itself via EnableChannelDebug, since env-based
	// WLOG_FILTER is ignored on the MSYS2 build.) When debugLog is false we
	// inherit the gateway's env unchanged (default level INFO).
	if w.debugLog {
		w.cmd.Env = append(os.Environ(), "WLOG_LEVEL=DEBUG")
	}
	stdin, err := w.cmd.StdinPipe()
	if err != nil {
		return fmt.Errorf("stdin pipe: %w", err)
	}
	stdout, err := w.cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	stderr, err := w.cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("stderr pipe: %w", err)
	}
	w.stdin = stdin
	w.stdout = stdout
	w.stderr = stderr
	if err := w.cmd.Start(); err != nil {
		return fmt.Errorf("spawn freerdp-worker: %w", err)
	}
	// 1. Send the start request as the first stdio frame so the worker
	//    knows what to connect to.
	body, _ := jsonEncode(struct {
		Type string      `json:"type"`
		P    StartParams `json:"p"`
	}{Type: "start", P: p})
	if err := writeFrame(w.stdin, body); err != nil {
		_ = w.cmd.Process.Kill()
		return fmt.Errorf("write start frame: %w", err)
	}
	// 2. Forward stderr → zap so subprocess panics / errors are visible.
	go w.forwardStderr()
	// 3. Pull events off stdout and translate into ServerMessage on out.
	go w.pumpStdout()
	// 4. When the process exits, surface that as PhaseClosed.
	go w.watchProcess()
	return nil
}

func (w *FreeRDPWorker) Send(msg ClientMessage) error {
	if w.closing.Load() {
		return errors.New("worker closing")
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closing.Load() {
		return errors.New("worker closing")
	}
	if w.stdin == nil {
		return errors.New("worker not started")
	}
	body, err := jsonEncode(struct {
		Type string        `json:"type"`
		Msg  ClientMessage `json:"msg"`
	}{Type: "client", Msg: msg})
	if err != nil {
		return err
	}
	// Stdio writes can block if the subprocess is slow; protect with a
	// generous deadline (Worker is supposed to drain quickly).
	return writeFrame(w.stdin, body)
}

func (w *FreeRDPWorker) Recv() <-chan ServerMessage { return w.out }

func (w *FreeRDPWorker) Close() error {
	w.closeOnce.Do(func() {
		w.closing.Store(true)
		w.sendCloseFrameWithTimeout()
		if w.stdin != nil {
			_ = w.stdin.Close()
		}
		if w.cmd != nil && w.cmd.Process != nil {
			// Give the worker a moment to flush; then kill. watchProcess owns
			// cmd.Wait, so Close waits on w.done instead of calling Wait again.
			select {
			case <-w.done:
			case <-time.After(2 * time.Second):
				_ = w.cmd.Process.Kill()
				<-w.done
			}
		} else {
			<-w.done
		}
		// w.done is closed (process reaped). pumpStdout, once w.done is
		// closed, can always unblock its select on the <-w.done case and
		// return; wait for it so no send on w.out is in flight when we close
		// the channel. The timeout is a defensive backstop for the case where
		// the pump goroutine was never started (Start failed before launching
		// it) — pumpDone stays open there but no sender exists, so closing is
		// safe regardless.
		select {
		case <-w.pumpDone:
		case <-time.After(2 * time.Second):
		}
		close(w.out)
	})
	return nil
}

func (w *FreeRDPWorker) sendCloseFrameWithTimeout() {
	if w.stdin == nil {
		return
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.mu.Lock()
		defer w.mu.Unlock()
		body, err := jsonEncode(struct {
			Type string `json:"type"`
		}{Type: "close"})
		if err == nil {
			_ = writeFrame(w.stdin, body)
		}
	}()
	select {
	case <-done:
	case <-time.After(250 * time.Millisecond):
		w.logger.Warn("freerdp worker close frame write timed out")
	}
}

// pumpStdout reads framed ServerMessages from the worker and forwards them
// onto the out channel. Hot frame/cursor payloads use the same binary header
// as the browser WS hop so raw pixels never need JSON/base64 on stdout.
func (w *FreeRDPWorker) pumpStdout() {
	defer close(w.pumpDone)
	br := bufio.NewReaderSize(w.stdout, 128*1024)
	for {
		body, err := readFrame(br)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				w.logger.Warn("freerdp worker stdout read", zap.Error(err))
				// A non-EOF read error (e.g. an oversize frame that trips the
				// 64 MB framing cap, or a corrupt length prefix) otherwise ends
				// the pump silently — the browser keeps showing "connected" on a
				// frozen screen. Surface it as a terminal error so the WS layer
				// tears the session down with a real reason. Guarded by w.done
				// so this never blocks shutdown.
				select {
				case w.out <- ServerMessage{Status: &SessionStatus{
					Phase:   PhaseError,
					Message: "桌面数据流中断: " + err.Error(),
				}}:
				case <-w.done:
				}
			}
			return
		}
		msg, binaryPayload, err := DecodeServerMessageBinaryPayload(body)
		if err != nil {
			w.logger.Warn("freerdp worker stdout binary decode", zap.Error(err))
			continue
		}
		if !binaryPayload {
			msg, err = jsonDecode[ServerMessage](body)
			if err != nil {
				w.logger.Warn("freerdp worker stdout decode", zap.Error(err))
				continue
			}
		}
		select {
		case w.out <- msg:
		case <-w.done:
			return
		}
	}
}

func (w *FreeRDPWorker) forwardStderr() {
	sc := bufio.NewScanner(w.stderr)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		w.logger.Info("freerdp-worker stderr", zap.String("line", sc.Text()))
	}
}

func (w *FreeRDPWorker) watchProcess() {
	if w.cmd == nil {
		close(w.done)
		return
	}
	err := w.cmd.Wait()
	// Surface a Closed/Error status to consumers so the WS handler can
	// drop the browser connection cleanly.
	status := SessionStatus{Phase: PhaseClosed}
	if err != nil {
		status.Phase = PhaseError
		status.Message = err.Error()
	}
	// Deliver the terminal status best-effort but bounded: a non-blocking
	// send used to silently drop CLOSED/ERROR when the out buffer was full,
	// leaving the browser with a generic disconnect instead of the real
	// reason (auth failed, cert rejected, …). Give the WS drain up to 1s to
	// take it; log if it still can't be delivered.
	select {
	case w.out <- ServerMessage{Status: &status}:
	case <-time.After(time.Second):
		w.logger.Warn("freerdp worker terminal status dropped (out channel full)",
			zap.String("phase", string(status.Phase)),
			zap.String("message", status.Message))
	}
	close(w.done)
}
