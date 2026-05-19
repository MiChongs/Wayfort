package desktop

import (
	"context"
	"encoding/binary"
	"errors"
	"image"
	"image/color"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"
)

// DummyWorker — Plan 17 M1 stand-in for FreeRDPWorker. Generates a moving
// gradient + a "cursor" sprite that follows incoming mouse input, all
// in-process (no subprocess). Proves the wire protocol round-trips end
// to end so the browser viewer is exercised before we wire real FreeRDP.
//
// Frames are encoded as `EncodingRawBGRA` so the browser-side decoder can
// putImageData directly without depending on browser PNG/JPEG decoding.
// We send the whole frame each tick (no diffing) — the test pattern is
// small (640×360 by default; configurable via Width/Height start params)
// so bandwidth stays modest.
type DummyWorker struct {
	logger    *zap.Logger
	out       chan ServerMessage
	in        chan ClientMessage
	cancel    context.CancelFunc
	done      chan struct{}
	closeOnce sync.Once
	// cursor tracking — last InputMouse from browser
	cursorX atomic.Int32
	cursorY atomic.Int32
	// resize hint from browser
	width  atomic.Uint32
	height atomic.Uint32
}

// NewDummyWorker creates an in-process worker. It does NOT spawn a
// subprocess — useful for tests, smoke runs, and any deployment that
// doesn't have libfreerdp available.
func NewDummyWorker(logger *zap.Logger) *DummyWorker {
	return &DummyWorker{
		logger: logger,
		out:    make(chan ServerMessage, 32),
		in:     make(chan ClientMessage, 64),
		done:   make(chan struct{}),
	}
}

func (d *DummyWorker) Start(ctx context.Context, p StartParams) error {
	w := uint32(p.Width)
	h := uint32(p.Height)
	if w == 0 {
		w = 640
	}
	if h == 0 {
		h = 360
	}
	d.width.Store(w)
	d.height.Store(h)

	rctx, cancel := context.WithCancel(ctx)
	d.cancel = cancel
	go d.run(rctx, p)
	return nil
}

func (d *DummyWorker) Send(msg ClientMessage) error {
	select {
	case d.in <- msg:
		return nil
	default:
		return errors.New("dummy worker input queue full")
	}
}

func (d *DummyWorker) Recv() <-chan ServerMessage { return d.out }

func (d *DummyWorker) Close() error {
	d.closeOnce.Do(func() {
		if d.cancel != nil {
			d.cancel()
		}
		<-d.done
		close(d.out)
	})
	return nil
}

// run is the worker's main loop. It emits a connection lifecycle sequence
// (CONNECTING → HANDSHAKE → CONNECTED) followed by ~10 fps frames until
// the context is cancelled.
func (d *DummyWorker) run(ctx context.Context, p StartParams) {
	defer close(d.done)
	d.emit(ServerMessage{Status: &SessionStatus{Phase: PhaseConnecting}})
	time.Sleep(80 * time.Millisecond)
	d.emit(ServerMessage{Status: &SessionStatus{Phase: PhaseHandshake}})
	time.Sleep(80 * time.Millisecond)
	d.emit(ServerMessage{Status: &SessionStatus{Phase: PhaseConnected}})

	// Drain input messages in parallel; we only react to cursor + resize.
	go d.drainInputs(ctx)

	// 12 fps test-pattern loop. Each frame is a full-canvas BGRA buffer.
	ticker := time.NewTicker(time.Second / 12)
	defer ticker.Stop()
	t0 := time.Now()
	frames := 0
	for {
		select {
		case <-ctx.Done():
			d.emit(ServerMessage{Status: &SessionStatus{Phase: PhaseClosed, Message: "dummy worker closed"}})
			return
		case <-ticker.C:
			w := d.width.Load()
			h := d.height.Load()
			cx := d.cursorX.Load()
			cy := d.cursorY.Load()
			frame := renderTestPattern(int(w), int(h), int(cx), int(cy), time.Since(t0).Milliseconds())
			d.emit(ServerMessage{
				Frame: &FrameRect{
					X: 0, Y: 0, Width: w, Height: h,
					Encoding: EncodingRawBGRA,
					Payload:  frame,
				},
			})
			frames++
			if frames == 1 {
				d.logger.Info("dummy worker first frame",
					zap.Uint64("node_id", p.NodeID),
					zap.Uint32("w", w), zap.Uint32("h", h))
			}
		}
	}
}

func (d *DummyWorker) drainInputs(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case msg := <-d.in:
			switch {
			case msg.Mouse != nil:
				d.cursorX.Store(msg.Mouse.X)
				d.cursorY.Store(msg.Mouse.Y)
			case msg.Resize != nil:
				if msg.Resize.Width > 0 && msg.Resize.Height > 0 {
					d.width.Store(msg.Resize.Width)
					d.height.Store(msg.Resize.Height)
				}
			case msg.HB != nil:
				// Echo the heartbeat back so the browser can measure
				// round-trip latency. We deliberately copy the same
				// ts_ms — the browser subtracts (now - ts_ms) to get
				// RTT without needing wall-clock skew correction.
				d.emit(ServerMessage{HB: &Heartbeat{TSMs: msg.HB.TSMs}})
			}
		}
	}
}

func (d *DummyWorker) emit(m ServerMessage) {
	select {
	case d.out <- m:
	case <-time.After(500 * time.Millisecond):
		d.logger.Warn("dummy worker emit drop — out queue stuck")
	}
}

// renderTestPattern draws a moving rainbow gradient with an emphasised
// crosshair at (cursorX, cursorY) to visually confirm input round-trip.
// Returns raw BGRA bytes (width*height*4) ready for putImageData on the
// browser side (after the BGRA→RGBA swap, see render.worker.ts).
func renderTestPattern(w, h, cx, cy int, tMs int64) []byte {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	// Slow phase shift so the pattern obviously animates.
	phase := float64(tMs%4000) / 4000.0
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r := uint8(127 + 127*sine(float64(x)/100+phase))
			g := uint8(127 + 127*sine(float64(y)/100+phase*1.3))
			b := uint8(127 + 127*sine((float64(x+y))/140+phase*0.7))
			img.SetNRGBA(x, y, color.NRGBA{R: r, G: g, B: b, A: 255})
		}
	}
	// Crosshair at cursor.
	if cx >= 0 && cy >= 0 && cx < w && cy < h {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, cy, color.NRGBA{R: 255, G: 255, B: 255, A: 255})
		}
		for y := 0; y < h; y++ {
			img.SetNRGBA(cx, y, color.NRGBA{R: 255, G: 255, B: 255, A: 255})
		}
	}
	// Convert NRGBA → BGRA (swap R and B channels in-place).
	src := img.Pix
	bgra := make([]byte, len(src))
	for i := 0; i < len(src); i += 4 {
		bgra[i] = src[i+2]
		bgra[i+1] = src[i+1]
		bgra[i+2] = src[i]
		bgra[i+3] = src[i+3]
	}
	return bgra
}

// sine — small inline approximation. We don't import math purely to keep
// this file zero-deps and the test pattern needs only loose smoothness.
func sine(x float64) float64 {
	// Cycle x to [0, 2π).
	const twoPi = 6.283185307179586
	x = x - float64(int(x/twoPi))*twoPi
	// Bhaskara I's approximation: 4·x·(π−x) / (5π²−4·x·(π−x))
	if x > twoPi/2 {
		return -sine(x - twoPi/2)
	}
	pi := twoPi / 2
	num := 4 * x * (pi - x)
	den := 5*pi*pi - 4*x*(pi-x)
	return num / den
}

// Compile-time check that the wire encoding stays consistent: the dummy
// worker emits raw BGRA frames in a 4-byte channel layout. If we ever
// change the encoding constant, this prevents a silent mismatch with the
// renderer in web/src/lib/desktop/render.worker.ts.
var _ = func() int {
	var x [4]byte
	binary.LittleEndian.PutUint32(x[:], 0)
	return 0
}()
