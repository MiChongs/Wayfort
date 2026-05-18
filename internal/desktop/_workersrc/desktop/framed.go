package desktop

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// 4-byte length-prefixed framing used everywhere worker ↔ gateway IO
// crosses a stream boundary (stdio between Go gateway and worker subprocess).
// WebSocket frames already provide message boundaries so we DON'T add the
// prefix on the WS hop; only on stdio. See ws_handler.go / worker_freerdp.go.

const maxFrameBytes = 64 * 1024 * 1024 // 64 MB sanity cap

// writeFrame writes len32 + payload. Errors propagate as-is from w.
func writeFrame(w io.Writer, payload []byte) error {
	if len(payload) > maxFrameBytes {
		return fmt.Errorf("frame too big: %d", len(payload))
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

// readFrame reads one length-prefixed payload. Returns io.EOF when the
// underlying reader has cleanly closed at a frame boundary.
func readFrame(r io.Reader) ([]byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		// io.EOF here = clean close, propagate as-is.
		return nil, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n > maxFrameBytes {
		return nil, fmt.Errorf("frame too big: %d", n)
	}
	if n == 0 {
		return nil, errors.New("zero-length frame")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return nil, fmt.Errorf("read frame body: %w", err)
	}
	return buf, nil
}
