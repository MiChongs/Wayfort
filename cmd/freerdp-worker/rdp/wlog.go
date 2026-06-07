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

// ConfigureWLogToStderr forces WinPR/FreeRDP logs away from stdout. The worker
// protocol uses stdout for binary length-prefixed JSON frames, so a single WLog
// line on stdout permanently desynchronizes the gateway reader.
func ConfigureWLogToStderr() bool {
	root := C.WLog_GetRoot()
	if root == nil {
		return false
	}
	C.WLog_CloseAppender(root)
	if C.WLog_SetLogAppenderType(root, C.WLOG_APPENDER_CONSOLE) == 0 {
		return false
	}
	appender := C.WLog_GetLogAppender(root)
	if appender == nil {
		return false
	}
	setting := C.CString("outputstream")
	defer C.free(unsafe.Pointer(setting))
	stream := C.CString("stderr")
	defer C.free(unsafe.Pointer(stream))
	if C.WLog_ConfigureAppender(appender, setting, unsafe.Pointer(stream)) == 0 {
		return false
	}
	return C.WLog_OpenAppender(root) != 0
}

// ApplyWLogLevel forces libfreerdp's WLog root logger to the given level
// string ("OFF" / "FATAL" / "ERROR" / "WARN" / "INFO" / "DEBUG" / "TRACE",
// case-insensitive). Returns true if the level was accepted and applied.
//
// Why this exists despite libfreerdp documenting auto-init from the
// WLOG_LEVEL env var:
//
//	The gateway sets `WLOG_LEVEL=DEBUG` in the worker subprocess env
//	(internal/desktop/worker_freerdp.go) and libfreerdp's WLog_GetRoot()
//	*should* pick that up at first-use via InitOnceExecuteOnce. In our
//	actual runtime that auto-init produces no DEBUG output — possibly
//	because cgo constructor ordering touches WLog before our env is
//	visible, or because winpr's GetEnvironmentVariableA path on the
//	MSYS2 ucrt64 build returns a zero-length read in some cases.
//
//	Either way, calling WLog_SetStringLogLevel explicitly at process
//	startup is deterministic and overrides whatever the auto-init did.
//	That makes `desktop.debug_log: true` actually surface libfreerdp's
//	state-machine transitions on stderr, which is the only way to debug
//	"TLS done → 6s silence → BIO_read retries exceeded" without packet
//	captures.
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

// EnableChannelDebug bumps specific libfreerdp channel loggers to DEBUG without
// turning the whole root into a firehose. WLOG_FILTER env is ignored on the
// MSYS2 build (same reason ApplyWLogLevel exists), so we set the per-tag levels
// directly. Used to surface the rdpdr device-announce handshake — the only way
// to see whether a redirected drive is actually announced to the server.
func EnableChannelDebug(tags []string) int {
	// WLog_SetStringLogLevel on a freshly WLog_Get'd CHILD logger does NOT
	// stick on this WinPR build: the per-tag effective level is re-resolved
	// from the global filter table, so a direct level set is overridden when
	// FreeRDP later creates its own logger for the same tag. The filter table
	// (the programmatic equivalent of WLOG_FILTER, which the MSYS2 build also
	// ignores via env) is the mechanism that actually drives per-tag levels.
	// Add the filters here, before FreeRDP creates the channel loggers during
	// connect, so they pick up DEBUG at creation time. Format: "tag:LEVEL"
	// comma-separated, with a trailing wildcard so sub-loggers match too.
	if len(tags) == 0 {
		return 0
	}
	filter := ""
	for i, tag := range tags {
		if i > 0 {
			filter += ","
		}
		filter += tag + ".*:DEBUG," + tag + ":DEBUG"
	}
	cf := C.CString(filter)
	defer C.free(unsafe.Pointer(cf))
	if C.WLog_AddStringLogFilters(cf) != 0 {
		return len(tags)
	}
	return 0
}

// wlogDebugActiveProbe reports whether DEBUG is active for a tag's logger — a
// test seam to verify EnableChannelDebug actually engages per-tag DEBUG (the
// previous WLog_SetStringLogLevel approach reported success but DEBUG stayed
// inactive).
func wlogDebugActiveProbe(tag string) bool {
	ctag := C.CString(tag)
	defer C.free(unsafe.Pointer(ctag))
	log := C.WLog_Get(ctag)
	if log == nil {
		return false
	}
	return C.WLog_IsLevelActive(log, C.WLOG_DEBUG) != 0
}
