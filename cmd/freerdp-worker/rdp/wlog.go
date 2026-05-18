//go:build freerdp

package rdp

/*
#cgo pkg-config: freerdp3 freerdp-client3 winpr3
#cgo windows CFLAGS: -D__STDC_NO_THREADS__

#include <stdlib.h>
#include <winpr/wlog.h>
*/
import "C"

import "unsafe"

// ApplyWLogLevel forces libfreerdp's WLog root logger to the given level
// string ("OFF" / "FATAL" / "ERROR" / "WARN" / "INFO" / "DEBUG" / "TRACE",
// case-insensitive). Returns true if the level was accepted and applied.
//
// Why this exists despite libfreerdp documenting auto-init from the
// WLOG_LEVEL env var:
//
//   The gateway sets `WLOG_LEVEL=DEBUG` in the worker subprocess env
//   (internal/desktop/worker_freerdp.go) and libfreerdp's WLog_GetRoot()
//   *should* pick that up at first-use via InitOnceExecuteOnce. In our
//   actual runtime that auto-init produces no DEBUG output — possibly
//   because cgo constructor ordering touches WLog before our env is
//   visible, or because winpr's GetEnvironmentVariableA path on the
//   MSYS2 ucrt64 build returns a zero-length read in some cases.
//
//   Either way, calling WLog_SetStringLogLevel explicitly at process
//   startup is deterministic and overrides whatever the auto-init did.
//   That makes `desktop.debug_log: true` actually surface libfreerdp's
//   state-machine transitions on stderr, which is the only way to debug
//   "TLS done → 6s silence → BIO_read retries exceeded" without packet
//   captures.
func ApplyWLogLevel(level string) bool {
	if level == "" {
		return false
	}
	clevel := C.CString(level)
	defer C.free(unsafe.Pointer(clevel))
	root := C.WLog_GetRoot()
	if root == nil {
		return false
	}
	return C.WLog_SetStringLogLevel(root, clevel) != 0
}
