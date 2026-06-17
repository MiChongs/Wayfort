//go:build freerdp

package rdp

import "testing"

// TestDriveRedirectRegisters proves the redirected drive actually lands in the
// settings device collection — the regression that left the remote desktop
// with no drive. It exercises the real libfreerdp device API, not a mock.
func TestDriveRedirectRegisters(t *testing.T) {
	count, deviceRedir, redirectDrives, ok := driveRedirectProbe("Wayfort", ".")
	if !ok {
		t.Fatal("wAddDriveRedirect failed")
	}
	if count != 1 {
		t.Fatalf("device count = %d, want 1 (drive was dropped, not registered)", count)
	}
	if !deviceRedir {
		t.Fatal("FreeRDP_DeviceRedirection not enabled after mounting a drive")
	}
	if !redirectDrives {
		t.Fatal("FreeRDP_RedirectDrives not enabled after mounting a drive")
	}
}

// TestChannelDebugActuallyEngages proves EnableChannelDebug turns on DEBUG for
// the targeted tags (the prior WLog_SetStringLogLevel approach returned success
// but left DEBUG inactive — that's why no rdpdr handshake was ever visible).
func TestChannelDebugActuallyEngages(t *testing.T) {
	const tag = "com.test.wayfort.drivefix"
	// Control: an unfiltered tag must NOT have DEBUG active by default.
	if wlogDebugActiveProbe(tag + ".control") {
		t.Skip("default log level already includes DEBUG; can't distinguish")
	}
	if n := EnableChannelDebug([]string{tag}); n != 1 {
		t.Fatalf("EnableChannelDebug returned %d, want 1", n)
	}
	if !wlogDebugActiveProbe(tag) {
		t.Fatal("DEBUG not active for the filtered tag — per-tag debug still broken")
	}
}

// TestDriveRedirectSurvivesMissingPath is the regression guard: the old path
// (freerdp_client_add_device_channel → freerdp_client_add_drive) silently
// dropped the device when freerdp_path_valid() rejected the path, leaving the
// remote desktop with no drive. Building the device directly must register it
// regardless, so a path that doesn't exist yet still yields a device.
func TestDriveRedirectSurvivesMissingPath(t *testing.T) {
	count, _, _, ok := driveRedirectProbe("Wayfort", "/no/such/path/should/exist/xyzzy")
	if !ok {
		t.Fatal("wAddDriveRedirect failed for a not-yet-existing path")
	}
	if count != 1 {
		t.Fatalf("device count = %d, want 1 — drive was dropped for a missing path (the original bug)", count)
	}
}
