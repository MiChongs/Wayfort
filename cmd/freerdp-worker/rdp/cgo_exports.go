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
	// Channels are loaded automatically by FreeRDP_RedirectClipboard /
	// FreeRDP_AudioPlayback / FreeRDP_SupportGraphicsPipeline /
	// FreeRDP_DeviceRedirection settings we already enabled. We just need
	// the channel listener registration which happens in registerChannelPubSub
	// at context-new time.
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
	// Walk the array of rectangles libfreerdp produced; each is a self-
	// contained tile we forward to the browser. We currently send the
	// per-tile DSTRECT directly without coalescing.
	n := uint32(bitmap.number)
	rects := unsafe.Slice((*C.BITMAP_DATA)(unsafe.Pointer(bitmap.rectangles)), n)
	for i := uint32(0); i < n; i++ {
		r := &rects[i]
		// BITMAP_DATA.bitmapDataStream is the decoded RGB buffer when
		// compressed==FALSE; if compressed it's the on-wire payload and
		// would need decode_bitmap. Setting BitmapCacheEnabled=TRUE means
		// FreeRDP will decode for us — the data is BGRA when negotiating
		// 32bpp. Either way we forward raw bytes with the negotiated
		// pixel format documented on the wire.
		if r.bitmapDataStream == nil || r.bitmapLength == 0 {
			continue
		}
		buf := C.GoBytes(unsafe.Pointer(r.bitmapDataStream), C.int(r.bitmapLength))
		c.emit(desktop.ServerMessage{Frame: &desktop.FrameRect{
			X:        uint32(r.destLeft),
			Y:        uint32(r.destTop),
			Width:    uint32(r.width),
			Height:   uint32(r.height),
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
