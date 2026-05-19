// Package rdp wraps libfreerdp 3.x as a Go-callable RDP client driver.
//
// Build tags:
//   - `freerdp` (default for production): compiles client.go + the
//     CGo callback bridge against libfreerdp 3.x via pkg-config.
//   - no tag: compiles only stub.go which returns "not built" errors,
//     letting `go build ./...` succeed on hosts without libfreerdp.
//
// Channel coverage:
//   - Surface bits via classic bitmap/GDI path                         enabled
//   - Pointer/cursor                                                   enabled after cursor protocol fix
//   - Keyboard / mouse input                                           enabled on FreeRDP owner thread
//   - CLIPRDR text                                                     enabled after protocol fix
//   - RDPEDISP dynamic resize                                          disabled
//   - RDPSND audio playback                                            disabled
//   - RDPGFX graphics pipeline                                         disabled
//   - RDPDR drive redirection / file transfer                          disabled
//   - Printers / smartcards                                            disabled
//
// Disabled channels must stay off in applySettings until this package and
// the browser both implement the complete sub-protocol end to end.
// See docs/rdp-backend-capabilities.md for the repo-level support matrix.
//
// All channel callbacks marshal events to ServerMessage and write to the
// stdio frame channel set up in cmd/freerdp-worker/main.go. The gateway
// in internal/desktop/ then forwards them to the browser.
//
// VALIDATION STATUS: the classic display path compiles and is wired into
// libfreerdp. Channel-specific features are intentionally disabled until
// their gateway and browser protocol paths are implemented and validated
// against real Windows hosts.
package rdp
