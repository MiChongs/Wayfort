package audit

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"github.com/michongs/wayfort/internal/config"
	"go.uber.org/zap"
)

// Recorder writes an asciinema v2 cast file. It is non-blocking: chunks beyond
// chan capacity are dropped and replaced by a "marker" frame so the player
// shows a gap rather than waiting on the SSH pump.
type Recorder struct {
	id     string
	path   string
	cfg    config.RecorderConfig
	logger *zap.Logger

	start    time.Time
	frames   chan frame
	resizes  chan resize
	dropped  atomic.Uint64
	done     chan struct{}
	notified atomic.Bool
}

type frame struct {
	at   time.Duration
	stream string
	data []byte
}

type resize struct {
	at   time.Duration
	cols int
	rows int
}

// NewRecorder allocates a cast file under sessions_dir/yyyy-mm-dd/.
func NewRecorder(sessionID string, sessionsDir string, cfg config.RecorderConfig, cols, rows int, logger *zap.Logger) (*Recorder, error) {
	if cfg.ChanSize <= 0 {
		cfg.ChanSize = 1024
	}
	if cfg.FlushInterval <= 0 {
		cfg.FlushInterval = 250 * time.Millisecond
	}
	day := time.Now().Format("2006-01-02")
	dir := filepath.Join(sessionsDir, day)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, sessionID+".cast")
	r := &Recorder{
		id:      sessionID,
		path:    path,
		cfg:     cfg,
		logger:  logger,
		start:   time.Now(),
		frames:  make(chan frame, cfg.ChanSize),
		resizes: make(chan resize, 32),
		done:    make(chan struct{}),
	}
	header := map[string]any{
		"version":   2,
		"width":     cols,
		"height":    rows,
		"timestamp": r.start.Unix(),
		"title":     sessionID,
		"env":       map[string]string{"TERM": "xterm-256color"},
	}
	hb, _ := json.Marshal(header)
	if err := os.WriteFile(path, append(hb, '\n'), 0o640); err != nil {
		return nil, err
	}
	return r, nil
}

func (r *Recorder) Path() string { return r.path }

// WriteOutput records a chunk that came from the remote terminal towards the
// browser. Never blocks.
func (r *Recorder) WriteOutput(b []byte) {
	r.write("o", b)
}

// WriteInput records a chunk typed by the user. Recording input is optional and
// can be disabled by callers when only output is desired.
func (r *Recorder) WriteInput(b []byte) {
	r.write("i", b)
}

func (r *Recorder) write(stream string, b []byte) {
	if len(b) == 0 {
		return
	}
	cp := make([]byte, len(b))
	copy(cp, b)
	select {
	case r.frames <- frame{at: time.Since(r.start), stream: stream, data: cp}:
	default:
		r.dropped.Add(1)
	}
}

// Resize records a terminal size change as a synthetic "r" event.
func (r *Recorder) Resize(cols, rows int) {
	select {
	case r.resizes <- resize{at: time.Since(r.start), cols: cols, rows: rows}:
	default:
		r.dropped.Add(1)
	}
}

// Run blocks until ctx is canceled or Close is called. It owns the cast file
// for the duration.
func (r *Recorder) Run(ctx context.Context) error {
	f, err := os.OpenFile(r.path, os.O_APPEND|os.O_WRONLY, 0o640)
	if err != nil {
		return err
	}
	defer f.Close()
	bw := bufio.NewWriterSize(f, 64*1024)
	defer bw.Flush()
	flush := time.NewTicker(r.cfg.FlushInterval)
	defer flush.Stop()
	enc := json.NewEncoder(bw)

	emit := func(seconds float64, kind string, data any) {
		_ = enc.Encode([]any{seconds, kind, data})
	}
	emitDrops := func() {
		if d := r.dropped.Swap(0); d > 0 {
			emit(time.Since(r.start).Seconds(), "m", fmt.Sprintf("lossy:%d", d))
		}
	}

	for {
		select {
		case <-ctx.Done():
			r.drain(emit)
			emitDrops()
			close(r.done)
			return ctx.Err()
		case fr, ok := <-r.frames:
			if !ok {
				r.drain(emit)
				emitDrops()
				close(r.done)
				return nil
			}
			emit(fr.at.Seconds(), fr.stream, string(fr.data))
		case rs := <-r.resizes:
			emit(rs.at.Seconds(), "r", fmt.Sprintf("%dx%d", rs.cols, rs.rows))
		case <-flush.C:
			emitDrops()
			_ = bw.Flush()
		}
	}
}

func (r *Recorder) drain(emit func(float64, string, any)) {
	for {
		select {
		case fr, ok := <-r.frames:
			if !ok {
				r.frames = nil
				continue
			}
			emit(fr.at.Seconds(), fr.stream, string(fr.data))
		case rs, ok := <-r.resizes:
			if !ok {
				r.resizes = nil
				continue
			}
			emit(rs.at.Seconds(), "r", fmt.Sprintf("%dx%d", rs.cols, rs.rows))
		default:
			return
		}
	}
}

// Close signals the recorder to flush and exit. Safe to call multiple times.
func (r *Recorder) Close() {
	if r.notified.CompareAndSwap(false, true) {
		close(r.frames)
	}
}

// Wait blocks until Run has fully exited (post-Close).
func (r *Recorder) Wait() { <-r.done }
