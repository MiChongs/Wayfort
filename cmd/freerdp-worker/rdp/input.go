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
extern BOOL wSendContextRefreshRect(rdpContext* ctx, UINT16 left, UINT16 top, UINT16 right, UINT16 bottom);
*/
import "C"

import (
	"unicode/utf16"

	"github.com/michongs/wayfort/internal/desktop"
)

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
	// WebRTC control fields ride on any ClientMessage (they are value types, not
	// one of the pointer "event" cases below). RequestKeyframe is the gateway
	// relaying a Pion PLI / first-frame need; VideoMode lets the gateway confirm
	// the negotiated path. Handle them before the input switch so a pure control
	// message (no Key/Mouse/etc.) still takes effect.
	if msg.RequestKeyframe {
		c.forceKeyframe.Store(true)
		c.videoDirty.Store(true)
	}
	if msg.SetBitrateKbps > 0 {
		c.setVideoBitrate(msg.SetBitrateKbps)
	}
	if msg.VideoMode != "" {
		c.setVideoMode(msg.VideoMode)
	}
	rctx := (*C.rdpContext)(c.context)
	switch {
	case msg.Text != "":
		// IME-composed / committed Unicode text (e.g. 你好). Replay it as
		// per-character Unicode keyboard events so it lands on the remote
		// regardless of the server's keyboard layout — the local input method
		// already did the composing.
		c.sendUnicodeText(C.wContextInput(rctx), msg.Text)
	case msg.Key != nil:
		input := C.wContextInput(rctx)
		var down C.BOOL
		if msg.Key.Pressed {
			down = C.TRUE
		}
		// Primary path: the browser resolved the physical key to an RDP scancode
		// (from event.code). Scancodes compose with the modifier keyboard state
		// on the server, so shortcuts (Ctrl+C, Alt+Tab, Win+L …) work — Unicode
		// injection can't form combos. The server's keyboard layout turns the
		// scancode into the right character.
		if msg.Key.Scancode != 0 {
			ext := C.BOOL(C.FALSE)
			if msg.Key.Extended {
				ext = C.TRUE
			}
			C.wSendScancode(input, down, C.UINT16(msg.Key.Scancode), ext)
		} else if ks := uint32(msg.Key.Keysym); ks != 0 {
			// Legacy/fallback path: a key the browser couldn't map to a scancode.
			// Control keys → scancode via our keysym table; printable → Unicode.
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
		}
		// else: unknown key, drop silently.
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
		// Record the new browser viewport size. With dynamic_resolution opted in
		// AND the disp (RDPEDISP) channel up, push it to the server live so the
		// remote desktop reflows to match at native 1:1 (no scaling blur);
		// otherwise the new size simply takes effect on the next reconnect — the
		// historical behaviour, kept as the graceful fallback when Display Control
		// isn't available. Resize dims are the target physical resolution; the
		// session scale factor carries the matching Windows display scaling.
		c.width = msg.Resize.Width
		c.height = msg.Resize.Height
		if c.params.RDP.DynamicResolution != nil && *c.params.RDP.DynamicResolution {
			c.sendMonitorLayout(msg.Resize.Width, msg.Resize.Height, uint32(c.params.Scale))
		}
	case msg.HB != nil:
		// Heartbeats are gateway-internal; nothing to forward to the server.
	case msg.Refresh != nil:
		// RDP `Refresh Rect` PDU. Browser fires this when its
		// WebCodecs.VideoDecoder errors out and needs a fresh IDR
		// keyframe immediately. Empty dimensions = whole canvas, which
		// is what the browser sends on error recovery.
		left := C.UINT16(uint16(msg.Refresh.X))
		top := C.UINT16(uint16(msg.Refresh.Y))
		w := uint32(msg.Refresh.Width)
		h := uint32(msg.Refresh.Height)
		if w == 0 {
			w = uint32(c.width)
		}
		if h == 0 {
			h = uint32(c.height)
		}
		right := C.UINT16(uint16(msg.Refresh.X + w))
		bottom := C.UINT16(uint16(msg.Refresh.Y + h))
		C.wSendContextRefreshRect(rctx, left, top, right, bottom)
	}
}

// sendUnicodeText replays a committed Unicode string as RDP Unicode keyboard
// events — one press+release per UTF-16 code unit. FreeRDP's Unicode keyboard
// event carries a UTF-16 code unit, so a BMP character is a single event and an
// astral character (emoji) is its surrogate pair sent as two events, which
// Windows reassembles. This is how a browser client delivers IME output (the
// local input method composed the text; the server just receives the result),
// independent of the remote keyboard layout.
func (c *Client) sendUnicodeText(input *C.rdpInput, text string) {
	if input == nil || text == "" {
		return
	}
	for _, unit := range utf16.Encode([]rune(text)) {
		C.wSendUnicode(input, C.TRUE, C.UINT32(unit))
		C.wSendUnicode(input, C.FALSE, C.UINT32(unit))
	}
}
