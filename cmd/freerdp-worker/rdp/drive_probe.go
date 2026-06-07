//go:build freerdp

package rdp

/*
#cgo pkg-config: freerdp3 freerdp-client3 winpr3
#include <stdlib.h>
#include <freerdp/freerdp.h>
#include <freerdp/settings.h>

extern BOOL   wAddDriveRedirect(rdpSettings* settings, const char* name, const char* path);
extern UINT32 wDeviceCount(rdpSettings* settings);
*/
import "C"

import "unsafe"

// driveRedirectProbe is a test seam (cgo can't live in _test.go files). It
// builds a fresh settings object, mounts a drive at path, and reports the
// resulting device count plus the DeviceRedirection / RedirectDrives flags —
// exactly what determines whether the remote desktop gets a drive.
func driveRedirectProbe(name, path string) (deviceCount uint32, deviceRedirection, redirectDrives, ok bool) {
	settings := C.freerdp_settings_new(0)
	if settings == nil {
		return 0, false, false, false
	}
	defer C.freerdp_settings_free(settings)

	cn := C.CString(name)
	cp := C.CString(path)
	defer C.free(unsafe.Pointer(cn))
	defer C.free(unsafe.Pointer(cp))

	ok = C.wAddDriveRedirect(settings, cn, cp) != C.FALSE
	deviceCount = uint32(C.wDeviceCount(settings))
	deviceRedirection = C.freerdp_settings_get_bool(settings, C.FreeRDP_DeviceRedirection) != C.FALSE
	redirectDrives = C.freerdp_settings_get_bool(settings, C.FreeRDP_RedirectDrives) != C.FALSE
	return deviceCount, deviceRedirection, redirectDrives, ok
}
