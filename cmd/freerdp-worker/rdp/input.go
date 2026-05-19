//go:build freerdp

// input.go — Plan 17 M2 input forwarding. ClientMessages coming from the
// gateway arrive on c.in; runLoop drains them from the FreeRDP owner thread
// before dispatching onto input PDU senders, channel data senders, or
// settings updates.

package rdp

/*
#cgo pkg-config: freerdp3 freerdp-client3 winpr3
#include <freerdp/freerdp.h>
#include <freerdp/input.h>

extern rdpInput* wContextInput(rdpContext* ctx);
extern BOOL wSendUnicode(rdpInput* input, BOOL down, UINT32 codepoint);
extern BOOL wSendScancode(rdpInput* input, BOOL down, UINT16 scancode, BOOL extended);
extern BOOL wSendMouse(rdpInput* input, UINT16 flags, UINT16 x, UINT16 y);
*/
import "C"

import "github.com/michongs/jumpserver-anonymous/internal/desktop"

func (c *Client) drainInput(limit int) {
	for i := 0; i < limit; i++ {
		select {
		case msg, ok := <-c.in:
			if !ok {
				return
			}
			c.dispatchInput(msg)
		default:
			return
		}
	}
}

func (c *Client) dispatchInput(msg desktop.ClientMessage) {
	if c.context == nil {
		return
	}
	rctx := (*C.rdpContext)(c.context)
	switch {
	case msg.Key != nil:
		input := C.wContextInput(rctx)
		var down C.BOOL
		if msg.Key.Pressed {
			down = C.TRUE
		}
		// Printable ASCII / Unicode → Unicode keyboard event (Windows
		// handles layout internally, robust to client keyboard layout
		// mismatches). Control keys → resolve to RDP scancode via our
		// keysym table.
		ks := uint32(msg.Key.Keysym)
		if scancode, extended, ok := keysymToScancode(ks); ok {
			ext := C.BOOL(C.FALSE)
			if extended {
				ext = C.TRUE
			}
			C.wSendScancode(input, down, C.UINT16(scancode), ext)
		} else if ks >= 0x20 && ks <= 0x7E {
			C.wSendUnicode(input, down, C.UINT32(ks))
		} else if ks >= 0x100 && ks < 0xFF00 {
			// Higher-plane Unicode — Latin-1, CJK, etc. (FreeRDP unicode
			// event takes UINT16, which limits us to BMP; emojis / SMP
			// would need composition, deferred).
			C.wSendUnicode(input, down, C.UINT32(ks))
		}
		// else: unknown keysym, drop silently.
	case msg.Mouse != nil:
		input := C.wContextInput(rctx)
		// Translate our generic button bitmask to libfreerdp PTR_FLAGS_*.
		// We need to send one event per button-state-change; libfreerdp
		// doesn't have a "set all buttons" PDU.
		flags := C.UINT16(C.PTR_FLAGS_MOVE)
		C.wSendMouse(input, flags, C.UINT16(uint16(msg.Mouse.X)), C.UINT16(uint16(msg.Mouse.Y)))
		// Buttons — emit transitions vs. our cached state.
		curButtons := uint32(msg.Mouse.Buttons)
		diff := curButtons ^ c.prevButtons
		if diff&desktop.MouseButtonMaskLeft != 0 {
			f := C.UINT16(C.PTR_FLAGS_BUTTON1)
			if curButtons&desktop.MouseButtonMaskLeft != 0 {
				f |= C.PTR_FLAGS_DOWN
			}
			C.wSendMouse(input, f, C.UINT16(uint16(msg.Mouse.X)), C.UINT16(uint16(msg.Mouse.Y)))
		}
		if diff&desktop.MouseButtonMaskMiddle != 0 {
			f := C.UINT16(C.PTR_FLAGS_BUTTON3)
			if curButtons&desktop.MouseButtonMaskMiddle != 0 {
				f |= C.PTR_FLAGS_DOWN
			}
			C.wSendMouse(input, f, C.UINT16(uint16(msg.Mouse.X)), C.UINT16(uint16(msg.Mouse.Y)))
		}
		if diff&desktop.MouseButtonMaskRight != 0 {
			f := C.UINT16(C.PTR_FLAGS_BUTTON2)
			if curButtons&desktop.MouseButtonMaskRight != 0 {
				f |= C.PTR_FLAGS_DOWN
			}
			C.wSendMouse(input, f, C.UINT16(uint16(msg.Mouse.X)), C.UINT16(uint16(msg.Mouse.Y)))
		}
		c.prevButtons = curButtons
		// Wheel — single tick = 120 per Windows convention.
		if msg.Mouse.Wheel != 0 {
			f := C.UINT16(C.PTR_FLAGS_WHEEL)
			rotation := int(msg.Mouse.Wheel * 120)
			if rotation < 0 {
				f |= C.PTR_FLAGS_WHEEL_NEGATIVE
				rotation = -rotation
			}
			f |= C.UINT16(rotation & 0xFF)
			C.wSendMouse(input, f, 0, 0)
		}
	case msg.Clipboard != nil:
		switch msg.Clipboard.MIME {
		case "text/plain;charset=utf-16le":
			c.pushClipboardUTF16LE(msg.Clipboard.Payload)
		case "text/plain", "text/plain;charset=utf-8":
			c.pushClipboardText(string(msg.Clipboard.Payload))
		}
	case msg.Resize != nil:
		// Live resize isn't directly supported by the RDP protocol without
		// the Display Update Virtual Channel (RDPEDISP). M2 records the
		// new browser viewport size; when the user reconnects the new
		// dimensions take effect. M2.x will negotiate RDPEDISP.
		c.width = msg.Resize.Width
		c.height = msg.Resize.Height
	case msg.HB != nil:
		// Heartbeats are gateway-internal; nothing to forward to the server.
	}
}
