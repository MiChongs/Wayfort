// Package rdp wraps libfreerdp 3.x as a Go-callable RDP client driver.
//
// Build tags:
//   - `freerdp` (default for production): compiles client.go + the
//     CGo callback bridge against libfreerdp 3.x via pkg-config.
//   - no tag: compiles only stub.go which returns "not built" errors,
//     letting `go build ./...` succeed on hosts without libfreerdp.
//
// Channel coverage (Plan 17 M2 "complete implementation" sweep):
//   - Surface bits (bitmap codec) via update->Bitmap                 ✓
//   - Pointer (cursor) via update->pointer->{PointerNew,PointerSet}  ✓
//   - Keyboard / mouse input via freerdp_input_send_*                ✓
//   - CLIPRDR (clipboard, text + image + file-list per MS-RDPECLIP)  ✓
//   - RDPSND (audio playback)                                        ✓
//   - RDPGFX (graphics pipeline incl. AVC444 / RemoteFX)             ✓ raw forward
//   - RDPDR (drive redirection — file transfer)                      ✓ raw forward
//   - Multi-monitor (settings->MonitorCount + MonitorDefArray)       ✓
//
// All channel callbacks marshal events to ServerMessage and write to the
// stdio frame channel set up in cmd/freerdp-worker/main.go. The gateway
// in internal/desktop/ then forwards them to the browser.
//
// VALIDATION STATUS: every callback compiles and is wired into libfreerdp,
// but end-to-end correctness against real Windows hosts requires testing
// the operator must perform (no Windows RDP target available in the
// development sandbox where this code was authored). Bugs found during
// validation should be fixed in this package; the gateway / browser sides
// are protocol-agnostic and should not need changes.
package rdp
