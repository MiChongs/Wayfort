// Package livewatch fans an in-progress session's output stream to zero or more
// read-only observers ("over-the-shoulder" monitoring). It reuses the same
// bytes the recorder already tees off the live path, so publishing costs the
// main session only one non-blocking channel send per observer — a slow or
// stuck observer is dropped, never back-pressured onto the user being watched.
//
// Transport-agnostic: a Frame is opaque bytes plus a small discriminator.
// Terminal sessions publish raw PTY output (+ resize); desktop sessions publish
// desktop.v2 binary server messages. The observe WS handlers translate Frames
// into each protocol's wire format.
package livewatch

import (
	"sync"
	"sync/atomic"
)

// Mode selects per-session behaviour — chiefly whether the hub keeps a terminal
// scrollback baseline so a mid-stream observer can be fast-forwarded to the
// current screen.
type Mode uint8

const (
	ModeTerminal Mode = iota
	ModeDesktop
)

// FrameKind discriminates the payload carried by a Frame.
type FrameKind uint8

const (
	KindOutput FrameKind = iota // PTY output bytes / desktop binary message
	KindResize                  // terminal resize (Cols/Rows set, Data empty)
)

// Frame is one unit broadcast to observers.
type Frame struct {
	Kind       FrameKind
	Data       []byte
	Cols, Rows int
}

// scrollbackCap bounds the per-session terminal baseline. xterm.js rebuilds the
// current screen by replaying these raw bytes, so a few tens of KB is plenty.
const scrollbackCap = 64 * 1024

// Observer is one subscriber's bounded queue. Frames() is drained by the observe
// WS handler; Dropped() reports frames shed under backpressure.
type Observer struct {
	ch      chan Frame
	dropped atomic.Uint64
}

func (o *Observer) Frames() <-chan Frame { return o.ch }
func (o *Observer) Dropped() uint64      { return o.dropped.Load() }

// Baseline is the "fast-forward to current screen" snapshot handed to a new
// terminal observer: replay Scrollback after a resize to Cols×Rows. nil for
// desktop sessions (those request a full repaint from the worker instead).
type Baseline struct {
	Scrollback []byte
	Cols, Rows int
}

type fan struct {
	mu         sync.Mutex
	mode       Mode
	observers  map[uint64]*Observer
	nextID     uint64
	scroll     []byte
	cols, rows int
	closed     bool
}

// Hub owns every monitored session in this process.
type Hub struct {
	mu       sync.RWMutex
	sessions map[string]*fan
}

func NewHub() *Hub { return &Hub{sessions: map[string]*fan{}} }

// EnsureSession registers a session so Publish takes effect. Idempotent; called
// when the session's run loop starts.
func (h *Hub) EnsureSession(id string, mode Mode) {
	if h == nil {
		return
	}
	h.mu.Lock()
	if _, ok := h.sessions[id]; !ok {
		h.sessions[id] = &fan{mode: mode, observers: map[uint64]*Observer{}}
	}
	h.mu.Unlock()
}

// CloseSession ends monitoring: every observer channel is closed (their handlers
// see EOF and report "session ended") and the session is forgotten. Idempotent.
func (h *Hub) CloseSession(id string) {
	if h == nil {
		return
	}
	h.mu.Lock()
	f := h.sessions[id]
	delete(h.sessions, id)
	h.mu.Unlock()
	if f == nil {
		return
	}
	f.mu.Lock()
	f.closed = true
	for _, ob := range f.observers {
		close(ob.ch)
	}
	f.observers = map[uint64]*Observer{}
	f.mu.Unlock()
}

// Publish broadcasts a frame to the session's observers. Cheap (one map read)
// when nobody is watching. Never blocks the caller: a full observer queue drops
// the frame and bumps that observer's drop counter.
func (h *Hub) Publish(id string, fr Frame) {
	if h == nil {
		return
	}
	h.mu.RLock()
	f := h.sessions[id]
	h.mu.RUnlock()
	if f == nil {
		return
	}
	f.mu.Lock()
	if f.mode == ModeTerminal {
		switch fr.Kind {
		case KindOutput:
			f.scroll = append(f.scroll, fr.Data...)
			if len(f.scroll) > scrollbackCap {
				f.scroll = f.scroll[len(f.scroll)-scrollbackCap:]
			}
		case KindResize:
			f.cols, f.rows = fr.Cols, fr.Rows
		}
	}
	for _, ob := range f.observers {
		select {
		case ob.ch <- fr:
		default:
			ob.dropped.Add(1)
		}
	}
	f.mu.Unlock()
}

// Subscribe attaches a new observer. Returns the observer, a terminal baseline
// (nil for desktop), an unsubscribe func, and ok=false when the session isn't
// being monitored (ended or never started here).
func (h *Hub) Subscribe(id string) (*Observer, *Baseline, func(), bool) {
	noop := func() {}
	if h == nil {
		return nil, nil, noop, false
	}
	h.mu.RLock()
	f := h.sessions[id]
	h.mu.RUnlock()
	if f == nil {
		return nil, nil, noop, false
	}
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return nil, nil, noop, false
	}
	bufSize := 256
	if f.mode == ModeDesktop {
		bufSize = 64
	}
	ob := &Observer{ch: make(chan Frame, bufSize)}
	f.nextID++
	oid := f.nextID
	f.observers[oid] = ob
	var base *Baseline
	if f.mode == ModeTerminal {
		cp := make([]byte, len(f.scroll))
		copy(cp, f.scroll)
		base = &Baseline{Scrollback: cp, Cols: f.cols, Rows: f.rows}
	}
	f.mu.Unlock()

	unsub := func() {
		f.mu.Lock()
		if ob2, ok := f.observers[oid]; ok {
			delete(f.observers, oid)
			close(ob2.ch)
		}
		f.mu.Unlock()
	}
	return ob, base, unsub, true
}

// Observers reports how many observers a session currently has (0 when not
// monitored) — backs the "N watching" indicator.
func (h *Hub) Observers(id string) int {
	if h == nil {
		return 0
	}
	h.mu.RLock()
	f := h.sessions[id]
	h.mu.RUnlock()
	if f == nil {
		return 0
	}
	f.mu.Lock()
	n := len(f.observers)
	f.mu.Unlock()
	return n
}
