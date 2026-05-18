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
	mu         sync.Mutex // guards writes to stdin
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
		out:        make(chan ServerMessage, 64),
		done:       make(chan struct{}),
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
	// child's env is enough to enable DEBUG / TRACE logging without any
	// cgo bridge from our side. When debugLog is false we inherit the
	// gateway's env unchanged (default level INFO).
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
	w.mu.Lock()
	defer w.mu.Unlock()
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
		if w.stdin != nil {
			_ = w.stdin.Close()
		}
		if w.cmd != nil && w.cmd.Process != nil {
			// Give the worker a moment to flush; then kill.
			done := make(chan struct{})
			go func() { _ = w.cmd.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				_ = w.cmd.Process.Kill()
			}
		}
		<-w.done
		close(w.out)
	})
	return nil
}

// pumpStdout reads framed JSON ServerMessages from the worker and forwards
// them onto the out channel.
func (w *FreeRDPWorker) pumpStdout() {
	br := bufio.NewReaderSize(w.stdout, 128*1024)
	for {
		body, err := readFrame(br)
		if err != nil {
			if !errors.Is(err, io.EOF) {
				w.logger.Warn("freerdp worker stdout read", zap.Error(err))
			}
			return
		}
		msg, err := jsonDecode[ServerMessage](body)
		if err != nil {
			w.logger.Warn("freerdp worker stdout decode", zap.Error(err))
			continue
		}
		select {
		case w.out <- msg:
		case <-time.After(500 * time.Millisecond):
			w.logger.Warn("freerdp worker out queue stuck — dropping")
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
	close(w.done)
	// Surface a Closed/Error status to consumers so the WS handler can
	// drop the browser connection cleanly.
	status := SessionStatus{Phase: PhaseClosed}
	if err != nil {
		status.Phase = PhaseError
		status.Message = err.Error()
	}
	select {
	case w.out <- ServerMessage{Status: &status}:
	default:
	}
}
