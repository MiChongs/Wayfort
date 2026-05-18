//go:build freerdp

// keysym.go — X11 keysym → RDP scancode table for the non-printable keys
// we expect from the browser (Plan 17 M2). Printable characters are sent
// as Unicode keyboard events instead so layout differences don't bite.
//
// Sources: /usr/include/X11/keysymdef.h for the keysym constants;
// scancodes from the IBM PC AT scancode set 1 — same numbering FreeRDP
// passes to freerdp_input_send_keyboard_event.
//
// The boolean return indicates whether the scancode needs the "extended"
// (0xE0-prefixed) flag — arrows, right-side modifiers, navigation cluster
// etc.

package rdp

func keysymToScancode(keysym uint32) (scancode uint16, extended bool, ok bool) {
	switch keysym {
	case 0xFF08:
		return 0x0E, false, true // Backspace
	case 0xFF09:
		return 0x0F, false, true // Tab
	case 0xFF0D:
		return 0x1C, false, true // Enter (Return)
	case 0xFF1B:
		return 0x01, false, true // Escape
	case 0xFFFF:
		return 0x53, true, true // Delete
	case 0xFF63:
		return 0x52, true, true // Insert
	case 0xFF50:
		return 0x47, true, true // Home
	case 0xFF57:
		return 0x4F, true, true // End
	case 0xFF55:
		return 0x49, true, true // PageUp
	case 0xFF56:
		return 0x51, true, true // PageDown
	case 0xFF51:
		return 0x4B, true, true // Left
	case 0xFF52:
		return 0x48, true, true // Up
	case 0xFF53:
		return 0x4D, true, true // Right
	case 0xFF54:
		return 0x50, true, true // Down
	case 0xFFE1, 0xFFE2:
		return 0x2A, false, true // Shift (L/R)
	case 0xFFE3:
		return 0x1D, false, true // Control L
	case 0xFFE4:
		return 0x1D, true, true // Control R (extended)
	case 0xFFE9:
		return 0x38, false, true // Alt L
	case 0xFFEA:
		return 0x38, true, true // Alt R (extended)
	case 0xFFEB, 0xFFEC:
		return 0x5B, true, true // Meta / Windows key (L/R)
	case 0xFFE5:
		return 0x3A, false, true // Caps Lock
	case 0xFF7F:
		return 0x45, false, true // Num Lock
	case 0xFF14:
		return 0x46, false, true // Scroll Lock
	case 0xFF13:
		// "Pause" needs the special pause sequence; not covered here.
		return 0, false, false
	// F1..F12
	case 0xFFBE:
		return 0x3B, false, true
	case 0xFFBF:
		return 0x3C, false, true
	case 0xFFC0:
		return 0x3D, false, true
	case 0xFFC1:
		return 0x3E, false, true
	case 0xFFC2:
		return 0x3F, false, true
	case 0xFFC3:
		return 0x40, false, true
	case 0xFFC4:
		return 0x41, false, true
	case 0xFFC5:
		return 0x42, false, true
	case 0xFFC6:
		return 0x43, false, true
	case 0xFFC7:
		return 0x44, false, true
	case 0xFFC8:
		return 0x57, false, true
	case 0xFFC9:
		return 0x58, false, true
	}
	return 0, false, false
}
