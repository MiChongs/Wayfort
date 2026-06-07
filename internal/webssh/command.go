package webssh

import "strings"

// cmdTracker reconstructs whole command lines from the raw keystroke stream so
// the audit log records one row per command instead of one per keypress.
//
// It is a deliberate best-effort heuristic on the *input* side: it buffers
// printable runes, applies backspace, and flushes on carriage return / line
// feed. Escape sequences (arrow keys, function keys) are swallowed, so history
// recall and tab completion — whose text arrives as terminal *echo* on the
// output side, not as typed input — are not captured. That is an accepted
// limitation of input-side auditing; full fidelity would require parsing the
// PTY output stream.
type cmdTracker struct {
	buf   []rune
	inEsc bool
	emit  func(string)
}

func newCmdTracker(emit func(string)) *cmdTracker { return &cmdTracker{emit: emit} }

// feed consumes a chunk of raw input bytes (as received over the WebSocket) and
// emits any command lines that were completed within it.
func (t *cmdTracker) feed(s string) {
	for _, r := range s {
		switch {
		case t.inEsc:
			// A CSI/escape sequence ends on its first final byte (a letter or
			// a handful of terminators). Good enough to resync the parser.
			if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '~' {
				t.inEsc = false
			}
		case r == 0x1b: // ESC — start of an escape sequence
			t.inEsc = true
		case r == '\r' || r == '\n':
			t.flush()
		case r == 0x7f || r == 0x08: // DEL / Backspace
			if len(t.buf) > 0 {
				t.buf = t.buf[:len(t.buf)-1]
			}
		case r == 0x03 || r == 0x15: // Ctrl-C / Ctrl-U — abandon the line
			t.buf = t.buf[:0]
		case r < 0x20: // other control bytes (Tab, etc.) — ignore
		default:
			if len(t.buf) < 4096 { // guard against a paste bomb
				t.buf = append(t.buf, r)
			}
		}
	}
}

func (t *cmdTracker) flush() {
	cmd := strings.TrimSpace(string(t.buf))
	t.buf = t.buf[:0]
	if cmd == "" {
		return
	}
	if t.emit != nil {
		t.emit(cmd)
	}
}
