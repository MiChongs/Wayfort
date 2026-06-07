package desktop

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"os"
	"sync"
	"time"
)

// Recorder writes a session "tape" (.dtr) the browser can replay in-place via
// the same canvas/decoder pipeline used for live sessions. The tape is a single
// timestamped timeline carrying three record kinds:
//
//	OUTPUT — a desktop.v2 binary ServerMessage (frame / cursor) → visual replay
//	INPUT  — a JSON ClientMessage (key / mouse / clipboard)     → audit timeline
//	EVENT  — a JSON milestone (connect / resize / error / …)    → seek markers
//
// File layout (all integers big-endian):
//
//	Header (18 bytes):
//	  [0:4]   magic "DTR1"
//	  [4]     version = 1
//	  [5]     flags   (bit0 = input captured)
//	  [6:8]   width   uint16
//	  [8:10]  height  uint16
//	  [10:18] startUnixMs int64
//	Records (repeated):
//	  [0]     kind uint8 (1 OUTPUT, 2 INPUT, 3 EVENT)
//	  [1:5]   tMs  uint32 (ms since startUnixMs)
//	  [5:9]   len  uint32
//	  [9:9+len] payload
type Recorder struct {
	mu           sync.Mutex
	f            *os.File
	bw           *bufio.Writer
	start        time.Time
	includeInput bool
	closed       bool
	// written tracks payload+framing bytes so a runaway session can't fill the
	// disk. Past the cap we drop OUTPUT (the bulk) but keep INPUT/EVENT so the
	// audit timeline stays complete.
	written  int64
	capped   bool
	maxBytes int64
}

// RecordKind tags one timeline record.
type RecordKind uint8

const (
	RecordOutput RecordKind = 1
	RecordInput  RecordKind = 2
	RecordEvent  RecordKind = 3

	dtrHeaderSize        = 18
	dtrFlagInputCaptured = 1 << 0
	// 4 GiB default cap — a full session at typical RDP framerates is far
	// smaller; this only backstops a pathological full-screen-raw storm.
	dtrDefaultMaxBytes = int64(4) << 30
)

// RecordingEvent is the JSON shape of an EVENT record. Kept small so the player
// can switch on `type` and optionally jump to `t_ms`.
type RecordingEvent struct {
	Type    string `json:"type"`
	Message string `json:"message,omitempty"`
	Code    uint32 `json:"code,omitempty"`
	Width   uint32 `json:"width,omitempty"`
	Height  uint32 `json:"height,omitempty"`
}

// NewRecorder creates the tape file and writes its header. start is the session
// wall-clock origin; tMs deltas are measured from it.
func NewRecorder(path string, width, height uint16, includeInput bool, start time.Time) (*Recorder, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	bw := bufio.NewWriterSize(f, 64*1024)
	var hdr [dtrHeaderSize]byte
	copy(hdr[0:4], "DTR1")
	hdr[4] = 1
	if includeInput {
		hdr[5] |= dtrFlagInputCaptured
	}
	binary.BigEndian.PutUint16(hdr[6:8], width)
	binary.BigEndian.PutUint16(hdr[8:10], height)
	binary.BigEndian.PutUint64(hdr[10:18], uint64(start.UnixMilli()))
	if _, err := bw.Write(hdr[:]); err != nil {
		_ = f.Close()
		return nil, err
	}
	return &Recorder{
		f:            f,
		bw:           bw,
		start:        start,
		includeInput: includeInput,
		maxBytes:     dtrDefaultMaxBytes,
	}, nil
}

// WriteOutput records a desktop.v2 binary ServerMessage (the exact bytes sent to
// the browser). Best-effort; recording never blocks or fails the live session.
func (r *Recorder) WriteOutput(body []byte) {
	if r == nil || len(body) == 0 {
		return
	}
	r.writeRecord(RecordOutput, body, false)
}

// WriteInput records an inbound ClientMessage when input capture is enabled.
func (r *Recorder) WriteInput(msg ClientMessage) {
	if r == nil || !r.includeInput {
		return
	}
	// Heartbeats and caps are gateway-internal noise, not audit-relevant.
	if msg.HB != nil || msg.Caps != nil {
		return
	}
	// Pure mouse moves (no button held, no wheel) flood the tape and carry no
	// audit value — keep clicks, drags-start, wheel, keys, clipboard, resize.
	if msg.Mouse != nil && msg.Mouse.Buttons == 0 && msg.Mouse.Wheel == 0 {
		return
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return
	}
	r.writeRecord(RecordInput, body, true)
}

// WriteEvent records a milestone (connect / disconnect / reconnect / resize /
// error). Always recorded (cheap, and the audit timeline must stay complete).
func (r *Recorder) WriteEvent(ev RecordingEvent) {
	if r == nil {
		return
	}
	body, err := json.Marshal(ev)
	if err != nil {
		return
	}
	r.writeRecord(RecordEvent, body, true)
}

func (r *Recorder) writeRecord(kind RecordKind, payload []byte, keepWhenCapped bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	if r.capped && !keepWhenCapped {
		return
	}
	if r.maxBytes > 0 && r.written > r.maxBytes && !keepWhenCapped {
		r.capped = true
		return
	}
	tMs := uint32(0)
	if d := time.Since(r.start).Milliseconds(); d > 0 {
		if d > int64(^uint32(0)) {
			d = int64(^uint32(0))
		}
		tMs = uint32(d)
	}
	var head [9]byte
	head[0] = byte(kind)
	binary.BigEndian.PutUint32(head[1:5], tMs)
	binary.BigEndian.PutUint32(head[5:9], uint32(len(payload)))
	if _, err := r.bw.Write(head[:]); err != nil {
		return
	}
	if _, err := r.bw.Write(payload); err != nil {
		return
	}
	r.written += int64(len(head) + len(payload))
}

// Close flushes and closes the tape. Safe to call multiple times.
func (r *Recorder) Close() error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil
	}
	r.closed = true
	_ = r.bw.Flush()
	return r.f.Close()
}
