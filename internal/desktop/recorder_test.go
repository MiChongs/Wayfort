package desktop

import (
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// TestRecorderTapeFormat pins the .dtr wire format the frontend parser
// (web/src/lib/desktop/recording.ts) decodes: 18-byte header then
// kind(1)+tMs(4)+len(4)+payload records, all big-endian.
func TestRecorderTapeFormat(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "tape.dtr")
	start := time.Now().Add(-200 * time.Millisecond)

	rec, err := NewRecorder(path, 1280, 720, true, start)
	if err != nil {
		t.Fatalf("NewRecorder: %v", err)
	}

	// OUTPUT — a raw BGRA frame encoded exactly as the WS hop would.
	frameBody, err := EncodeServerMessageBinaryPayload(ServerMessage{Frame: &FrameRect{
		X: 0, Y: 0, Width: 1, Height: 1, Encoding: EncodingRawBGRA, Payload: []byte{1, 2, 3, 4},
	}})
	if err != nil {
		t.Fatalf("encode frame: %v", err)
	}
	rec.WriteOutput(frameBody)
	rec.WriteInput(ClientMessage{Key: &InputKey{Keysym: 0x41, Pressed: true}})
	rec.WriteInput(ClientMessage{HB: &Heartbeat{TSMs: 1}})                       // filtered
	rec.WriteInput(ClientMessage{Mouse: &InputMouse{X: 5, Y: 6, Buttons: 0}})    // pure move, filtered
	rec.WriteInput(ClientMessage{Mouse: &InputMouse{X: 5, Y: 6, Buttons: 1}})    // click, kept
	rec.WriteEvent(RecordingEvent{Type: "status:CONNECTED"})
	if err := rec.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(raw) < dtrHeaderSize {
		t.Fatalf("file too small: %d", len(raw))
	}
	if string(raw[0:4]) != "DTR1" {
		t.Fatalf("bad magic %q", raw[0:4])
	}
	if raw[4] != 1 {
		t.Fatalf("bad version %d", raw[4])
	}
	if raw[5]&dtrFlagInputCaptured == 0 {
		t.Fatalf("input-captured flag not set")
	}
	if w := binary.BigEndian.Uint16(raw[6:8]); w != 1280 {
		t.Fatalf("width = %d", w)
	}
	if h := binary.BigEndian.Uint16(raw[8:10]); h != 720 {
		t.Fatalf("height = %d", h)
	}

	// Walk records; assert kinds + the filtered ones are absent.
	var kinds []RecordKind
	off := dtrHeaderSize
	for off+9 <= len(raw) {
		kind := RecordKind(raw[off])
		ln := int(binary.BigEndian.Uint32(raw[off+5 : off+9]))
		off += 9
		if off+ln > len(raw) {
			t.Fatalf("record overruns file")
		}
		kinds = append(kinds, kind)
		off += ln
	}
	// Expected: OUTPUT, INPUT(key), INPUT(click), EVENT. HB + pure-move dropped.
	want := []RecordKind{RecordOutput, RecordInput, RecordInput, RecordEvent}
	if len(kinds) != len(want) {
		t.Fatalf("record kinds = %v, want %v", kinds, want)
	}
	for i := range want {
		if kinds[i] != want[i] {
			t.Fatalf("record %d kind = %d, want %d", i, kinds[i], want[i])
		}
	}
}

// TestRecorderNilSafe verifies the nil-recorder no-ops the ws_handler relies on.
func TestRecorderNilSafe(t *testing.T) {
	var r *Recorder
	r.WriteOutput([]byte{1})
	r.WriteInput(ClientMessage{})
	r.WriteEvent(RecordingEvent{Type: "x"})
	if err := r.Close(); err != nil {
		t.Fatalf("nil Close: %v", err)
	}
}
