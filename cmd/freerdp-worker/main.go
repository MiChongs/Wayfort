// freerdp-worker — Plan 17 subprocess that the gateway spawns per
// desktop session.
//
// M1 (this commit): wraps internal/desktop.DummyWorker so the full
//
//	gateway → worker → gateway → browser pipeline can be exercised
//	without libfreerdp present on the build machine. The wire protocol
//	(4-byte length-prefixed JSON frames over stdin/stdout) matches what
//	M2 will speak with the real FreeRDP-linked implementation, so the
//	gateway code does not change in M2.
//
// M2: replace the body of `run()` with a CGo-driven libfreerdp 3.x client
//
//	that produces real surface updates instead of a moving test pattern.
//	The function signature and frame protocol stay the same.
package main

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/michongs/jumpserver-anonymous/cmd/freerdp-worker/rdp"
	"github.com/michongs/jumpserver-anonymous/internal/desktop"
	"go.uber.org/zap"
)

const version = "0.1.0-freerdp-worker"

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	logger, _ := zap.NewProduction()
	defer logger.Sync()
	if err := run(logger); err != nil {
		logger.Error("freerdp-worker exited with error", zap.Error(err))
		os.Exit(1)
	}
}

func run(logger *zap.Logger) error {
	// Signal handling — clean shutdown when gateway kills us.
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	stdin := bufio.NewReaderSize(os.Stdin, 64*1024)
	stdoutMu := &sync.Mutex{}
	writeFrame := func(body []byte) error {
		stdoutMu.Lock()
		defer stdoutMu.Unlock()
		var hdr [4]byte
		binary.BigEndian.PutUint32(hdr[:], uint32(len(body)))
		if _, err := os.Stdout.Write(hdr[:]); err != nil {
			return err
		}
		_, err := os.Stdout.Write(body)
		return err
	}

	// Block reading the first frame — it must be {"type":"start", "p": ...}.
	startFrame, err := readStdioFrame(stdin)
	if err != nil {
		return fmt.Errorf("read start frame: %w", err)
	}
	var startMsg struct {
		Type string              `json:"type"`
		P    desktop.StartParams `json:"p"`
	}
	if err := json.Unmarshal(startFrame, &startMsg); err != nil {
		return fmt.Errorf("decode start frame: %w", err)
	}
	if startMsg.Type != "start" {
		return errors.New("first frame must be type=start")
	}

	// Keep stdout reserved for length-prefixed worker frames. WinPR's console
	// appender defaults may write non-error logs to stdout, which corrupts the
	// gateway protocol (the gateway then reads "[14:" as a 4-byte frame length).
	if rdp.ConfigureWLogToStderr() {
		logger.Info("libfreerdp WLog output forced to stderr")
	} else {
		logger.Warn("libfreerdp WLog stderr configuration failed")
	}

	// Force libfreerdp's WLog root to honour WLOG_LEVEL before any
	// freerdp_* call. libfreerdp documents auto-init from env via
	// WLog_GetRoot() + InitOnceExecuteOnce, but empirically (MSYS2
	// ucrt64 + cgo) that produced no DEBUG output even with the env
	// set on the subprocess by the gateway. Explicit apply is
	// deterministic; without it `desktop.debug_log: true` is dead
	// weight (the operator sees no state-machine trace, can't
	// distinguish CredSSP / MCS / capability failures).
	if lvl := os.Getenv("WLOG_LEVEL"); lvl != "" {
		if rdp.ApplyWLogLevel(lvl) {
			logger.Info("libfreerdp WLog level applied", zap.String("level", lvl))
		} else {
			logger.Warn("libfreerdp WLog level apply failed", zap.String("level", lvl))
		}
	}

	// Plan 17 M2: backend is libfreerdp via rdp.NewClient when built with
	// `-tags freerdp`; otherwise the rdp package's stub returns an error
	// the gateway forwards to the browser. The dummy worker remains as a
	// gateway-side in-process alternative for hosts without libfreerdp —
	// see internal/desktop/manager.go pickWorker().
	worker := rdp.NewClient(logger)
	workerCtx, workerCancel := context.WithCancel(ctx)
	defer workerCancel()
	if err := worker.Start(workerCtx, startMsg.P); err != nil {
		return fmt.Errorf("worker start: %w", err)
	}

	wg := &sync.WaitGroup{}
	wg.Add(2)

	// stdin → worker. Each frame is {"type":"client","msg":<ClientMessage>}.
	go func() {
		defer wg.Done()
		for {
			body, err := readStdioFrame(stdin)
			if err != nil {
				if !errors.Is(err, io.EOF) {
					logger.Warn("stdin read", zap.Error(err))
				}
				workerCancel()
				return
			}
			var env struct {
				Type string                `json:"type"`
				Msg  desktop.ClientMessage `json:"msg"`
			}
			if err := json.Unmarshal(body, &env); err != nil {
				logger.Warn("decode client frame", zap.Error(err))
				continue
			}
			switch env.Type {
			case "client":
				_ = worker.Send(env.Msg)
			case "close":
				workerCancel()
				return
			}
		}
	}()

	// worker → stdout. Hot frame/cursor payloads use the binary desktop header
	// so large pixel buffers avoid JSON/base64 before the gateway forwards them.
	go func() {
		defer wg.Done()
		for msg := range worker.Recv() {
			body, err := desktop.EncodeServerMessageBinaryPayload(msg)
			if err != nil {
				logger.Warn("encode server message", zap.Error(err))
				continue
			}
			if err := writeFrame(body); err != nil {
				return
			}
		}
	}()

	// Termination: when ctx is cancelled (SIGTERM / parent died), stdin is
	// closed, or the parent sends an explicit close envelope, close the worker
	// so the stdout pump can exit.
	<-workerCtx.Done()
	_ = worker.Close()
	// Bounded wait so a stuck worker doesn't keep us alive.
	doneCh := make(chan struct{})
	go func() { wg.Wait(); close(doneCh) }()
	select {
	case <-doneCh:
	case <-time.After(2 * time.Second):
		logger.Warn("worker did not exit cleanly within 2s")
	}
	return nil
}

func readStdioFrame(r *bufio.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 {
		return nil, errors.New("zero-length frame")
	}
	if n > 64*1024*1024 {
		return nil, fmt.Errorf("frame too big: %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, err
	}
	return buf, nil
}
