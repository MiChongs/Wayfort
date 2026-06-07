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
#include <freerdp/update.h>
#include <freerdp/channels/cliprdr.h>
#include <freerdp/channels/rdpsnd.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/rdpsnd.h>
#include <freerdp/client/rdpgfx.h>
#include <freerdp/session.h>

extern rdpSettings* wContextSettings(rdpContext* ctx);
extern rdpUpdate*   wContextUpdate(rdpContext* ctx);
extern void wInstallUpdateCallbacks(rdpUpdate* update);
extern void wInstallPointerCallbacks(rdpPointer* pt);
extern BOOL wDecodePointerBGRA(rdpContext* ctx, rdpPointer* p, BYTE* dst);
*/
import "C"

import (
	"encoding/base64"
	"hash/fnv"
	"unsafe"

	"github.com/michongs/jumpserver-anonymous/internal/desktop"
	"go.uber.org/zap"
)

//export goRdpsndAudio
func goRdpsndAudio(ctx *C.rdpContext, sampleRate, channels, bits C.UINT32, data unsafe.Pointer, size C.int) {
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil || data == nil || size <= 0 {
		return
	}
	// Copy the PCM out of the libfreerdp-owned buffer before it's reused, then
	// hand it to the browser. emit() is non-blocking and drops audio (not
	// frames) under backpressure, so a slow client just glitches rather than
	// stalling the RDP thread.
	pcm := C.GoBytes(data, C.int(size))
	c.emit(desktop.ServerMessage{Audio: &desktop.AudioData{
		SampleRate: uint32(sampleRate),
		Channels:   uint32(channels),
		Bits:       uint32(bits),
		PCM:        base64.StdEncoding.EncodeToString(pcm),
	}})
}

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

//export goAuthenticateEx
func goAuthenticateEx(instance *C.freerdp, username, password, domain **C.char, reason C.rdp_auth_reason) C.BOOL {
	// Credentials are already staged in rdpSettings. Returning TRUE tells
	// FreeRDP to continue without opening an interactive prompt.
	return C.TRUE
}

//export goVerifyX509Certificate
func goVerifyX509Certificate(instance *C.freerdp, data *C.BYTE, length C.size_t,
	hostname *C.char, port C.UINT16, flags C.DWORD) C.int {
	ignoreCert := true
	if c := registry.get(unsafe.Pointer(instance.context)); c != nil {
		if c.params.RDP.IgnoreCert != nil {
			ignoreCert = *c.params.RDP.IgnoreCert
		}
		c.logger.Info("phase: tls handshake complete, validating x509 server certificate",
			zap.String("host", C.GoString(hostname)),
			zap.Uint16("port", uint16(port)),
			zap.Uint64("certificate_chain_bytes", uint64(length)),
			zap.Bool("ignore_cert", ignoreCert))
	}
	return C.int(certificateVerifyDecision(ignoreCert))
}

//export goLogonErrorInfo
func goLogonErrorInfo(instance *C.freerdp, data C.UINT32, typ C.UINT32) C.int {
	if c := registry.get(unsafe.Pointer(instance.context)); c != nil {
		c.recordLogonError(uint32(data), uint32(typ))
		dataText := ""
		if s := C.freerdp_get_logon_error_info_data(data); s != nil {
			dataText = C.GoString(s)
		}
		typeText := ""
		if s := C.freerdp_get_logon_error_info_type(typ); s != nil {
			typeText = C.GoString(s)
		}
		c.logger.Warn("freerdp logon error info",
			zap.Uint32("data", uint32(data)),
			zap.String("data_text", dataText),
			zap.Uint32("type", uint32(typ)),
			zap.String("type_text", typeText))
	}
	return 1
}

//export goOnSaveSessionInfo
func goOnSaveSessionInfo(ctx *C.rdpContext, typ C.UINT32, data unsafe.Pointer) C.BOOL {
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil {
		return C.FALSE
	}
	count := c.saveSessionInfos.Add(1)
	typeID := uint32(typ)
	fields := []zap.Field{
		zap.Uint32("type", typeID),
		zap.String("type_text", sessionInfoTypeText(typeID)),
		zap.Uint64("count", count),
		zap.Bool("has_data", data != nil),
	}
	switch typ {
	case C.INFO_TYPE_LOGON:
		if data != nil {
			info := (*C.logon_info)(data)
			c.logonSuccessSeen.Store(true)
			fields = append(fields,
				zap.Uint32("session_id", uint32(info.sessionId)),
				zap.Bool("username_present", goCString(info.username) != ""),
				zap.String("domain", goCString(info.domain)))
		}
	case C.INFO_TYPE_LOGON_LONG, C.INFO_TYPE_LOGON_PLAIN_NOTIFY:
		c.logonSuccessSeen.Store(true)
	case C.INFO_TYPE_LOGON_EXTENDED_INF:
		if data != nil {
			info := (*C.logon_info_ex)(data)
			fields = append(fields,
				zap.Bool("have_cookie", goBool(info.haveCookie)),
				zap.Uint32("logon_id", uint32(info.LogonId)),
				zap.Bool("have_error_info", goBool(info.haveErrorInfo)))
			if goBool(info.haveErrorInfo) {
				dataID := uint32(info.ErrorNotificationData)
				typeID := uint32(info.ErrorNotificationType)
				c.recordLogonError(dataID, typeID)
				fields = append(fields,
					zap.Uint32("error_data", dataID),
					zap.String("error_data_text", logonErrorDataText(dataID)),
					zap.Uint32("error_type", typeID),
					zap.String("error_type_text", logonErrorTypeText(typeID)))
			}
		}
	}
	c.logger.Info("freerdp save session info", fields...)
	return C.TRUE
}

func goCString(s *C.char) string {
	if s == nil {
		return ""
	}
	return C.GoString(s)
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
	case "rdpdr":
		c.attachDriveRedirection(iface)
	default:
		if cname == "rdpgfx" || cname == "Microsoft::Windows::RDS::Graphics" {
			c.rdpgfx = iface
			c.attachGraphicsPipeline(iface)
		} else if cname == "disp" || cname == "Microsoft::Windows::RDS::DisplayControl" {
			// RDPEDISP — dynamic resolution. Capture the context so input.go can
			// push a monitor-layout PDU on browser resize.
			c.disp = iface
			c.logger.Info("disp (RDPEDISP) channel attached — dynamic resolution live")
		}
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
	default:
		if cname == "rdpgfx" || cname == "Microsoft::Windows::RDS::Graphics" {
			c.rdpgfx = nil
			c.rdpgfxGDIInitialized.Store(false)
		} else if cname == "disp" || cname == "Microsoft::Windows::RDS::DisplayControl" {
			c.disp = nil
		}
	}
}

// ----- bitmap surface updates -----

//export goOnBeginPaint
func goOnBeginPaint(ctx *C.rdpContext) C.BOOL {
	if c := registry.get(unsafe.Pointer(ctx)); c != nil {
		c.beginPaints.Add(1)
	}
	hwnd := gdiHwnd(ctx)
	if hwnd == nil {
		return C.TRUE
	}
	if hwnd.invalid != nil {
		hwnd.invalid.null = C.TRUE
	}
	hwnd.ninvalid = 0
	return C.TRUE
}

//export goOnEndPaint
func goOnEndPaint(ctx *C.rdpContext) C.BOOL {
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil {
		return C.FALSE
	}
	c.endPaints.Add(1)
	flushGDIInvalidRegions(c, ctx, nil)
	return C.TRUE
}

//export goOnBitmapUpdate
func goOnBitmapUpdate(ctx *C.rdpContext, bitmap *C.BITMAP_UPDATE) C.BOOL {
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil {
		return C.FALSE
	}
	if bitmap == nil || bitmap.number == 0 {
		return C.TRUE
	}
	bitmapCount := uint64(bitmap.number)
	if c.bitmapUpdates.Add(bitmapCount) == bitmapCount {
		c.logger.Info("phase: first bitmap update from server",
			zap.Uint32("rectangle_count", uint32(bitmap.number)))
	}
	// wBitmapUpdate in cgo_wrappers.go has already let FreeRDP's GDI decode
	// and invalidate the touched region. goOnEndPaint emits the final decoded
	// rectangles for bitmap, surface, and primary-order updates from one path.
	return C.TRUE
}

//export goOnSurfaceBits
func goOnSurfaceBits(ctx *C.rdpContext, cmd *C.SURFACE_BITS_COMMAND) C.BOOL {
	c := registry.get(unsafe.Pointer(ctx))
	if c == nil {
		return C.FALSE
	}
	count := c.surfaceBits.Add(1)
	var fallback *gdiRect
	if cmd != nil {
		x := int32(cmd.destLeft)
		y := int32(cmd.destTop)
		w := int32(cmd.destRight) - x
		h := int32(cmd.destBottom) - y
		if w > 0 && h > 0 {
			fallback = &gdiRect{x: x, y: y, w: w, h: h}
		}
		if count == 1 {
			c.logger.Info("phase: first surface bits update from server",
				zap.Uint32("x", uint32(cmd.destLeft)),
				zap.Uint32("y", uint32(cmd.destTop)),
				zap.Uint32("right", uint32(cmd.destRight)),
				zap.Uint32("bottom", uint32(cmd.destBottom)),
				zap.Uint32("codec_id", uint32(cmd.bmp.codecID)),
				zap.Uint32("bpp", uint32(cmd.bmp.bpp)),
				zap.Uint32("width", uint32(cmd.bmp.width)),
				zap.Uint32("height", uint32(cmd.bmp.height)),
				zap.Uint32("bytes", uint32(cmd.bmp.bitmapDataLength)))
		}
	}
	flushGDIInvalidRegions(c, ctx, fallback)
	return C.TRUE
}

type gdiRect struct {
	x int32
	y int32
	w int32
	h int32
}

func flushGDIInvalidRegions(c *Client, ctx *C.rdpContext, fallback *gdiRect) {
	if ctx == nil || ctx.gdi == nil || ctx.gdi.suppressOutput != C.FALSE {
		return
	}
	hwnd := gdiHwnd(ctx)
	if hwnd == nil {
		return
	}

	// WebRTC mode: FreeRDP has already composited this update into
	// primary_buffer; the run loop VP8-encodes that for the video track. Just
	// flag it dirty and drop the dirty rects — no per-region bitmap frames.
	if c.webrtcMode.Load() {
		c.markVideoDirty()
		if hwnd.invalid != nil {
			hwnd.invalid.null = C.TRUE
		}
		hwnd.ninvalid = 0
		return
	}

	emitted := false
	if hwnd.ninvalid > 0 && hwnd.cinvalid != nil {
		regions := unsafe.Slice(hwnd.cinvalid, int(hwnd.ninvalid))
		c.paintRegions.Add(uint64(len(regions)))
		first := true
		var minX, minY, maxX, maxY int32
		for i := range regions {
			rx, ry := int32(regions[i].x), int32(regions[i].y)
			rw, rh := int32(regions[i].w), int32(regions[i].h)
			if rw <= 0 || rh <= 0 {
				continue
			}
			right := rx + rw
			bottom := ry + rh
			if first {
				minX, minY, maxX, maxY = rx, ry, right, bottom
				first = false
				continue
			}
			if rx < minX {
				minX = rx
			}
			if ry < minY {
				minY = ry
			}
			if right > maxX {
				maxX = right
			}
			if bottom > maxY {
				maxY = bottom
			}
		}
		if !first && maxX > minX && maxY > minY {
			emitGDIRegion(c, ctx, C.INT32(minX), C.INT32(minY), C.INT32(maxX-minX), C.INT32(maxY-minY))
			emitted = true
		}
	} else if hwnd.invalid != nil && hwnd.invalid.null == C.FALSE {
		r := hwnd.invalid
		c.paintRegions.Add(1)
		emitGDIRegion(c, ctx, r.x, r.y, r.w, r.h)
		emitted = true
	} else if fallback != nil {
		c.paintRegions.Add(1)
		emitGDIRegion(c, ctx, C.INT32(fallback.x), C.INT32(fallback.y), C.INT32(fallback.w), C.INT32(fallback.h))
		emitted = true
	}

	if !emitted {
		c.emptyPaints.Add(1)
	}
	if hwnd.invalid != nil {
		hwnd.invalid.null = C.TRUE
	}
	hwnd.ninvalid = 0
}

func gdiHwnd(ctx *C.rdpContext) *C.GDI_WND {
	if ctx == nil || ctx.gdi == nil || ctx.gdi.primary_buffer == nil {
		return nil
	}
	if ctx.gdi.primary == nil || ctx.gdi.primary.hdc == nil {
		return nil
	}
	return ctx.gdi.primary.hdc.hwnd
}

func emitGDIRegion(c *Client, ctx *C.rdpContext, x, y, w, h C.INT32) {
	if ctx == nil || ctx.gdi == nil || ctx.gdi.primary_buffer == nil {
		return
	}
	stride := uint32(ctx.gdi.stride)
	if stride == 0 {
		stride = uint32(ctx.gdi.bitmap_stride)
	}
	surfaceW := int32(ctx.gdi.width)
	surfaceH := int32(ctx.gdi.height)
	rx, ry, rw, rh := int32(x), int32(y), int32(w), int32(h)
	if stride == 0 || surfaceW <= 0 || surfaceH <= 0 || rw <= 0 || rh <= 0 {
		return
	}
	if rx < 0 {
		rw += rx
		rx = 0
	}
	if ry < 0 {
		rh += ry
		ry = 0
	}
	if rx >= surfaceW || ry >= surfaceH || rw <= 0 || rh <= 0 {
		return
	}
	if rx+rw > surfaceW {
		rw = surfaceW - rx
	}
	if ry+rh > surfaceH {
		rh = surfaceH - ry
	}

	ux, uy := uint32(rx), uint32(ry)
	uw, uh := uint32(rw), uint32(rh)
	rowBytes := uw * 4
	if rowBytes == 0 || (ux*4)+rowBytes > stride {
		return
	}
	buf := make([]byte, 0, rowBytes*uh)
	base := unsafe.Pointer(ctx.gdi.primary_buffer)
	for row := uint32(0); row < uh; row++ {
		offset := uintptr((uy+row)*stride + ux*4)
		src := unsafe.Slice((*byte)(unsafe.Add(base, offset)), rowBytes)
		buf = append(buf, src...)
	}
	c.submitFrame(ux, uy, uw, uh, buf)
}

func (c *Client) emitPendingFrameResync(reason string) {
	if !c.frameResyncPending.Load() || c.context == nil {
		return
	}
	if cap(c.out) > 0 && len(c.out)*2 >= cap(c.out) {
		return
	}
	if !c.frameResyncPending.CompareAndSwap(true, false) {
		return
	}
	if !c.emitFullGDIFrame(reason) {
		c.frameResyncPending.Store(true)
	}
}

func (c *Client) emitFullGDIFrame(reason string) bool {
	if c.context == nil {
		return false
	}
	ctx := (*C.rdpContext)(c.context)
	if ctx == nil || ctx.gdi == nil || ctx.gdi.primary_buffer == nil || ctx.gdi.suppressOutput != C.FALSE {
		return false
	}
	w := int32(ctx.gdi.width)
	h := int32(ctx.gdi.height)
	if w <= 0 || h <= 0 {
		return false
	}
	count := c.frameResyncs.Add(1)
	if count == 1 || count%10 == 0 {
		c.logger.Info("desktop frame resync emitting full frame",
			zap.String("reason", reason),
			zap.Uint64("resync_count", count),
			zap.Int32("width", w),
			zap.Int32("height", h),
			zap.Int("queue_len", len(c.out)),
			zap.Int("queue_cap", cap(c.out)))
	}
	emitGDIRegion(c, ctx, 0, 0, C.INT32(w), C.INT32(h))
	return true
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
	c.desktopResizes.Add(1)
	c.logger.Info("freerdp desktop resized",
		zap.Uint32("width", c.width),
		zap.Uint32("height", c.height),
		zap.Uint64("resize_count", c.desktopResizes.Load()))
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
	// Decode the pointer's xor/and masks into tightly-packed top-down BGRA32.
	// Shipping raw xorMaskData only rendered 32bpp opaque cursors correctly;
	// freerdp_image_copy_from_pointer_data handles 1/16/24/32bpp, the AND
	// transparency mask, and the RDP bottom-up→top-down flip. Wire encoding
	// stays raw_bgra so the browser path is unchanged.
	bgra := make([]byte, int(w)*int(h)*4)
	if !goBool(C.wDecodePointerBGRA(ctx, pointer, (*C.BYTE)(unsafe.Pointer(&bgra[0])))) {
		return C.TRUE
	}
	if dedup := hash64(bgra); dedup == c.lastCursorHash {
		return C.TRUE
	} else {
		c.lastCursorHash = dedup
	}
	c.emit(desktop.ServerMessage{Cursor: &desktop.CursorUpdate{
		HotspotX: uint32(pointer.xPos),
		HotspotY: uint32(pointer.yPos),
		Width:    w,
		Height:   h,
		Encoding: desktop.CursorEncodingRawBGRA,
		Payload:  bgra,
	}})
	return C.TRUE
}

//export goOnPointerSetNull
func goOnPointerSetNull(ctx *C.rdpContext) C.BOOL {
	if c := registry.get(unsafe.Pointer(ctx)); c != nil {
		c.emit(desktop.ServerMessage{Cursor: &desktop.CursorUpdate{
			Encoding: desktop.CursorEncodingSystem,
			Hidden:   true,
		}})
	}
	return C.TRUE
}

//export goOnPointerSetDefault
func goOnPointerSetDefault(ctx *C.rdpContext) C.BOOL {
	if c := registry.get(unsafe.Pointer(ctx)); c != nil {
		c.emit(desktop.ServerMessage{Cursor: &desktop.CursorUpdate{
			Encoding:   desktop.CursorEncodingSystem,
			SystemKind: "default",
		}})
	}
	return C.TRUE
}

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
