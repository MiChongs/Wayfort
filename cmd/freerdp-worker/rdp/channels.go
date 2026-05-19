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
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/rdpgfx.h>

// All helpers live in cgo_wrappers.go; re-declare as extern here.
extern void wInstallCliprdr(CliprdrClientContext* ctx);
extern void wInstallRdpgfx(RdpgfxClientContext* ctx);
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

	"github.com/michongs/jumpserver-anonymous/internal/desktop"
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

func (c *Client) attachGraphicsPipeline(iface unsafe.Pointer) {
	ctx := (*C.RdpgfxClientContext)(iface)
	ctx.custom = c.context
	C.wInstallRdpgfx(ctx)
}

//export goRdpgfxSurfaceCommand
func goRdpgfxSurfaceCommand(ctx *C.RdpgfxClientContext, cmd *C.RDPGFX_SURFACE_COMMAND) C.UINT {
	c := lookupByCustom(ctx.custom)
	if c == nil || cmd == nil {
		return 0
	}
	// Forward the raw codec payload to the browser. Codec id mapping:
	//   RDPGFX_CODECID_AVC420 / AVC444   → EncodingH264 (browser decodes
	//      via WebCodecs.VideoDecoder; AVC444 should never arrive
	//      because client.go disables FreeRDP_GfxAVC444 so the single-
	//      stream decoder can consume what we forward)
	//   RDPGFX_CODECID_PLANAR / UNCOMPRESSED → EncodingRawBGRA
	//   RDPGFX_CODECID_CAVIDEO / CAPROGRESSIVE (RemoteFX) → EncodingRFX
	enc := desktop.EncodingRawBGRA
	switch cmd.codecId {
	case C.RDPGFX_CODECID_AVC420, C.RDPGFX_CODECID_AVC444:
		enc = desktop.EncodingH264
	case C.RDPGFX_CODECID_CAVIDEO, C.RDPGFX_CODECID_CAPROGRESSIVE:
		enc = desktop.EncodingRFX
	case C.RDPGFX_CODECID_PLANAR, C.RDPGFX_CODECID_UNCOMPRESSED:
		enc = desktop.EncodingRawBGRA
	}
	buf := C.GoBytes(unsafe.Pointer(cmd.data), C.int(cmd.length))
	c.emit(desktop.ServerMessage{Frame: &desktop.FrameRect{
		X:        uint32(cmd.left),
		Y:        uint32(cmd.top),
		Width:    uint32(cmd.right - cmd.left),
		Height:   uint32(cmd.bottom - cmd.top),
		Encoding: enc,
		Payload:  buf,
	}})
	return 0
}

//export goRdpgfxCreateSurface
func goRdpgfxCreateSurface(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_CREATE_SURFACE_PDU) C.UINT {
	return 0
}

//export goRdpgfxDeleteSurface
func goRdpgfxDeleteSurface(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_DELETE_SURFACE_PDU) C.UINT {
	return 0
}

//export goRdpgfxStartFrame
func goRdpgfxStartFrame(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_START_FRAME_PDU) C.UINT {
	return 0
}

//export goRdpgfxEndFrame
func goRdpgfxEndFrame(ctx *C.RdpgfxClientContext, pdu *C.RDPGFX_END_FRAME_PDU) C.UINT {
	return 0
}

// ----- RDPDR (drive redirection / file transfer) -----

func (c *Client) attachDriveRedirection(iface unsafe.Pointer) {
	// libfreerdp's rdpdr is currently exposed through CHANNEL_EVENT pubsub
	// rather than a typed Client context. For Plan 17 M2 we simply note
	// that the channel was negotiated; full IRP wiring lands in M2.x.
	c.logger.Info("rdpdr channel attached (forwarding deferred to M2.x)")
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
