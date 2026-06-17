//go:build freerdp

// channels.go — Plan 17 M2 channel attachment helpers.
//
// FreeRDP's PubSub fires goOnChannelConnected with the (name, pInterface)
// pair when a server-negotiated channel comes up. The interface pointer
// is a typed callback struct — e.g. CliprdrClientContext for "cliprdr".
// We cast it to the right C type, install our callbacks, and stash the
// pointer back on Client so we can call client → server methods later
// (e.g. publish a new clipboard format list when the browser copies).
//
// V1 routing pattern: every server-originated channel event marshals a
// ServerMessage and emits it on c.out; the gateway forwards over WS to
// the browser. Browser-originated events become ClientMessages that the
// inputPump dispatches to per-channel send functions defined here.

package rdp

/*
#cgo pkg-config: freerdp3 freerdp-client3 winpr3
#include <freerdp/freerdp.h>
#include <freerdp/channels/cliprdr.h>
#include <freerdp/channels/rdpsnd.h>
#include <freerdp/channels/rdpdr.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/channels/disp.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/rdpgfx.h>
#include <freerdp/client/disp.h>
#include <string.h>

// wDispSendMonitorLayout pushes a single-monitor desktop resolution to the
// server over RDPEDISP (dynamic resolution). Defined locally because only this
// translation unit calls it. Returns the channel's UINT status (0 = success).
static UINT wDispSendMonitorLayout(DispClientContext* disp, UINT32 width, UINT32 height,
                                   UINT32 desktopScale, UINT32 deviceScale) {
    if (!disp || !disp->SendMonitorLayout) {
        return 1;
    }
    DISPLAY_CONTROL_MONITOR_LAYOUT layout;
    memset(&layout, 0, sizeof(layout));
    layout.Flags = DISPLAY_CONTROL_MONITOR_PRIMARY;
    layout.Left = 0;
    layout.Top = 0;
    layout.Width = width;
    layout.Height = height;
    layout.PhysicalWidth = 0;  // unspecified — let the server keep its DPI mapping
    layout.PhysicalHeight = 0;
    layout.Orientation = 0;    // ORIENTATION_LANDSCAPE
    layout.DesktopScaleFactor = desktopScale;
    layout.DeviceScaleFactor = deviceScale;
    return disp->SendMonitorLayout(disp, 1, &layout);
}

// All helpers live in cgo_wrappers.go; re-declare as extern here.
extern void wInstallCliprdr(CliprdrClientContext* ctx);
extern BOOL wInstallRdpgfx(RdpgfxClientContext* ctx);
extern rdpContext* wRdpgfxRdpContext(RdpgfxClientContext* ctx);
extern UINT wSendCliprdrCapabilities(CliprdrClientContext* ctx);
extern UINT wSendCliprdrFormatList(CliprdrClientContext* ctx,
                                    const CLIPRDR_FORMAT* formats, UINT32 numFormats);
extern UINT wSendCliprdrFormatListResponse(CliprdrClientContext* ctx, UINT16 msgFlags);
extern UINT wSendCliprdrFormatDataResponse(CliprdrClientContext* ctx,
                                            const BYTE* data, UINT32 size);
extern UINT wSendCliprdrFormatDataRequest(CliprdrClientContext* ctx, UINT32 formatId);
*/
import "C"

import (
	"unsafe"

	"github.com/michongs/wayfort/internal/desktop"
	"go.uber.org/zap"
)

// ----- CLIPRDR -----

func (c *Client) attachClipboard(iface unsafe.Pointer) {
	ctx := (*C.CliprdrClientContext)(iface)
	ctx.custom = c.context
	c.cliprdrCapsSent.Store(false)
	c.cliprdrFormatListSent.Store(false)
	c.logger.Info("cliprdr callbacks attached")
	C.wInstallCliprdr(ctx)
}

//export goCliprdrMonitorReady
func goCliprdrMonitorReady(ctx *C.CliprdrClientContext, mr *C.CLIPRDR_MONITOR_READY) C.UINT {
	if ctx == nil {
		return 0
	}
	// Complete the MS-RDPECLIP startup handshake. Without this pair some
	// Windows builds wait for client caps/format-list and then close the RDP
	// transport, which surfaces upstream as BIO_read retries exceeded.
	c := lookupByCustom(ctx.custom)
	if c != nil {
		c.logger.Info("cliprdr monitor ready",
			zap.Bool("caps_sent", c.cliprdrCapsSent.Load()),
			zap.Bool("format_list_sent", c.cliprdrFormatListSent.Load()))
	}
	if rc := sendCliprdrCapabilitiesOnce(ctx); rc != 0 {
		if c != nil {
			c.logger.Warn("cliprdr client capabilities send failed", zap.Uint32("rc", uint32(rc)))
		}
		return rc
	}
	if c != nil && c.cliprdrFormatListSent.Swap(true) {
		return 0
	}
	rc := C.wSendCliprdrFormatList(ctx, (*C.CLIPRDR_FORMAT)(nil), 0)
	if c != nil {
		c.logger.Info("cliprdr initial client format list sent", zap.Uint32("rc", uint32(rc)))
	}
	return rc
}

//export goCliprdrServerCapabilities
func goCliprdrServerCapabilities(ctx *C.CliprdrClientContext, caps *C.CLIPRDR_CAPABILITIES) C.UINT {
	if ctx == nil {
		return 0
	}
	if c := lookupByCustom(ctx.custom); c != nil {
		c.logger.Info("cliprdr server capabilities received")
	}
	return sendCliprdrCapabilitiesOnce(ctx)
}

func sendCliprdrCapabilitiesOnce(ctx *C.CliprdrClientContext) C.UINT {
	if ctx == nil {
		return 0
	}
	c := lookupByCustom(ctx.custom)
	if c != nil && c.cliprdrCapsSent.Swap(true) {
		return 0
	}
	rc := C.wSendCliprdrCapabilities(ctx)
	if c != nil {
		c.logger.Info("cliprdr client capabilities sent", zap.Uint32("rc", uint32(rc)))
	}
	return rc
}

//export goCliprdrServerFormatList
func goCliprdrServerFormatList(ctx *C.CliprdrClientContext, fl *C.CLIPRDR_FORMAT_LIST) C.UINT {
	if ctx == nil {
		return 0
	}
	c := lookupByCustom(ctx.custom)
	if c == nil || fl == nil {
		return 0
	}
	hasUnicodeText := false
	if fl.formats != nil {
		formats := unsafe.Slice(fl.formats, int(fl.numFormats))
		for _, f := range formats {
			if f.formatId == C.CF_UNICODETEXT {
				hasUnicodeText = true
				break
			}
		}
	}
	c.logger.Info("cliprdr server format list received",
		zap.Uint32("num_formats", uint32(fl.numFormats)),
		zap.Bool("has_unicode_text", hasUnicodeText))
	C.wSendCliprdrFormatListResponse(ctx, C.CB_RESPONSE_OK)
	if fl.formats == nil {
		return 0
	}
	formats := unsafe.Slice(fl.formats, int(fl.numFormats))
	for _, f := range formats {
		if f.formatId == C.CF_UNICODETEXT {
			c.logger.Info("cliprdr requesting server unicode text")
			C.wSendCliprdrFormatDataRequest(ctx, C.CF_UNICODETEXT)
			return 0
		}
	}
	c.logger.Debug("cliprdr server format list did not include CF_UNICODETEXT")
	return 0
}

//export goCliprdrServerFormatListResponse
func goCliprdrServerFormatListResponse(ctx *C.CliprdrClientContext, r *C.CLIPRDR_FORMAT_LIST_RESPONSE) C.UINT {
	return 0
}

//export goCliprdrServerFormatDataRequest
func goCliprdrServerFormatDataRequest(ctx *C.CliprdrClientContext, r *C.CLIPRDR_FORMAT_DATA_REQUEST) C.UINT {
	// Server is asking the browser for clipboard data. We respond with
	// the latest text the browser pushed. If nothing is staged we reply
	// with empty bytes (still completes the handshake).
	if ctx == nil {
		return 0
	}
	c := lookupByCustom(ctx.custom)
	if c == nil {
		return 0
	}
	formatID := uint32(0)
	if r != nil {
		formatID = uint32(r.requestedFormatId)
	}
	c.logger.Info("cliprdr server format data request received", zap.Uint32("format_id", formatID))
	c.mu.Lock()
	body := append([]byte(nil), c.pendingClipText...)
	c.mu.Unlock()
	if body == nil {
		body = []byte{}
	}
	var dataPtr *C.BYTE
	if len(body) > 0 {
		dataPtr = (*C.BYTE)(unsafe.Pointer(&body[0]))
	}
	C.wSendCliprdrFormatDataResponse(ctx, dataPtr, C.UINT32(len(body)))
	return 0
}

//export goCliprdrServerFormatDataResponse
func goCliprdrServerFormatDataResponse(ctx *C.CliprdrClientContext, r *C.CLIPRDR_FORMAT_DATA_RESPONSE) C.UINT {
	c := lookupByCustom(ctx.custom)
	if c == nil || r == nil {
		return 0
	}
	if r.common.msgFlags&C.CB_RESPONSE_FAIL != 0 {
		return 0
	}
	n := uint32(r.common.dataLen)
	if n == 0 || r.requestedFormatData == nil {
		return 0
	}
	body := C.GoBytes(unsafe.Pointer(r.requestedFormatData), C.int(n))
	c.emit(desktop.ServerMessage{Clipboard: &desktop.ClipboardData{
		MIME:    "text/plain;charset=utf-16le",
		Payload: body,
	}})
	return 0
}

// pushClipboardText is called from the input pump when the browser
// publishes new text. We stash it for the server's next FormatDataRequest
// and proactively send a FORMAT_LIST so the server knows the format set
// changed.
func (c *Client) pushClipboardText(text string) {
	c.mu.Lock()
	c.pendingClipText = utf16leEncode(text)
	c.mu.Unlock()
	if c.cliprdr == nil {
		return
	}
	cctx := (*C.CliprdrClientContext)(c.cliprdr)
	var fmt C.CLIPRDR_FORMAT
	fmt.formatId = C.CF_UNICODETEXT
	C.wSendCliprdrFormatList(cctx, &fmt, 1)
}

func (c *Client) pushClipboardUTF16LE(body []byte) {
	c.mu.Lock()
	c.pendingClipText = ensureUTF16LENULTerminated(body)
	c.mu.Unlock()
	if c.cliprdr == nil {
		return
	}
	cctx := (*C.CliprdrClientContext)(c.cliprdr)
	var fmt C.CLIPRDR_FORMAT
	fmt.formatId = C.CF_UNICODETEXT
	C.wSendCliprdrFormatList(cctx, &fmt, 1)
}

// ----- RDPSND -----
//
// FreeRDP 3.x exposes RDPSND via the `rdpsndDevicePlugin` device-plugin
// pattern, NOT a typed CliprdrClientContext-style callback struct. To
// forward server audio to the browser we'd need to register a custom
// rdpsndDevicePlugin whose pcPlay/pcPlayEx callbacks ship bytes through
// our `emit`. That's ~300 lines of cgo on its own and lands in Plan 17
// M2.x. Audio playback is forced off in client.go until that path exists.
func (c *Client) attachAudio(iface unsafe.Pointer) {
	c.logger.Info("rdpsnd channel attached (device-plugin wiring deferred to M2.x)")
}

// ----- RDPGFX (RemoteFX / AVC444) -----

const maxRdpgfxEncodedPayloadBytes = 64 * 1024 * 1024

// sendMonitorLayout pushes a new desktop resolution to the server over RDPEDISP
// (dynamic resolution). It is a no-op when the disp channel isn't connected (the
// node didn't opt into dynamic_resolution, or the server didn't bring up Display
// Control) — the caller has already recorded the new size for the next reconnect
// as the graceful fallback. width/height are the target physical dims; scale is
// the session's desktop scale factor (percent). Returns true if a layout PDU was
// sent. Runs on the input goroutine.
func (c *Client) sendMonitorLayout(width, height, scale uint32) bool {
	if c.disp == nil {
		return false
	}
	// RDPEDISP requires even, in-range dimensions (MS-RDPEDISP 2.2.2.2).
	w := width &^ 1
	h := height &^ 1
	if w < C.DISPLAY_CONTROL_MIN_MONITOR_WIDTH {
		w = C.DISPLAY_CONTROL_MIN_MONITOR_WIDTH
	} else if w > C.DISPLAY_CONTROL_MAX_MONITOR_WIDTH {
		w = C.DISPLAY_CONTROL_MAX_MONITOR_WIDTH
	}
	if h < C.DISPLAY_CONTROL_MIN_MONITOR_HEIGHT {
		h = C.DISPLAY_CONTROL_MIN_MONITOR_HEIGHT
	} else if h > C.DISPLAY_CONTROL_MAX_MONITOR_HEIGHT {
		h = C.DISPLAY_CONTROL_MAX_MONITOR_HEIGHT
	}
	// DesktopScaleFactor valid 100..500; DeviceScaleFactor restricted to
	// {100,140,180} (mirrors applySettings' high-DPI snapping). scale<=100 →
	// unscaled (100/100).
	desktopScale := scale
	if desktopScale < 100 || desktopScale > 500 {
		desktopScale = 100
	}
	deviceScale := uint32(100)
	if desktopScale >= 160 {
		deviceScale = 180
	} else if desktopScale >= 120 {
		deviceScale = 140
	}
	rc := C.wDispSendMonitorLayout((*C.DispClientContext)(c.disp),
		C.UINT32(w), C.UINT32(h), C.UINT32(desktopScale), C.UINT32(deviceScale))
	if rc != 0 {
		c.logger.Warn("disp monitor layout send failed",
			zap.Uint32("rc", uint32(rc)), zap.Uint32("w", uint32(w)), zap.Uint32("h", uint32(h)))
		return false
	}
	c.logger.Info("disp monitor layout sent (dynamic resolution)",
		zap.Uint32("w", uint32(w)), zap.Uint32("h", uint32(h)), zap.Uint32("desktop_scale", desktopScale))
	return true
}

func (c *Client) attachGraphicsPipeline(iface unsafe.Pointer) {
	ctx := (*C.RdpgfxClientContext)(iface)
	c.rdpgfxMu.Lock()
	c.rdpgfxSurfaces = make(map[uint16]rdpgfxSurfaceState)
	c.rdpgfxMu.Unlock()
	ctx.custom = c.context
	ok := goBool(C.wInstallRdpgfx(ctx))
	c.rdpgfxGDIInitialized.Store(ok)
	if !ok {
		c.logger.Warn("rdpgfx channel attached but GDI graphics pipeline initialization failed")
		return
	}
	c.logger.Info("rdpgfx GDI graphics pipeline callbacks attached")
}

//export goRdpgfxSurfaceCommand
func goRdpgfxSurfaceCommand(ctx *C.RdpgfxClientContext, cmd *C.RDPGFX_SURFACE_COMMAND) C.UINT {
	c, _ := clientFromRdpgfx(ctx)
	if c == nil || cmd == nil {
		return 0
	}
	count := c.rdpgfxSurfaceCommands.Add(1)
	if count == 1 {
		c.logger.Info("phase: first rdpgfx surface command received",
			zap.Uint32("surface_id", uint32(cmd.surfaceId)),
			zap.Uint32("codec_id", uint32(cmd.codecId)),
			zap.String("codec", rdpgfxCodecName(uint32(cmd.codecId))),
			zap.Uint32("left", uint32(cmd.left)),
			zap.Uint32("top", uint32(cmd.top)),
			zap.Uint32("right", uint32(cmd.right)),
			zap.Uint32("bottom", uint32(cmd.bottom)),
			zap.Uint32("width", uint32(cmd.width)),
			zap.Uint32("height", uint32(cmd.height)),
			zap.Uint32("bytes", uint32(cmd.length)))
	}
	if c.gfxServerDecode.Load() {
		// AVC444 mode: skip the raw forward. The surface-command count above still
		// advanced (so goRdpgfxEndFrameAfter knows GFX activity happened) but we
		// emit no per-command frame here — FreeRDP's decoder (invoked right after
		// this in wRdpgfxSurfaceCommand) writes the 4:4:4 result into primary_buffer,
		// and goRdpgfxEndFrameAfter emits the decoded full frame to the browser.
		return 0
	}
	c.forwardRdpgfxSurfaceCommand(cmd)
	return 0
}

func (c *Client) forwardRdpgfxSurfaceCommand(cmd *C.RDPGFX_SURFACE_COMMAND) {
	if cmd == nil || cmd.data == nil || cmd.length == 0 || cmd.length > maxRdpgfxEncodedPayloadBytes {
		return
	}
	originX, originY := c.rdpgfxSurfaceOutputOrigin(uint16(cmd.surfaceId))
	payload := C.GoBytes(unsafe.Pointer(cmd.data), C.int(cmd.length))
	frame, ok := rdpgfxSurfaceCommandFrame(
		uint32(cmd.codecId),
		originX,
		originY,
		uint32(cmd.left),
		uint32(cmd.top),
		uint32(cmd.right),
		uint32(cmd.bottom),
		uint32(cmd.width),
		uint32(cmd.height),
		payload,
	)
	if !ok {
		return
	}
	if !c.firstFrameLogged.Swap(true) {
		c.logger.Info("phase: first forwarded rdpgfx encoded frame from server",
			zap.Uint32("x", frame.X),
			zap.Uint32("y", frame.Y),
			zap.Uint32("width", frame.Width),
			zap.Uint32("height", frame.Height),
			zap.String("encoding", string(frame.Encoding)),
			zap.Bool("keyframe", frame.Keyframe),
			zap.Int("payload_bytes", len(frame.Payload)))
	}
	seq := c.frameSeq.Add(1) - 1
	c.completeFrame(seq, desktop.ServerMessage{Frame: &frame})
}

func (c *Client) rdpgfxSurfaceOutputOrigin(surfaceID uint16) (uint32, uint32) {
	c.rdpgfxMu.Lock()
	defer c.rdpgfxMu.Unlock()
	state, ok := c.rdpgfxSurfaces[surfaceID]
	if !ok || !state.mapped {
		return 0, 0
	}
	return state.outputX, state.outputY
}

func rdpgfxSurfaceCommandFrame(codecID, originX, originY, left, top, right, bottom, width, height uint32, payload []byte) (desktop.FrameRect, bool) {
	x, y, w, h, ok := rdpgfxSurfaceDestination(originX, originY, left, top, right, bottom, width, height)
	if !ok || len(payload) == 0 {
		return desktop.FrameRect{}, false
	}
	switch codecID {
	case C.RDPGFX_CODECID_AVC420:
		if stripped, ok := stripAvc420Wrapper(payload); ok {
			payload = stripped
		}
		nal, ok := normalizeH264AnnexB(payload)
		if !ok {
			return desktop.FrameRect{}, false
		}
		return desktop.FrameRect{
			X:        x,
			Y:        y,
			Width:    w,
			Height:   h,
			Encoding: desktop.EncodingH264,
			Keyframe: nalStreamHasKeyframe(nal),
			Payload:  nal,
		}, true
	case C.RDPGFX_CODECID_CAPROGRESSIVE, C.RDPGFX_CODECID_CAPROGRESSIVE_V2:
		return desktop.FrameRect{
			X:        x,
			Y:        y,
			Width:    w,
			Height:   h,
			Encoding: desktop.EncodingRFX,
			Payload:  payload,
		}, true
	default:
		return desktop.FrameRect{}, false
	}
}

func rdpgfxSurfaceDestination(originX, originY, left, top, right, bottom, width, height uint32) (uint32, uint32, uint32, uint32, bool) {
	w := width
	h := height
	if right > left {
		w = right - left
	}
	if bottom > top {
		h = bottom - top
	}
	if w == 0 || h == 0 {
		return 0, 0, 0, 0, false
	}
	if x := uint64(originX) + uint64(left); x <= uint64(^uint32(0)) {
		if y := uint64(originY) + uint64(top); y <= uint64(^uint32(0)) {
			return uint32(x), uint32(y), w, h, true
		}
	}
	return 0, 0, 0, 0, false
}

// stripAvc420Wrapper peels off the [MS-RDPEGFX 2.2.4.4.1]
// AVC420EncodedBitmapStream header so the worker can forward the raw
// H.264 NAL bitstream to the browser. The header layout is:
//
//	numRegionRects:   UINT32 little-endian
//	regionRects:      numRegionRects * 8 bytes (RDPGFX_RECT16: l,t,r,b each U16)
//	quantQualityVals: numRegionRects * 2 bytes (QP+flags + qualityVal)
//	avc420 stream:    variable
//
// Returns (nil, false) if the buffer is too short or the rect count is
// implausible (>4096 keeps DOS at bay; real desktops have <16 dirty
// regions per frame). The boolean tells the caller the wrapper was
// not detected — the caller then keeps the original buf intact for
// the browser-side decoder to surface a precise error.
func stripAvc420Wrapper(buf []byte) ([]byte, bool) {
	if len(buf) < 4 {
		return nil, false
	}
	regionCount := uint32(buf[0]) | uint32(buf[1])<<8 | uint32(buf[2])<<16 | uint32(buf[3])<<24
	if regionCount > 4096 {
		return nil, false
	}
	headerLen := 4 + int(regionCount)*(8+2)
	if len(buf) < headerLen {
		return nil, false
	}
	return buf[headerLen:], true
}

// nalStreamHasKeyframe scans the first ~64 bytes of an Annex-B H.264
// stream for an SPS (type 7), PPS (type 8), or IDR slice (type 5).
// Any of those makes the chunk a decode entry point. We only look at
// the head of the stream because keyframe NALs are always at the
// front; scanning the whole payload would burn CPU for no benefit.
func nalStreamHasKeyframe(nal []byte) bool {
	scanLen := len(nal)
	if scanLen > 64 {
		scanLen = 64
	}
	for i := 0; i+3 < scanLen; i++ {
		// Annex-B start codes: 00 00 00 01 (4-byte) or 00 00 01 (3-byte).
		var nalByte byte
		switch {
		case nal[i] == 0 && nal[i+1] == 0 && nal[i+2] == 0 && nal[i+3] == 1:
			if i+4 >= scanLen {
				return false
			}
			nalByte = nal[i+4]
		case nal[i] == 0 && nal[i+1] == 0 && nal[i+2] == 1:
			nalByte = nal[i+3]
		default:
			continue
		}
		switch nalByte & 0x1F {
		case 5:
			return true
		}
	}
	return false
}

func normalizeH264AnnexB(buf []byte) ([]byte, bool) {
	if startsWithAnnexBStartCode(buf) {
		return buf, true
	}
	if len(buf) < 5 {
		return nil, false
	}
	out := make([]byte, 0, len(buf)+16)
	for pos := 0; pos < len(buf); {
		if len(buf)-pos < 4 {
			return nil, false
		}
		n := int(buf[pos])<<24 | int(buf[pos+1])<<16 | int(buf[pos+2])<<8 | int(buf[pos+3])
		pos += 4
		if n <= 0 || n > len(buf)-pos {
			return nil, false
		}
		out = append(out, 0x00, 0x00, 0x00, 0x01)
		out = append(out, buf[pos:pos+n]...)
		pos += n
	}
	return out, true
}

func startsWithAnnexBStartCode(buf []byte) bool {
	return (len(buf) > 4 && buf[0] == 0 && buf[1] == 0 && buf[2] == 0 && buf[3] == 1) ||
		(len(buf) > 3 && buf[0] == 0 && buf[1] == 0 && buf[2] == 1)
}

//export goRdpgfxResetGraphics
func goRdpgfxResetGraphics(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_RESET_GRAPHICS_PDU) C.UINT {
	c, _ := clientFromRdpgfx(ctx)
	if c == nil || pdu == nil {
		return 0
	}
	c.rdpgfxResetGraphics.Add(1)
	c.width = uint32(pdu.width)
	c.height = uint32(pdu.height)
	c.rdpgfxMu.Lock()
	c.rdpgfxSurfaces = make(map[uint16]rdpgfxSurfaceState)
	c.rdpgfxMu.Unlock()
	c.logger.Info("rdpgfx reset graphics",
		zap.Uint32("width", uint32(pdu.width)),
		zap.Uint32("height", uint32(pdu.height)),
		zap.Uint32("monitors", uint32(pdu.monitorCount)))
	c.requestDesktopRefresh("rdpgfx reset graphics")
	return 0
}

//export goRdpgfxOnOpen
func goRdpgfxOnOpen(ctx *C.RdpgfxClientContext, doCapsAdvertise *C.BOOL, doFrameAcks *C.BOOL) C.UINT {
	c, _ := clientFromRdpgfx(ctx)
	if c == nil {
		return 0
	}
	count := c.rdpgfxOnOpen.Add(1)
	if doCapsAdvertise != nil {
		*doCapsAdvertise = C.TRUE
	}
	if doFrameAcks != nil {
		*doFrameAcks = C.TRUE
	}
	c.logger.Info("rdpgfx channel open",
		zap.Uint64("count", count),
		zap.Bool("caps_advertise", doCapsAdvertise != nil && goBool(*doCapsAdvertise)),
		zap.Bool("frame_acks", doFrameAcks != nil && goBool(*doFrameAcks)))
	return 0
}

//export goRdpgfxOnClose
func goRdpgfxOnClose(ctx *C.RdpgfxClientContext) C.UINT {
	if c, _ := clientFromRdpgfx(ctx); c != nil {
		c.rdpgfxOnClose.Add(1)
		c.rdpgfxGDIInitialized.Store(false)
	}
	return 0
}

//export goRdpgfxCapsAdvertise
func goRdpgfxCapsAdvertise(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_CAPS_ADVERTISE_PDU) C.UINT {
	c, _ := clientFromRdpgfx(ctx)
	if c == nil || pdu == nil {
		return 0
	}
	count := c.rdpgfxCapsAdvertise.Add(1)
	c.logger.Info("rdpgfx caps advertise",
		zap.Uint64("count", count),
		zap.Uint32("capset_count", uint32(pdu.capsSetCount)),
		zap.Strings("capsets", rdpgfxCapsetNames(pdu)))
	return 0
}

//export goRdpgfxCapsConfirm
func goRdpgfxCapsConfirm(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_CAPS_CONFIRM_PDU) C.UINT {
	c, _ := clientFromRdpgfx(ctx)
	if c == nil || pdu == nil || pdu.capsSet == nil {
		return 0
	}
	version := uint32(pdu.capsSet.version)
	flags := uint32(pdu.capsSet.flags)
	c.rdpgfxCapsVersion.Store(version)
	c.rdpgfxCapsFlags.Store(flags)
	count := c.rdpgfxCapsConfirm.Add(1)
	c.logger.Info("rdpgfx caps confirmed",
		zap.Uint64("count", count),
		zap.Uint32("version", version),
		zap.String("version_text", rdpgfxCapVersionName(version)),
		zap.Uint32("flags", flags))
	return 0
}

//export goRdpgfxCreateSurface
func goRdpgfxCreateSurface(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_CREATE_SURFACE_PDU) C.UINT {
	c, _ := clientFromRdpgfx(ctx)
	if c == nil || pdu == nil {
		return 0
	}
	c.rdpgfxCreateSurfaces.Add(1)
	c.rdpgfxMu.Lock()
	if c.rdpgfxSurfaces == nil {
		c.rdpgfxSurfaces = make(map[uint16]rdpgfxSurfaceState)
	}
	c.rdpgfxSurfaces[uint16(pdu.surfaceId)] = rdpgfxSurfaceState{
		id:           uint16(pdu.surfaceId),
		width:        uint32(pdu.width),
		height:       uint32(pdu.height),
		pixelFormat:  uint8(pdu.pixelFormat),
		targetWidth:  uint32(pdu.width),
		targetHeight: uint32(pdu.height),
	}
	c.rdpgfxMu.Unlock()
	return 0
}

//export goRdpgfxDeleteSurface
func goRdpgfxDeleteSurface(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_DELETE_SURFACE_PDU) C.UINT {
	c, _ := clientFromRdpgfx(ctx)
	if c == nil || pdu == nil {
		return 0
	}
	c.rdpgfxDeleteSurfaces.Add(1)
	c.rdpgfxMu.Lock()
	delete(c.rdpgfxSurfaces, uint16(pdu.surfaceId))
	c.rdpgfxMu.Unlock()
	return 0
}

//export goRdpgfxDeleteEncodingContext
func goRdpgfxDeleteEncodingContext(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_DELETE_ENCODING_CONTEXT_PDU) C.UINT {
	return 0
}

//export goRdpgfxSolidFill
func goRdpgfxSolidFill(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_SOLID_FILL_PDU) C.UINT {
	if c, _ := clientFromRdpgfx(ctx); c != nil {
		c.rdpgfxSolidFills.Add(1)
	}
	return 0
}

//export goRdpgfxSurfaceToSurface
func goRdpgfxSurfaceToSurface(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_SURFACE_TO_SURFACE_PDU) C.UINT {
	if c, _ := clientFromRdpgfx(ctx); c != nil {
		c.rdpgfxSurfaceToSurface.Add(1)
	}
	return 0
}

//export goRdpgfxSurfaceToCache
func goRdpgfxSurfaceToCache(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_SURFACE_TO_CACHE_PDU) C.UINT {
	if c, _ := clientFromRdpgfx(ctx); c != nil {
		c.rdpgfxSurfaceToCache.Add(1)
	}
	return 0
}

//export goRdpgfxCacheToSurface
func goRdpgfxCacheToSurface(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_CACHE_TO_SURFACE_PDU) C.UINT {
	if c, _ := clientFromRdpgfx(ctx); c != nil {
		c.rdpgfxCacheToSurface.Add(1)
	}
	return 0
}

//export goRdpgfxEvictCacheEntry
func goRdpgfxEvictCacheEntry(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_EVICT_CACHE_ENTRY_PDU) C.UINT {
	if c, _ := clientFromRdpgfx(ctx); c != nil {
		c.rdpgfxEvictCache.Add(1)
	}
	return 0
}

//export goRdpgfxMapSurfaceToOutput
func goRdpgfxMapSurfaceToOutput(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU) C.UINT {
	c, _ := clientFromRdpgfx(ctx)
	if c == nil || pdu == nil {
		return 0
	}
	c.rdpgfxMapOutput.Add(1)
	c.rdpgfxMu.Lock()
	state := c.rdpgfxSurfaces[uint16(pdu.surfaceId)]
	state.id = uint16(pdu.surfaceId)
	state.mapped = true
	state.outputX = uint32(pdu.outputOriginX)
	state.outputY = uint32(pdu.outputOriginY)
	if state.targetWidth == 0 {
		state.targetWidth = state.width
	}
	if state.targetHeight == 0 {
		state.targetHeight = state.height
	}
	c.rdpgfxSurfaces[uint16(pdu.surfaceId)] = state
	c.rdpgfxMu.Unlock()
	return 0
}

//export goRdpgfxMapSurfaceToScaledOutput
func goRdpgfxMapSurfaceToScaledOutput(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_MAP_SURFACE_TO_SCALED_OUTPUT_PDU) C.UINT {
	c, _ := clientFromRdpgfx(ctx)
	if c == nil || pdu == nil {
		return 0
	}
	c.rdpgfxMapScaledOutput.Add(1)
	c.rdpgfxMu.Lock()
	state := c.rdpgfxSurfaces[uint16(pdu.surfaceId)]
	state.id = uint16(pdu.surfaceId)
	state.mapped = true
	state.outputX = uint32(pdu.outputOriginX)
	state.outputY = uint32(pdu.outputOriginY)
	state.targetWidth = uint32(pdu.targetWidth)
	state.targetHeight = uint32(pdu.targetHeight)
	c.rdpgfxSurfaces[uint16(pdu.surfaceId)] = state
	c.rdpgfxMu.Unlock()
	return 0
}

//export goRdpgfxStartFrame
func goRdpgfxStartFrame(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_START_FRAME_PDU) C.UINT {
	if c, _ := clientFromRdpgfx(ctx); c != nil {
		c.rdpgfxStartFrames.Add(1)
		// Snapshot the surface-command and forwarded-frame counters at the
		// START of the GFX frame. goRdpgfxEndFrameAfter compares against these
		// to decide whether this frame had surface commands that libfreerdp
		// decoded into the primary buffer but which we forwarded nothing for
		// (a non-AVC/non-CAPROGRESSIVE codec — clearcodec/planar/uncompressed),
		// and must therefore be flushed as a full GDI frame. Capturing at
		// EndFrame (the previous behaviour) was always equal to the post-frame
		// value, so the fallback never fired and those frames were lost.
		c.rdpgfxEndFrameSeqBase.Store(c.frameSeq.Load())
		c.rdpgfxEndFrameCmdBase.Store(c.rdpgfxSurfaceCommands.Load())
	}
	return 0
}

//export goRdpgfxEndFrame
func goRdpgfxEndFrame(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_END_FRAME_PDU) C.UINT {
	if c, _ := clientFromRdpgfx(ctx); c != nil {
		c.rdpgfxEndFrames.Add(1)
		c.rdpgfxFrameAcks.Add(1)
	}
	return 0
}

//export goRdpgfxEndFrameAfter
func goRdpgfxEndFrameAfter(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_END_FRAME_PDU, rc C.UINT32) {
	c, _ := clientFromRdpgfx(ctx)
	if c == nil || pdu == nil || rc != 0 {
		return
	}
	if c.rdpgfxSurfaceCommands.Load() == c.rdpgfxEndFrameCmdBase.Load() {
		return
	}
	if c.frameSeq.Load() != c.rdpgfxEndFrameSeqBase.Load() {
		return
	}
	if !c.emitFullGDIFrame("rdpgfx end frame fallback") {
		c.requestFrameResync()
	}
}

//export goRdpgfxUpdateSurfaces
func goRdpgfxUpdateSurfaces(ctx *C.RdpgfxClientContext) C.UINT {
	if c, _ := clientFromRdpgfx(ctx); c != nil {
		c.rdpgfxUpdateSurfaces.Add(1)
	}
	return 0
}

//export goRdpgfxUpdateSurfaceArea
func goRdpgfxUpdateSurfaceArea(ctx *C.RdpgfxClientContext, surfaceID C.UINT16, nrRects C.UINT32, rects *C.RECTANGLE_16) C.UINT {
	if c, _ := clientFromRdpgfx(ctx); c != nil {
		c.rdpgfxUpdateSurfaceAreas.Add(uint64(nrRects))
	}
	return 0
}

func clientFromRdpgfx(ctx *C.RdpgfxClientContext) (*Client, *C.rdpContext) {
	if ctx == nil {
		return nil, nil
	}
	rctx := C.wRdpgfxRdpContext(ctx)
	if rctx == nil {
		return nil, nil
	}
	return registry.get(unsafe.Pointer(rctx)), rctx
}

// Phase 9 — names mirroring the RDPGFX_ORIG_KIND_* macros in
// cgo_wrappers.go. Used in the diagnostic log line so the operator sees
// "surface_command" rather than "8".
var rdpgfxOriginalKindNames = map[uint32]string{
	1:  "reset_graphics",
	2:  "on_open",
	3:  "on_close",
	4:  "caps_advertise",
	5:  "caps_confirm",
	6:  "start_frame",
	7:  "end_frame",
	8:  "surface_command",
	9:  "delete_encoding_context",
	10: "create_surface",
	11: "delete_surface",
	12: "solid_fill",
	13: "surface_to_surface",
	14: "surface_to_cache",
	15: "cache_to_surface",
	16: "evict_cache_entry",
	17: "map_surface_to_output",
	18: "map_surface_to_scaled_output",
	19: "update_surfaces",
	20: "update_surface_area",
}

// goRdpgfxOriginalError is invoked from the C trampolines whenever a
// wOriginalRdpgfx* handler returns a non-OK rc. We bump per-hook
// counters so the gateway's "no first frame" diagnostic log can tell
// the operator exactly what kind of error libfreerdp's local decoder
// hit. The first occurrence of each kind also gets a single Warn log
// so the failure mode is visible without grepping atomic counters.
//
//export goRdpgfxOriginalError
func goRdpgfxOriginalError(ctx *C.RdpgfxClientContext, kind C.UINT32, rc C.UINT32) {
	c, _ := clientFromRdpgfx(ctx)
	if c == nil {
		return
	}
	k := uint32(kind)
	r := uint32(rc)
	c.rdpgfxOriginalErrors.Add(1)
	var firstOfKind uint64
	switch k {
	case 8: // SURFACE_COMMAND — the hot path for AVC / NSCodec / Progressive
		firstOfKind = c.rdpgfxOriginalSurfaceCommandErrors.Add(1)
	case 10: // CREATE_SURFACE — surface registry corruption canary
		firstOfKind = c.rdpgfxOriginalCreateSurfaceErrors.Add(1)
	case 19: // UPDATE_SURFACES — frame envelope sealing failure
		firstOfKind = c.rdpgfxOriginalUpdateSurfacesErrors.Add(1)
	default:
		// Other kinds are state-management and rarely error; bump only
		// the aggregate counter so logs don't add a field per hook.
	}
	if c.logger != nil && firstOfKind == 1 {
		name, ok := rdpgfxOriginalKindNames[k]
		if !ok {
			name = "unknown"
		}
		c.logger.Warn("rdpgfx original handler failed — go-side forward still active",
			zap.Uint32("kind", k),
			zap.String("kind_name", name),
			zap.Uint32("rc", r))
	}
}

func rdpgfxCodecName(codecID uint32) string {
	switch codecID {
	case C.RDPGFX_CODECID_UNCOMPRESSED:
		return "uncompressed"
	case C.RDPGFX_CODECID_CAVIDEO:
		return "cavideo"
	case C.RDPGFX_CODECID_CLEARCODEC:
		return "clearcodec"
	case C.RDPGFX_CODECID_CAPROGRESSIVE:
		return "caprogressive"
	case C.RDPGFX_CODECID_PLANAR:
		return "planar"
	case C.RDPGFX_CODECID_AVC420:
		return "avc420"
	case C.RDPGFX_CODECID_ALPHA:
		return "alpha"
	case C.RDPGFX_CODECID_AVC444:
		return "avc444"
	case C.RDPGFX_CODECID_AVC444v2:
		return "avc444v2"
	default:
		return "unknown"
	}
}

func rdpgfxCapsetNames(pdu *C.RDPGFX_CAPS_ADVERTISE_PDU) []string {
	if pdu == nil || pdu.capsSets == nil || pdu.capsSetCount == 0 {
		return nil
	}
	count := int(pdu.capsSetCount)
	if count > 32 {
		count = 32
	}
	caps := unsafe.Slice(pdu.capsSets, count)
	names := make([]string, 0, len(caps))
	for i := range caps {
		names = append(names, rdpgfxCapVersionName(uint32(caps[i].version)))
	}
	return names
}

func rdpgfxCapVersionName(version uint32) string {
	switch version {
	case C.RDPGFX_CAPVERSION_8:
		return "8"
	case C.RDPGFX_CAPVERSION_81:
		return "8.1"
	case C.RDPGFX_CAPVERSION_10:
		return "10"
	case C.RDPGFX_CAPVERSION_101:
		return "10.1"
	case C.RDPGFX_CAPVERSION_102:
		return "10.2"
	case C.RDPGFX_CAPVERSION_103:
		return "10.3"
	case C.RDPGFX_CAPVERSION_104:
		return "10.4"
	case C.RDPGFX_CAPVERSION_105:
		return "10.5"
	case C.RDPGFX_CAPVERSION_106:
		return "10.6"
	case C.RDPGFX_CAPVERSION_106_ERR:
		return "10.6-errata"
	case C.RDPGFX_CAPVERSION_107:
		return "10.7"
	default:
		return "unknown"
	}
}

// ----- RDPDR (drive redirection / file transfer) -----

func (c *Client) attachDriveRedirection(iface unsafe.Pointer) {
	// rdpdr is up. The redirected drive device was registered into the
	// settings collection in applySettings; libfreerdp's built-in rdpdr +
	// drive sub-addin handle the file IRPs against the host folder, so there
	// is no Go-side IRP wiring to do here. If a drive path was configured but
	// the drive never appears in the remote desktop, the cause is downstream:
	// a server-side group policy disabling drive redirection.
	if c.params.DrivePath != "" {
		c.logger.Info("rdpdr channel up — redirected drive announced",
			zap.String("drive_name", c.params.DriveName),
			zap.String("drive_path", c.params.DrivePath))
	} else {
		c.logger.Info("rdpdr channel up (no drive configured)")
	}
}

// ----- helpers shared with cgo_exports.go -----

// lookupByCustom locates the *Client from a channel context's `.custom`
// field that we stashed at attach time (set to our rdpContext* address —
// the same key as registry.put).
func lookupByCustom(custom unsafe.Pointer) *Client {
	return registry.get(custom)
}

// utf16leEncode → MS clipboard expects UTF-16LE null-terminated for
// CF_UNICODETEXT. We do this manually instead of pulling in
// golang.org/x/text/encoding/unicode to keep cgo build deps minimal.
func utf16leEncode(s string) []byte {
	runes := []rune(s)
	buf := make([]byte, 0, len(runes)*2+2)
	for _, r := range runes {
		if r < 0x10000 {
			buf = append(buf, byte(r), byte(r>>8))
		} else {
			r -= 0x10000
			hi := 0xD800 + (r >> 10)
			lo := 0xDC00 + (r & 0x3FF)
			buf = append(buf, byte(hi), byte(hi>>8), byte(lo), byte(lo>>8))
		}
	}
	buf = append(buf, 0x00, 0x00)
	return buf
}

func ensureUTF16LENULTerminated(body []byte) []byte {
	out := append([]byte(nil), body...)
	if len(out) < 2 || out[len(out)-1] != 0 || out[len(out)-2] != 0 {
		out = append(out, 0, 0)
	}
	return out
}
