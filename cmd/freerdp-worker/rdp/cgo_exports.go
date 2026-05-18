//go:build freerdp

// cgo_exports.go — //export bridges. libfreerdp's callbacks are C function
// pointers; cgo lets us declare Go functions visible to C via //export but
// only from a separate file with no other cgo references (per cgo manual).
// All the C code that consumes these symbols lives in client.go's preamble.

package rdp

/*
#cgo pkg-config: freerdp3 freerdp-client3 winpr3
#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/codec/color.h>
#include <freerdp/channels/cliprdr.h>
#include <freerdp/channels/rdpsnd.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/rdpsnd.h>
#include <freerdp/client/rdpgfx.h>

extern rdpSettings* wContextSettings(rdpContext* ctx);
extern rdpUpdate*   wContextUpdate(rdpContext* ctx);
extern void wInstallUpdateCallbacks(rdpUpdate* update);
extern void wInstallPointerCallbacks(rdpPointer* pt);
*/
import "C"

import (
	"hash/fnv"
	"unsafe"

	"github.com/michongs/jumpserver-anonymous/internal/desktop"
	"go.uber.org/zap"
)

// ----- instance-level callbacks -----

//export goPreConnect
func goPreConnect(instance *C.freerdp) C.BOOL {
	// Channels are loaded by our FreeRDP LoadChannels wrapper from applySettings.
	// During display stabilization only CLIPRDR is enabled by default; audio,
	// drive, and dynamic virtual channels are forced off until fully wired.
	// The channel listener registration happens in registerChannelPubSub at
	// context-new time.
	if c := registry.get(unsafe.Pointer(instance.context)); c != nil {
		c.logger.Info("phase: pre-connect (settings staged, x224 not yet sent)")
	}
	return C.TRUE
}

//export goPostConnect
func goPostConnect(instance *C.freerdp) C.BOOL {
	ctx := instance.context
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil {
		return C.FALSE
	}
	c.logger.Info("phase: post-connect (capability exchange done, RDP session ready)")
	// Initialize the software GDI so bitmap updates have a target surface.
	// We don't actually display it — the BitmapUpdate callback intercepts
	// raw rectangles before GDI compositing.
	if !goBool(C.gdi_init(instance, C.PIXEL_FORMAT_BGRA32)) {
		c.logger.Warn("gdi_init failed")
		return C.FALSE
	}
	// Install the surface/pointer callbacks now that update + graphics
	// are set up.
	C.wInstallUpdateCallbacks(C.wContextUpdate(ctx))
	C.wInstallPointerCallbacks(ctx.graphics.Pointer_Prototype)
	// Reflect the negotiated desktop size to the worker (which may have
	// been clamped by the server).
	settings := C.wContextSettings(ctx)
	rw := uint32(C.freerdp_settings_get_uint32(settings, C.FreeRDP_DesktopWidth))
	rh := uint32(C.freerdp_settings_get_uint32(settings, C.FreeRDP_DesktopHeight))
	c.width = rw
	c.height = rh
	return C.TRUE
}

//export goPostDisconnect
func goPostDisconnect(instance *C.freerdp) {
	if instance == nil {
		return
	}
	C.gdi_free(instance)
}

//export goAuthenticate
func goAuthenticate(instance *C.freerdp, username, password, domain **C.char) C.BOOL {
	// Settings already hold the credentials — libfreerdp will only call
	// this if it wants us to override (e.g. NLA negotiation prompt).
	// Returning FALSE forces a connection failure rather than prompting.
	return C.TRUE
}

//export goAuthenticateEx
func goAuthenticateEx(instance *C.freerdp, username, password, domain **C.char, reason C.rdp_auth_reason) C.BOOL {
	// Same as goAuthenticate, but FreeRDP 3.25+ prefers AuthenticateEx.
	// Credentials are already staged in rdpSettings.
	return C.TRUE
}

//export goVerifyCertificate
func goVerifyCertificate(instance *C.freerdp, host *C.char, port C.UINT16,
	commonName, subject, issuer, fingerprint *C.char, flags C.DWORD) C.DWORD {
	if c := registry.get(unsafe.Pointer(instance.context)); c != nil {
		c.logger.Info("phase: tls handshake complete, validating server cert",
			zap.String("host", C.GoString(host)),
			zap.Uint16("port", uint16(port)),
			zap.String("common_name", C.GoString(commonName)))
	}
	// 2 == accept permanently (matches FreeRDP's CERT_ACCEPT_PERMANENTLY).
	// Mirrors the IgnoreCertificate=TRUE setting we already turned on.
	return 2
}

//export goLogonErrorInfo
func goLogonErrorInfo(instance *C.freerdp, data C.UINT32, typ C.UINT32) C.int {
	if c := registry.get(unsafe.Pointer(instance.context)); c != nil {
		c.logger.Warn("freerdp logon error info",
			zap.Uint32("data", uint32(data)),
			zap.Uint32("type", uint32(typ)))
	}
	return 1
}

//export goAfterLoadChannels
func goAfterLoadChannels(ctx *C.rdpContext, ok C.BOOL) {
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil {
		return
	}
	if !goBool(ok) {
		c.logger.Warn("freerdp channel loading failed")
	}
	c.logChannelCollections(C.wContextSettings(ctx), "after FreeRDP load_addins")
}

// ----- channel connect/disconnect (PubSub) -----

//export goOnChannelConnected
func goOnChannelConnected(ctx *C.rdpContext, name *C.char, iface unsafe.Pointer) {
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil {
		return
	}
	cname := C.GoString(name)
	c.logger.Info("channel connected", zap.String("name", cname))
	switch cname {
	case "cliprdr":
		c.cliprdr = iface
		c.attachClipboard(iface)
	case "rdpsnd":
		c.rdpsnd = iface
		c.attachAudio(iface)
	case "rdpgfx":
		c.rdpgfx = iface
		c.attachGraphicsPipeline(iface)
	case "rdpdr":
		c.attachDriveRedirection(iface)
	}
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
		Phase:   desktop.PhaseConnected,
		Message: "channel:" + cname,
	}})
}

//export goOnChannelDisconnected
func goOnChannelDisconnected(ctx *C.rdpContext, name *C.char, iface unsafe.Pointer) {
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil {
		return
	}
	cname := C.GoString(name)
	c.logger.Info("channel disconnected", zap.String("name", cname))
	switch cname {
	case "cliprdr":
		c.cliprdr = nil
	case "rdpsnd":
		c.rdpsnd = nil
	case "rdpgfx":
		c.rdpgfx = nil
	}
}

// ----- bitmap surface updates -----

//export goOnBitmapUpdate
func goOnBitmapUpdate(ctx *C.rdpContext, bitmap *C.BITMAP_UPDATE) C.BOOL {
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil {
		return C.FALSE
	}
	if bitmap == nil || bitmap.number == 0 {
		return C.TRUE
	}
	// One-shot log so the gateway log proves "the server sent at least one
	// frame and our worker decoded it" — distinguishes a happy-path-but-
	// browser-closed-early failure from a connect-but-no-frames hang.
	if !c.firstBitmapLogged.Swap(true) {
		c.logger.Info("phase: first bitmap update from server",
			zap.Uint32("rectangle_count", uint32(bitmap.number)))
	}
	if ctx.gdi == nil || ctx.gdi.primary_buffer == nil || ctx.gdi.bitmap_stride == 0 {
		c.logger.Warn("bitmap update arrived before GDI primary surface was ready")
		return C.TRUE
	}
	stride := uint32(ctx.gdi.bitmap_stride)
	surfaceW := uint32(ctx.gdi.width)
	surfaceH := uint32(ctx.gdi.height)

	// wBitmapUpdate in cgo_wrappers.go has already let FreeRDP's GDI decode
	// and composite the update. Copy the touched rectangle from the decoded
	// BGRA primary surface instead of forwarding compressed bitmapDataStream.
	n := uint32(bitmap.number)
	rects := unsafe.Slice((*C.BITMAP_DATA)(unsafe.Pointer(bitmap.rectangles)), n)
	for i := uint32(0); i < n; i++ {
		r := &rects[i]
		x := uint32(r.destLeft)
		y := uint32(r.destTop)
		w := uint32(r.width)
		h := uint32(r.height)
		if r.destRight >= r.destLeft && r.destBottom >= r.destTop {
			w = uint32(r.destRight-r.destLeft) + 1
			h = uint32(r.destBottom-r.destTop) + 1
		}
		if x >= surfaceW || y >= surfaceH || w == 0 || h == 0 {
			continue
		}
		if x+w > surfaceW {
			w = surfaceW - x
		}
		if y+h > surfaceH {
			h = surfaceH - y
		}
		rowBytes := w * 4
		if rowBytes == 0 || (x*4)+rowBytes > stride {
			continue
		}
		buf := make([]byte, 0, rowBytes*h)
		base := unsafe.Pointer(ctx.gdi.primary_buffer)
		for row := uint32(0); row < h; row++ {
			offset := uintptr((y+row)*stride + x*4)
			src := unsafe.Slice((*byte)(unsafe.Add(base, offset)), rowBytes)
			buf = append(buf, src...)
		}
		c.emit(desktop.ServerMessage{Frame: &desktop.FrameRect{
			X:        x,
			Y:        y,
			Width:    w,
			Height:   h,
			Encoding: desktop.EncodingRawBGRA,
			Payload:  buf,
		}})
	}
	return C.TRUE
}

//export goOnDesktopResize
func goOnDesktopResize(ctx *C.rdpContext) C.BOOL {
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil {
		return C.FALSE
	}
	s := C.wContextSettings(ctx)
	c.width = uint32(C.freerdp_settings_get_uint32(s, C.FreeRDP_DesktopWidth))
	c.height = uint32(C.freerdp_settings_get_uint32(s, C.FreeRDP_DesktopHeight))
	// Re-init GDI for the new size.
	if instance := (*C.freerdp)(c.instance); instance != nil {
		C.gdi_resize(instance.context.gdi, C.UINT32(c.width), C.UINT32(c.height))
	}
	return C.TRUE
}

// ----- pointer callbacks (cursor) -----

//export goOnPointerNew
func goOnPointerNew(ctx *C.rdpContext, pointer *C.rdpPointer) C.BOOL {
	// libfreerdp allocates the rdpPointer; we don't need to do anything
	// per-cursor here (no GPU resources). Cursor pixels are sent in Set.
	return C.TRUE
}

//export goOnPointerFree
func goOnPointerFree(ctx *C.rdpContext, pointer *C.rdpPointer) {}

//export goOnPointerSet
func goOnPointerSet(ctx *C.rdpContext, pointer *C.rdpPointer) C.BOOL {
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil || pointer == nil {
		return C.FALSE
	}
	w := uint32(pointer.width)
	h := uint32(pointer.height)
	if w == 0 || h == 0 || pointer.xorMaskData == nil {
		return C.TRUE
	}
	// 32-bit BGRA cursor. We forward the raw bitmap as PNG-less BGRA in
	// the CursorUpdate.PNG field (browser decodes accordingly). M2.x can
	// switch to actual PNG encoding via Go's image/png if we observe
	// payload-size pressure.
	stride := uint32(pointer.lengthXorMask) / max32(h, 1)
	_ = stride
	xor := C.GoBytes(unsafe.Pointer(pointer.xorMaskData), C.int(pointer.lengthXorMask))
	if dedup := hash64(xor); dedup == c.lastCursorHash {
		return C.TRUE
	} else {
		c.lastCursorHash = dedup
	}
	c.emit(desktop.ServerMessage{Cursor: &desktop.CursorUpdate{
		HotspotX: uint32(pointer.xPos),
		HotspotY: uint32(pointer.yPos),
		// PNG field is overloaded here for the raw BGRA payload; the
		// browser side checks the length / mime and treats accordingly.
		PNG: xor,
	}})
	return C.TRUE
}

//export goOnPointerSetNull
func goOnPointerSetNull(ctx *C.rdpContext) C.BOOL { return C.TRUE }

//export goOnPointerSetDefault
func goOnPointerSetDefault(ctx *C.rdpContext) C.BOOL { return C.TRUE }

// ----- helpers -----

func hash64(b []byte) uint64 {
	h := fnv.New64a()
	_, _ = h.Write(b)
	return h.Sum64()
}

func max32(a, b uint32) uint32 {
	if a > b {
		return a
	}
	return b
}
