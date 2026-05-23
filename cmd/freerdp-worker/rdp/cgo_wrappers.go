//go:build freerdp

// cgo_wrappers.go — C helper functions shared across the package. Each
// .go file in the package re-declares these as `extern` in its own
// #cgo preamble; the bodies live here so the linker has exactly one
// definition.

package rdp

/*
#cgo pkg-config: freerdp3 freerdp-client3 winpr3
// Build against FreeRDP 3's current API surface only. This removes deprecated
// 3.x compatibility fields such as Authenticate and legacy certificate
// callbacks from the public structs at compile time.
#cgo CFLAGS: -DWITHOUT_FREERDP_3x_DEPRECATED
// __STDC_NO_THREADS__ tells winpr/platform.h to skip its `#include <threads.h>`
// branch. C11 <threads.h> is optional in the standard, and MinGW-w64 / UCRT64
// don't ship it (their thread support is winpthreads via <pthread.h> instead).
// winpr falls back to the `__thread` GCC extension for thread-local storage,
// which MinGW handles natively — no functional loss.
#cgo windows CFLAGS: -D__STDC_NO_THREADS__

#include <freerdp/freerdp.h>
#include <freerdp/addin.h>
#include <freerdp/client.h>
#include <freerdp/client/channels.h>
#include <freerdp/channels/channels.h>
#include <freerdp/channels/cliprdr.h>
#include <freerdp/channels/drdynvc.h>
#include <freerdp/channels/rdpsnd.h>
#include <freerdp/channels/rdpdr.h>
#include <freerdp/channels/rdpgfx.h>
#include <freerdp/client/cliprdr.h>
#include <freerdp/client/rdpgfx.h>
#include <freerdp/event.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/gdi/gfx.h>
#include <freerdp/update.h>
#include <freerdp/codec/color.h>
#include <freerdp/input.h>
#include <freerdp/locale/keyboard.h>
#include <freerdp/scancode.h>
#include <freerdp/session.h>
#include <freerdp/settings.h>
#include <winpr/synch.h>
#include <winpr/wtypes.h>

// All Go exports.
extern BOOL goPreConnect(freerdp* instance);
extern BOOL goPostConnect(freerdp* instance);
extern void goPostDisconnect(freerdp* instance);
extern BOOL goAuthenticateEx(freerdp* instance, char** username, char** password, char** domain,
                             rdp_auth_reason reason);
extern int goVerifyX509Certificate(freerdp* instance, const BYTE* data, size_t length,
                                   const char* hostname, UINT16 port, DWORD flags);
extern int goLogonErrorInfo(freerdp* instance, UINT32 data, UINT32 type);
extern void goOnChannelConnected(rdpContext* ctx, const char* name, void* iface);
extern void goOnChannelDisconnected(rdpContext* ctx, const char* name, void* iface);
extern BOOL goOnBitmapUpdate(rdpContext* ctx, const BITMAP_UPDATE* bitmap);
extern BOOL goOnSurfaceBits(rdpContext* ctx, const SURFACE_BITS_COMMAND* cmd);
extern BOOL goOnBeginPaint(rdpContext* ctx);
extern BOOL goOnEndPaint(rdpContext* ctx);
extern BOOL goOnDesktopResize(rdpContext* ctx);
extern BOOL goOnSaveSessionInfo(rdpContext* ctx, UINT32 type, void* data);
extern BOOL goOnPointerNew(rdpContext* ctx, rdpPointer* pointer);
extern void goOnPointerFree(rdpContext* ctx, rdpPointer* pointer);
extern BOOL goOnPointerSet(rdpContext* ctx, rdpPointer* pointer);
extern BOOL goOnPointerSetNull(rdpContext* ctx);
extern BOOL goOnPointerSetDefault(rdpContext* ctx);

extern UINT goCliprdrServerCapabilities(CliprdrClientContext* ctx, const CLIPRDR_CAPABILITIES* caps);
extern UINT goCliprdrServerFormatList(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_LIST* fl);
extern UINT goCliprdrServerFormatListResponse(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_LIST_RESPONSE* r);
extern UINT goCliprdrServerFormatDataRequest(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_DATA_REQUEST* r);
extern UINT goCliprdrServerFormatDataResponse(CliprdrClientContext* ctx, const CLIPRDR_FORMAT_DATA_RESPONSE* r);
extern UINT goCliprdrMonitorReady(CliprdrClientContext* ctx, const CLIPRDR_MONITOR_READY* mr);

extern UINT goRdpgfxSurfaceCommand(RdpgfxClientContext* ctx, const RDPGFX_SURFACE_COMMAND* cmd);
extern UINT goRdpgfxOnOpen(RdpgfxClientContext* ctx, BOOL* doCapsAdvertise, BOOL* doFrameAcks);
extern UINT goRdpgfxOnClose(RdpgfxClientContext* ctx);
extern UINT goRdpgfxCapsAdvertise(RdpgfxClientContext* ctx, const RDPGFX_CAPS_ADVERTISE_PDU* pdu);
extern UINT goRdpgfxCapsConfirm(RdpgfxClientContext* ctx, const RDPGFX_CAPS_CONFIRM_PDU* pdu);
extern UINT goRdpgfxDeleteEncodingContext(RdpgfxClientContext* ctx, const RDPGFX_DELETE_ENCODING_CONTEXT_PDU* pdu);
extern UINT goRdpgfxCreateSurface(RdpgfxClientContext* ctx, const RDPGFX_CREATE_SURFACE_PDU* pdu);
extern UINT goRdpgfxDeleteSurface(RdpgfxClientContext* ctx, const RDPGFX_DELETE_SURFACE_PDU* pdu);
extern UINT goRdpgfxSolidFill(RdpgfxClientContext* ctx, const RDPGFX_SOLID_FILL_PDU* pdu);
extern UINT goRdpgfxSurfaceToSurface(RdpgfxClientContext* ctx, const RDPGFX_SURFACE_TO_SURFACE_PDU* pdu);
extern UINT goRdpgfxSurfaceToCache(RdpgfxClientContext* ctx, const RDPGFX_SURFACE_TO_CACHE_PDU* pdu);
extern UINT goRdpgfxCacheToSurface(RdpgfxClientContext* ctx, const RDPGFX_CACHE_TO_SURFACE_PDU* pdu);
extern UINT goRdpgfxEvictCacheEntry(RdpgfxClientContext* ctx, const RDPGFX_EVICT_CACHE_ENTRY_PDU* pdu);
extern UINT goRdpgfxResetGraphics(RdpgfxClientContext* ctx, const RDPGFX_RESET_GRAPHICS_PDU* pdu);
extern UINT goRdpgfxMapSurfaceToOutput(RdpgfxClientContext* ctx, const RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU* pdu);
extern UINT goRdpgfxMapSurfaceToScaledOutput(RdpgfxClientContext* ctx, const RDPGFX_MAP_SURFACE_TO_SCALED_OUTPUT_PDU* pdu);
extern UINT goRdpgfxStartFrame(RdpgfxClientContext* ctx, const RDPGFX_START_FRAME_PDU* pdu);
extern UINT goRdpgfxEndFrame(RdpgfxClientContext* ctx, const RDPGFX_END_FRAME_PDU* pdu);
extern void goRdpgfxEndFrameAfter(RdpgfxClientContext* ctx, const RDPGFX_END_FRAME_PDU* pdu, UINT32 rc);
extern UINT goRdpgfxUpdateSurfaces(RdpgfxClientContext* ctx);
extern UINT goRdpgfxUpdateSurfaceArea(RdpgfxClientContext* ctx, UINT16 surfaceId, UINT32 nrRects, const RECTANGLE_16* rects);
// Phase 9 diagnostic — invoked when a wOriginalRdpgfx* handler returns
// a non-OK rc. The Go side bumps per-hook counters that surface in the
// emitFrameStats zap line, so operators can tell at a glance whether
// the libfreerdp build has a working AVC decoder or not.
extern void goRdpgfxOriginalError(RdpgfxClientContext* ctx, UINT32 kind, UINT32 rc);
extern void goAfterLoadChannels(rdpContext* ctx, BOOL ok);

// ----- PubSub trampolines -----
void wOnChannelConnected(void* context, const ChannelConnectedEventArgs* e) {
    goOnChannelConnected((rdpContext*)context, e->name, (void*)e->pInterface);
}
void wOnChannelDisconnected(void* context, const ChannelDisconnectedEventArgs* e) {
    goOnChannelDisconnected((rdpContext*)context, e->name, (void*)e->pInterface);
}

// ----- pointer trampolines -----
BOOL wPointerNew(rdpContext* ctx, rdpPointer* p)        { return goOnPointerNew(ctx, p); }
void wPointerFree(rdpContext* ctx, rdpPointer* p)       { goOnPointerFree(ctx, p); }
BOOL wPointerSet(rdpContext* ctx, rdpPointer* p)        { return goOnPointerSet(ctx, p); }
BOOL wPointerSetNull(rdpContext* ctx)                   { return goOnPointerSetNull(ctx); }
BOOL wPointerSetDefault(rdpContext* ctx)                { return goOnPointerSetDefault(ctx); }
BOOL wPointerSetPosition(rdpContext* ctx, UINT32 x, UINT32 y) { (void)ctx; (void)x; (void)y; return TRUE; }

// ----- context accessors -----
rdpSettings* wContextSettings(rdpContext* ctx) { return ctx->settings; }
rdpInput*    wContextInput(rdpContext* ctx)    { return ctx->input; }
rdpUpdate*   wContextUpdate(rdpContext* ctx)   { return ctx->update; }
const char*  wErrorStr(rdpContext* ctx) {
    return freerdp_get_last_error_string(freerdp_get_last_error(ctx));
}

// ----- X.224 negotiation introspection -----
//
// Called after freerdp_connect fails to learn what the server actually said.
// RequestedProtocols is the bitfield libfreerdp put in the X.224 client
// request; SelectedProtocol is the value the server returned (0 = rejected
// all, otherwise the single accepted bit). Together they answer "which
// security layer was the sticking point" without forcing the operator to
// brute-force-try modes manually.
UINT32 wGetRequestedProtocols(rdpContext* ctx) {
    return freerdp_settings_get_uint32(ctx->settings, FreeRDP_RequestedProtocols);
}
UINT32 wGetSelectedProtocol(rdpContext* ctx) {
    return freerdp_settings_get_uint32(ctx->settings, FreeRDP_SelectedProtocol);
}
UINT32 wGetNegotiationFlags(rdpContext* ctx) {
    return freerdp_settings_get_uint32(ctx->settings, FreeRDP_NegotiationFlags);
}

// ----- channel collection introspection -----
UINT32 wStaticChannelCount(rdpSettings* settings) {
    return freerdp_settings_get_uint32(settings, FreeRDP_StaticChannelCount);
}
UINT32 wDynamicChannelCount(rdpSettings* settings) {
    return freerdp_settings_get_uint32(settings, FreeRDP_DynamicChannelCount);
}
const char* wStaticChannelName(rdpSettings* settings, UINT32 index) {
    ADDIN_ARGV* args = freerdp_settings_get_pointer_array_writable(
        settings, FreeRDP_StaticChannelArray, index);
    if (!args || args->argc == 0 || !args->argv || !args->argv[0]) {
        return NULL;
    }
    return args->argv[0];
}
const char* wDynamicChannelName(rdpSettings* settings, UINT32 index) {
    ADDIN_ARGV* args = freerdp_settings_get_pointer_array_writable(
        settings, FreeRDP_DynamicChannelArray, index);
    if (!args || args->argc == 0 || !args->argv || !args->argv[0]) {
        return NULL;
    }
    return args->argv[0];
}

// ----- callback installers -----

static BOOL wLoadStaticChannelAddin(rdpChannels* channels, rdpSettings* settings,
                                    const char* name, void* data) {
    PVIRTUALCHANNELENTRY entry = NULL;
    PVIRTUALCHANNELENTRY pvce = freerdp_load_channel_addin_entry(
        name, NULL, NULL, FREERDP_ADDIN_CHANNEL_STATIC | FREERDP_ADDIN_CHANNEL_ENTRYEX);
    PVIRTUALCHANNELENTRYEX pvceex = WINPR_FUNC_PTR_CAST(pvce, PVIRTUALCHANNELENTRYEX);

    if (!pvceex) {
        entry = freerdp_load_channel_addin_entry(
            name, NULL, NULL, FREERDP_ADDIN_CHANNEL_STATIC);
    }

    if (pvceex) {
        return freerdp_channels_client_load_ex(channels, settings, pvceex, data) == 0;
    }
    if (entry) {
        return freerdp_channels_client_load(channels, settings, entry, data) == 0;
    }
    return FALSE;
}

BOOL wLoadChannels(freerdp* instance) {
    BOOL ok = TRUE;
    rdpContext* ctx = instance ? instance->context : NULL;

    if (!ctx || !ctx->channels || !ctx->settings) {
        if (ctx) {
            goAfterLoadChannels(ctx, FALSE);
        }
        return FALSE;
    }

    rdpSettings* settings = ctx->settings;
    rdpChannels* channels = ctx->channels;

    if (freerdp_settings_get_bool(settings, FreeRDP_RedirectClipboard)) {
        const char* const p[] = { CLIPRDR_SVC_CHANNEL_NAME };
        ok = freerdp_client_add_static_channel(settings, ARRAYSIZE(p), p);
    }

#if defined(CHANNEL_RDPGFX_CLIENT)
    if (ok && freerdp_settings_get_bool(settings, FreeRDP_SupportGraphicsPipeline)) {
        const char* const p[] = { RDPGFX_CHANNEL_NAME };
        ok = freerdp_client_add_dynamic_channel(settings, ARRAYSIZE(p), p);
    }
#endif

    if (ok) {
        for (UINT32 i = 0; i < freerdp_settings_get_uint32(settings, FreeRDP_StaticChannelCount); i++) {
            ADDIN_ARGV* args = freerdp_settings_get_pointer_array_writable(
                settings, FreeRDP_StaticChannelArray, i);
            if (!args || !wLoadStaticChannelAddin(channels, settings, args->argv[0], args)) {
                ok = FALSE;
                break;
            }
        }
    }

    if (ok && (freerdp_settings_get_uint32(settings, FreeRDP_DynamicChannelCount) > 0)) {
        ok = freerdp_settings_set_bool(settings, FreeRDP_SupportDynamicChannels, TRUE);
        if (ok) {
            ok = wLoadStaticChannelAddin(
                channels, settings, DRDYNVC_SVC_CHANNEL_NAME, settings);
        }
    }

    goAfterLoadChannels(ctx, ok);
    return ok;
}

//
// gdi_init() installs FreeRDP's own bitmap callback. Keep that callback in
// front of ours so compressed RDP bitmap updates are decoded/composited into
// context->gdi->primary_buffer before Go copies the updated rectangle.
static pBitmapUpdate wOriginalBitmapUpdate = NULL;
static pSurfaceBits wOriginalSurfaceBits = NULL;
static pSaveSessionInfo wOriginalSaveSessionInfo = NULL;

BOOL wBitmapUpdate(rdpContext* ctx, const BITMAP_UPDATE* bitmap) {
    if (wOriginalBitmapUpdate && !wOriginalBitmapUpdate(ctx, bitmap)) {
        return FALSE;
    }
    return goOnBitmapUpdate(ctx, bitmap);
}

BOOL wSurfaceBits(rdpContext* ctx, const SURFACE_BITS_COMMAND* cmd) {
    if (wOriginalSurfaceBits && !wOriginalSurfaceBits(ctx, cmd)) {
        return FALSE;
    }
    return goOnSurfaceBits(ctx, cmd);
}

BOOL wSaveSessionInfo(rdpContext* ctx, UINT32 type, void* data) {
    BOOL ok = TRUE;
    if (wOriginalSaveSessionInfo) {
        ok = wOriginalSaveSessionInfo(ctx, type, data);
    }
    if (!goOnSaveSessionInfo(ctx, type, data)) {
        ok = FALSE;
    }
    return ok;
}

void wInstallUpdateCallbacks(rdpUpdate* update) {
    update->BeginPaint   = goOnBeginPaint;
    update->EndPaint     = goOnEndPaint;
    if (update->BitmapUpdate != wBitmapUpdate) {
        wOriginalBitmapUpdate = update->BitmapUpdate;
    }
    update->BitmapUpdate  = wBitmapUpdate;
    update->DesktopResize = goOnDesktopResize;
    if (update->SurfaceBits != wSurfaceBits) {
        wOriginalSurfaceBits = update->SurfaceBits;
    }
    update->SurfaceBits = wSurfaceBits;
    if (update->SaveSessionInfo != wSaveSessionInfo) {
        wOriginalSaveSessionInfo = update->SaveSessionInfo;
    }
    update->SaveSessionInfo = wSaveSessionInfo;
}
void wInstallPointerCallbacks(rdpPointer* pt) {
    pt->New         = wPointerNew;
    pt->Free        = wPointerFree;
    pt->Set         = wPointerSet;
    pt->SetNull     = wPointerSetNull;
    pt->SetDefault  = wPointerSetDefault;
    pt->SetPosition = wPointerSetPosition;
}
void wInstallInstanceCallbacks(freerdp* instance) {
    instance->PreConnect           = goPreConnect;
    instance->PostConnect          = goPostConnect;
    instance->PostDisconnect       = goPostDisconnect;
    instance->LoadChannels         = wLoadChannels;
    instance->AuthenticateEx       = goAuthenticateEx;
    instance->VerifyX509Certificate = goVerifyX509Certificate;
    instance->LogonErrorInfo       = goLogonErrorInfo;
}
void wRegisterChannelPubSub(rdpContext* ctx) {
    PubSub_SubscribeChannelConnected(ctx->pubSub, wOnChannelConnected);
    PubSub_SubscribeChannelDisconnected(ctx->pubSub, wOnChannelDisconnected);
}

// ----- channel installers -----
void wInstallCliprdr(CliprdrClientContext* ctx) {
    ctx->MonitorReady              = goCliprdrMonitorReady;
    ctx->ServerCapabilities        = goCliprdrServerCapabilities;
    ctx->ServerFormatList          = goCliprdrServerFormatList;
    ctx->ServerFormatListResponse  = goCliprdrServerFormatListResponse;
    ctx->ServerFormatDataRequest   = goCliprdrServerFormatDataRequest;
    ctx->ServerFormatDataResponse  = goCliprdrServerFormatDataResponse;
}

static pcRdpgfxResetGraphics wOriginalRdpgfxResetGraphics = NULL;
static pcRdpgfxOnOpen wOriginalRdpgfxOnOpen = NULL;
static pcRdpgfxOnClose wOriginalRdpgfxOnClose = NULL;
static pcRdpgfxCapsAdvertise wOriginalRdpgfxCapsAdvertise = NULL;
static pcRdpgfxCapsConfirm wOriginalRdpgfxCapsConfirm = NULL;
static pcRdpgfxStartFrame wOriginalRdpgfxStartFrame = NULL;
static pcRdpgfxEndFrame wOriginalRdpgfxEndFrame = NULL;
static pcRdpgfxSurfaceCommand wOriginalRdpgfxSurfaceCommand = NULL;
static pcRdpgfxDeleteEncodingContext wOriginalRdpgfxDeleteEncodingContext = NULL;
static pcRdpgfxCreateSurface wOriginalRdpgfxCreateSurface = NULL;
static pcRdpgfxDeleteSurface wOriginalRdpgfxDeleteSurface = NULL;
static pcRdpgfxSolidFill wOriginalRdpgfxSolidFill = NULL;
static pcRdpgfxSurfaceToSurface wOriginalRdpgfxSurfaceToSurface = NULL;
static pcRdpgfxSurfaceToCache wOriginalRdpgfxSurfaceToCache = NULL;
static pcRdpgfxCacheToSurface wOriginalRdpgfxCacheToSurface = NULL;
static pcRdpgfxEvictCacheEntry wOriginalRdpgfxEvictCacheEntry = NULL;
static pcRdpgfxMapSurfaceToOutput wOriginalRdpgfxMapSurfaceToOutput = NULL;
static pcRdpgfxMapSurfaceToScaledOutput wOriginalRdpgfxMapSurfaceToScaledOutput = NULL;
static pcRdpgfxUpdateSurfaces wOriginalRdpgfxUpdateSurfaces = NULL;
static pcRdpgfxUpdateSurfaceArea wOriginalRdpgfxUpdateSurfaceArea = NULL;

rdpContext* wRdpgfxRdpContext(RdpgfxClientContext* ctx) {
    if (!ctx || !ctx->custom) {
        return NULL;
    }
    rdpGdi* gdi = (rdpGdi*)ctx->custom;
    return gdi->context;
}

// RDPGFX_ORIG_KIND_* — identifies which hook's wOriginalRdpgfx* handler
// returned a non-OK code. Passed to goRdpgfxOriginalError so the Go side
// can bump per-hook counters and log diagnostics. The numeric values are
// part of the in-process ABI between the cgo trampolines and the //export
// receiver in cgo_exports.go; never reused across hooks even after a hook
// is removed.
#define RDPGFX_ORIG_KIND_RESET_GRAPHICS           1
#define RDPGFX_ORIG_KIND_ON_OPEN                  2
#define RDPGFX_ORIG_KIND_ON_CLOSE                 3
#define RDPGFX_ORIG_KIND_CAPS_ADVERTISE           4
#define RDPGFX_ORIG_KIND_CAPS_CONFIRM             5
#define RDPGFX_ORIG_KIND_START_FRAME              6
#define RDPGFX_ORIG_KIND_END_FRAME                7
#define RDPGFX_ORIG_KIND_SURFACE_COMMAND          8
#define RDPGFX_ORIG_KIND_DELETE_ENCODING_CONTEXT  9
#define RDPGFX_ORIG_KIND_CREATE_SURFACE          10
#define RDPGFX_ORIG_KIND_DELETE_SURFACE          11
#define RDPGFX_ORIG_KIND_SOLID_FILL              12
#define RDPGFX_ORIG_KIND_SURFACE_TO_SURFACE      13
#define RDPGFX_ORIG_KIND_SURFACE_TO_CACHE        14
#define RDPGFX_ORIG_KIND_CACHE_TO_SURFACE        15
#define RDPGFX_ORIG_KIND_EVICT_CACHE_ENTRY       16
#define RDPGFX_ORIG_KIND_MAP_SURFACE_TO_OUTPUT   17
#define RDPGFX_ORIG_KIND_MAP_SCALED_OUTPUT       18
#define RDPGFX_ORIG_KIND_UPDATE_SURFACES         19
#define RDPGFX_ORIG_KIND_UPDATE_SURFACE_AREA     20

// Observer-pattern RDPGFX wrappers — the go-side //export handler is
// invoked UNCONDITIONALLY, then libfreerdp's original handler runs and
// its rc is returned upstream. The pre-Phase-9 implementation only
// invoked the go handler when libfreerdp's original returned OK, which
// in builds without a working H.264 client decoder (the experimental
// WITH_VAAPI_H264_ENCODING build profile flagged this case in logs)
// meant AVC420 SurfaceCommand payloads never reached the browser-side
// WebCodecs.VideoDecoder. Decoupling restores Phase 1-6's "browser
// decodes H.264 GPU-side" data path even when libfreerdp's local
// decoder can't.
//
// Order: go handler first so it gets to copy any wire payload (e.g.
// SurfaceCommand.data) before libfreerdp potentially mutates buffers
// during its own decode. goRdpgfxSurfaceCommand already uses
// C.GoBytes to make an independent copy, so this is belt-and-braces.
UINT wRdpgfxResetGraphics(RdpgfxClientContext* ctx, const RDPGFX_RESET_GRAPHICS_PDU* pdu) {
    goRdpgfxResetGraphics(ctx, pdu);
    UINT rc = wOriginalRdpgfxResetGraphics ? wOriginalRdpgfxResetGraphics(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxResetGraphics) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_RESET_GRAPHICS, rc);
    }
    return rc;
}

UINT wRdpgfxOnOpen(RdpgfxClientContext* ctx, BOOL* doCapsAdvertise, BOOL* doFrameAcks) {
    UINT rc = wOriginalRdpgfxOnOpen ? wOriginalRdpgfxOnOpen(ctx, doCapsAdvertise, doFrameAcks) : CHANNEL_RC_OK;
    if (doCapsAdvertise) {
        *doCapsAdvertise = TRUE;
    }
    if (doFrameAcks) {
        *doFrameAcks = TRUE;
    }
    // OnOpen is a one-shot lifecycle event; go-side just records the
    // capability decisions and doesn't depend on libfreerdp state, so
    // we always fire even if original failed.
    goRdpgfxOnOpen(ctx, doCapsAdvertise, doFrameAcks);
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxOnOpen) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_ON_OPEN, rc);
    }
    return rc;
}

UINT wRdpgfxOnClose(RdpgfxClientContext* ctx) {
    goRdpgfxOnClose(ctx);
    UINT rc = wOriginalRdpgfxOnClose ? wOriginalRdpgfxOnClose(ctx) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxOnClose) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_ON_CLOSE, rc);
    }
    return rc;
}

UINT wRdpgfxCapsAdvertise(RdpgfxClientContext* ctx, const RDPGFX_CAPS_ADVERTISE_PDU* pdu) {
    goRdpgfxCapsAdvertise(ctx, pdu);
    UINT rc = wOriginalRdpgfxCapsAdvertise ? wOriginalRdpgfxCapsAdvertise(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxCapsAdvertise) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_CAPS_ADVERTISE, rc);
    }
    return rc;
}

UINT wRdpgfxCapsConfirm(RdpgfxClientContext* ctx, const RDPGFX_CAPS_CONFIRM_PDU* pdu) {
    goRdpgfxCapsConfirm(ctx, pdu);
    UINT rc = wOriginalRdpgfxCapsConfirm ? wOriginalRdpgfxCapsConfirm(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxCapsConfirm) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_CAPS_CONFIRM, rc);
    }
    return rc;
}

UINT wRdpgfxStartFrame(RdpgfxClientContext* ctx, const RDPGFX_START_FRAME_PDU* pdu) {
    goRdpgfxStartFrame(ctx, pdu);
    UINT rc = wOriginalRdpgfxStartFrame ? wOriginalRdpgfxStartFrame(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxStartFrame) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_START_FRAME, rc);
    }
    return rc;
}

UINT wRdpgfxEndFrame(RdpgfxClientContext* ctx, const RDPGFX_END_FRAME_PDU* pdu) {
    goRdpgfxEndFrame(ctx, pdu);
    UINT rc = wOriginalRdpgfxEndFrame ? wOriginalRdpgfxEndFrame(ctx, pdu) : CHANNEL_RC_OK;
    goRdpgfxEndFrameAfter(ctx, pdu, rc);
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxEndFrame) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_END_FRAME, rc);
    }
    return rc;
}

UINT wRdpgfxSurfaceCommand(RdpgfxClientContext* ctx, const RDPGFX_SURFACE_COMMAND* cmd) {
    // Critical path for AVC420 / NSCodec / Progressive frames. Go side
    // copies the payload (C.GoBytes) and emits Encoding=h264/rfx/... to
    // the browser regardless of whether libfreerdp's local decoder
    // succeeds. This is what Phase 9 unblocked.
    goRdpgfxSurfaceCommand(ctx, cmd);
    UINT rc = wOriginalRdpgfxSurfaceCommand ? wOriginalRdpgfxSurfaceCommand(ctx, cmd) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxSurfaceCommand) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_SURFACE_COMMAND, rc);
    }
    return rc;
}

UINT wRdpgfxDeleteEncodingContext(RdpgfxClientContext* ctx, const RDPGFX_DELETE_ENCODING_CONTEXT_PDU* pdu) {
    goRdpgfxDeleteEncodingContext(ctx, pdu);
    UINT rc = wOriginalRdpgfxDeleteEncodingContext ? wOriginalRdpgfxDeleteEncodingContext(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxDeleteEncodingContext) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_DELETE_ENCODING_CONTEXT, rc);
    }
    return rc;
}

UINT wRdpgfxCreateSurface(RdpgfxClientContext* ctx, const RDPGFX_CREATE_SURFACE_PDU* pdu) {
    goRdpgfxCreateSurface(ctx, pdu);
    UINT rc = wOriginalRdpgfxCreateSurface ? wOriginalRdpgfxCreateSurface(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxCreateSurface) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_CREATE_SURFACE, rc);
    }
    return rc;
}

UINT wRdpgfxDeleteSurface(RdpgfxClientContext* ctx, const RDPGFX_DELETE_SURFACE_PDU* pdu) {
    goRdpgfxDeleteSurface(ctx, pdu);
    UINT rc = wOriginalRdpgfxDeleteSurface ? wOriginalRdpgfxDeleteSurface(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxDeleteSurface) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_DELETE_SURFACE, rc);
    }
    return rc;
}

UINT wRdpgfxSolidFill(RdpgfxClientContext* ctx, const RDPGFX_SOLID_FILL_PDU* pdu) {
    goRdpgfxSolidFill(ctx, pdu);
    UINT rc = wOriginalRdpgfxSolidFill ? wOriginalRdpgfxSolidFill(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxSolidFill) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_SOLID_FILL, rc);
    }
    return rc;
}

UINT wRdpgfxSurfaceToSurface(RdpgfxClientContext* ctx, const RDPGFX_SURFACE_TO_SURFACE_PDU* pdu) {
    goRdpgfxSurfaceToSurface(ctx, pdu);
    UINT rc = wOriginalRdpgfxSurfaceToSurface ? wOriginalRdpgfxSurfaceToSurface(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxSurfaceToSurface) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_SURFACE_TO_SURFACE, rc);
    }
    return rc;
}

UINT wRdpgfxSurfaceToCache(RdpgfxClientContext* ctx, const RDPGFX_SURFACE_TO_CACHE_PDU* pdu) {
    goRdpgfxSurfaceToCache(ctx, pdu);
    UINT rc = wOriginalRdpgfxSurfaceToCache ? wOriginalRdpgfxSurfaceToCache(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxSurfaceToCache) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_SURFACE_TO_CACHE, rc);
    }
    return rc;
}

UINT wRdpgfxCacheToSurface(RdpgfxClientContext* ctx, const RDPGFX_CACHE_TO_SURFACE_PDU* pdu) {
    goRdpgfxCacheToSurface(ctx, pdu);
    UINT rc = wOriginalRdpgfxCacheToSurface ? wOriginalRdpgfxCacheToSurface(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxCacheToSurface) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_CACHE_TO_SURFACE, rc);
    }
    return rc;
}

UINT wRdpgfxEvictCacheEntry(RdpgfxClientContext* ctx, const RDPGFX_EVICT_CACHE_ENTRY_PDU* pdu) {
    goRdpgfxEvictCacheEntry(ctx, pdu);
    UINT rc = wOriginalRdpgfxEvictCacheEntry ? wOriginalRdpgfxEvictCacheEntry(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxEvictCacheEntry) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_EVICT_CACHE_ENTRY, rc);
    }
    return rc;
}

UINT wRdpgfxMapSurfaceToOutput(RdpgfxClientContext* ctx, const RDPGFX_MAP_SURFACE_TO_OUTPUT_PDU* pdu) {
    goRdpgfxMapSurfaceToOutput(ctx, pdu);
    UINT rc = wOriginalRdpgfxMapSurfaceToOutput ? wOriginalRdpgfxMapSurfaceToOutput(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxMapSurfaceToOutput) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_MAP_SURFACE_TO_OUTPUT, rc);
    }
    return rc;
}

UINT wRdpgfxMapSurfaceToScaledOutput(RdpgfxClientContext* ctx, const RDPGFX_MAP_SURFACE_TO_SCALED_OUTPUT_PDU* pdu) {
    goRdpgfxMapSurfaceToScaledOutput(ctx, pdu);
    UINT rc = wOriginalRdpgfxMapSurfaceToScaledOutput ? wOriginalRdpgfxMapSurfaceToScaledOutput(ctx, pdu) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxMapSurfaceToScaledOutput) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_MAP_SCALED_OUTPUT, rc);
    }
    return rc;
}

UINT wRdpgfxUpdateSurfaces(RdpgfxClientContext* ctx) {
    goRdpgfxUpdateSurfaces(ctx);
    UINT rc = wOriginalRdpgfxUpdateSurfaces ? wOriginalRdpgfxUpdateSurfaces(ctx) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxUpdateSurfaces) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_UPDATE_SURFACES, rc);
    }
    return rc;
}

UINT wRdpgfxUpdateSurfaceArea(RdpgfxClientContext* ctx, UINT16 surfaceId, UINT32 nrRects, const RECTANGLE_16* rects) {
    goRdpgfxUpdateSurfaceArea(ctx, surfaceId, nrRects, rects);
    UINT rc = wOriginalRdpgfxUpdateSurfaceArea ? wOriginalRdpgfxUpdateSurfaceArea(ctx, surfaceId, nrRects, rects) : CHANNEL_RC_OK;
    if (rc != CHANNEL_RC_OK && wOriginalRdpgfxUpdateSurfaceArea) {
        goRdpgfxOriginalError(ctx, RDPGFX_ORIG_KIND_UPDATE_SURFACE_AREA, rc);
    }
    return rc;
}

BOOL wInstallRdpgfx(RdpgfxClientContext* ctx) {
    if (!ctx || !ctx->custom) {
        return FALSE;
    }
    rdpContext* rdp = (rdpContext*)ctx->custom;
    if (!rdp || !rdp->gdi) {
        return FALSE;
    }
    if (!gdi_graphics_pipeline_init(rdp->gdi, ctx)) {
        return FALSE;
    }

    wOriginalRdpgfxResetGraphics = ctx->ResetGraphics;
    wOriginalRdpgfxOnOpen = ctx->OnOpen;
    wOriginalRdpgfxOnClose = ctx->OnClose;
    wOriginalRdpgfxCapsAdvertise = ctx->CapsAdvertise;
    wOriginalRdpgfxCapsConfirm = ctx->CapsConfirm;
    wOriginalRdpgfxStartFrame = ctx->StartFrame;
    wOriginalRdpgfxEndFrame = ctx->EndFrame;
    wOriginalRdpgfxSurfaceCommand = ctx->SurfaceCommand;
    wOriginalRdpgfxDeleteEncodingContext = ctx->DeleteEncodingContext;
    wOriginalRdpgfxCreateSurface = ctx->CreateSurface;
    wOriginalRdpgfxDeleteSurface = ctx->DeleteSurface;
    wOriginalRdpgfxSolidFill = ctx->SolidFill;
    wOriginalRdpgfxSurfaceToSurface = ctx->SurfaceToSurface;
    wOriginalRdpgfxSurfaceToCache = ctx->SurfaceToCache;
    wOriginalRdpgfxCacheToSurface = ctx->CacheToSurface;
    wOriginalRdpgfxEvictCacheEntry = ctx->EvictCacheEntry;
    wOriginalRdpgfxMapSurfaceToOutput = ctx->MapSurfaceToOutput;
    wOriginalRdpgfxMapSurfaceToScaledOutput = ctx->MapSurfaceToScaledOutput;
    wOriginalRdpgfxUpdateSurfaces = ctx->UpdateSurfaces;
    wOriginalRdpgfxUpdateSurfaceArea = ctx->UpdateSurfaceArea;

    ctx->ResetGraphics = wRdpgfxResetGraphics;
    ctx->OnOpen = wRdpgfxOnOpen;
    ctx->OnClose = wRdpgfxOnClose;
    ctx->CapsAdvertise = wRdpgfxCapsAdvertise;
    ctx->CapsConfirm = wRdpgfxCapsConfirm;
    ctx->StartFrame = wRdpgfxStartFrame;
    ctx->EndFrame = wRdpgfxEndFrame;
    ctx->SurfaceCommand = wRdpgfxSurfaceCommand;
    ctx->DeleteEncodingContext = wRdpgfxDeleteEncodingContext;
    ctx->CreateSurface = wRdpgfxCreateSurface;
    ctx->DeleteSurface = wRdpgfxDeleteSurface;
    ctx->SolidFill = wRdpgfxSolidFill;
    ctx->SurfaceToSurface = wRdpgfxSurfaceToSurface;
    ctx->SurfaceToCache = wRdpgfxSurfaceToCache;
    ctx->CacheToSurface = wRdpgfxCacheToSurface;
    ctx->EvictCacheEntry = wRdpgfxEvictCacheEntry;
    ctx->MapSurfaceToOutput = wRdpgfxMapSurfaceToOutput;
    ctx->MapSurfaceToScaledOutput = wRdpgfxMapSurfaceToScaledOutput;
    ctx->UpdateSurfaces = wRdpgfxUpdateSurfaces;
    if (ctx->UpdateSurfaceArea) {
        ctx->UpdateSurfaceArea = wRdpgfxUpdateSurfaceArea;
    }
    return TRUE;
}

static RECTANGLE_16 wDesktopBounds(UINT16 width, UINT16 height) {
    RECTANGLE_16 area = {0};
    area.left = 0;
    area.top = 0;
    area.right = width;
    area.bottom = height;
    return area;
}

BOOL wSendSuppressOutputAllow(rdpContext* ctx, UINT16 width, UINT16 height) {
    if (!ctx || !ctx->update || !ctx->update->SuppressOutput || width == 0 || height == 0) {
        return FALSE;
    }
    RECTANGLE_16 area = wDesktopBounds(width, height);
    if (ctx->gdi) {
        // gdi_send_suppress_output(FALSE) is a local-state no-op when GDI already
        // thinks output is allowed. Send the allow PDU explicitly during activation.
        ctx->gdi->suppressOutput = FALSE;
    }
    return ctx->update->SuppressOutput(ctx, TRUE, &area);
}

BOOL wSendFocusIn(rdpContext* ctx) {
    if (!ctx || !ctx->input) {
        return FALSE;
    }
    return freerdp_input_send_focus_in_event(ctx->input, 0);
}

int wSendPendingFocusIn(freerdp* instance) {
    if (!instance || !instance->context || !instance->context->input) {
        return -1;
    }
    if (!freerdp_focus_required(instance)) {
        return 0;
    }
    if (!freerdp_input_send_focus_in_event(instance->context->input, 0)) {
        return -1;
    }
    if (!freerdp_input_send_focus_in_event(instance->context->input, 0)) {
        return -1;
    }
    return 1;
}

BOOL wSendDesktopRefreshRect(rdpContext* ctx, UINT16 width, UINT16 height) {
    if (!ctx || !ctx->update || !ctx->update->RefreshRect || width == 0 || height == 0) {
        return FALSE;
    }
    RECTANGLE_16 area = wDesktopBounds(width, height);
    return ctx->update->RefreshRect(ctx, 1, &area);
}

BOOL wSendContextRefreshRect(rdpContext* ctx, UINT16 left, UINT16 top, UINT16 right, UINT16 bottom) {
    if (!ctx || !ctx->update || !ctx->update->RefreshRect || right <= left || bottom <= top) {
        return FALSE;
    }
    RECTANGLE_16 rect;
    rect.left = left;
    rect.top = top;
    rect.right = right;
    rect.bottom = bottom;
    return ctx->update->RefreshRect(ctx, 1, &rect);
}

// ----- outbound CLIPRDR helpers -----
UINT wSendCliprdrCapabilities(CliprdrClientContext* ctx) {
    CLIPRDR_GENERAL_CAPABILITY_SET general = {0};
    CLIPRDR_CAPABILITIES caps = {0};

    general.capabilitySetType = CB_CAPSTYPE_GENERAL;
    general.capabilitySetLength = CB_CAPSTYPE_GENERAL_LEN;
    general.version = CB_CAPS_VERSION_2;
    general.generalFlags = CB_USE_LONG_FORMAT_NAMES;

    caps.common.msgType = CB_CLIP_CAPS;
    caps.cCapabilitiesSets = 1;
    caps.capabilitySets = (CLIPRDR_CAPABILITY_SET*)&general;
    return ctx->ClientCapabilities(ctx, &caps);
}
UINT wSendCliprdrFormatList(CliprdrClientContext* ctx,
                             const CLIPRDR_FORMAT* formats, UINT32 numFormats) {
    CLIPRDR_FORMAT_LIST fl = {0};
    fl.common.msgType = CB_FORMAT_LIST;
    fl.numFormats = numFormats;
    fl.formats    = (CLIPRDR_FORMAT*)formats;
    return ctx->ClientFormatList(ctx, &fl);
}
UINT wSendCliprdrFormatListResponse(CliprdrClientContext* ctx, UINT16 msgFlags) {
    CLIPRDR_FORMAT_LIST_RESPONSE r = {0};
    r.common.msgType = CB_FORMAT_LIST_RESPONSE;
    r.common.msgFlags = msgFlags;
    return ctx->ClientFormatListResponse(ctx, &r);
}
UINT wSendCliprdrFormatDataResponse(CliprdrClientContext* ctx,
                                     const BYTE* data, UINT32 size) {
    CLIPRDR_FORMAT_DATA_RESPONSE r = {0};
    r.common.msgType    = CB_FORMAT_DATA_RESPONSE;
    r.common.msgFlags   = CB_RESPONSE_OK;
    r.common.dataLen    = size;
    r.requestedFormatData = (BYTE*)data;
    return ctx->ClientFormatDataResponse(ctx, &r);
}
UINT wSendCliprdrFormatDataRequest(CliprdrClientContext* ctx, UINT32 formatId) {
    CLIPRDR_FORMAT_DATA_REQUEST r = {0};
    r.common.msgType = CB_FORMAT_DATA_REQUEST;
    r.requestedFormatId = formatId;
    return ctx->ClientFormatDataRequest(ctx, &r);
}

// Register the static addin provider FreeRDP needs to look up channel
// plugins (CLIPRDR / RDPSND / RDPGFX / RDPDR) at runtime. Doing this
// from Go is awkward because cgo can't easily pass a Go-side fn pointer
// to a C function taking another C function pointer — wrap once here.
void wRegisterStaticAddins(void) {
    freerdp_register_addin_provider(freerdp_channels_load_static_addin_entry, 0);
}

// ----- outbound INPUT helpers -----
//
// Two send paths:
//   wSendUnicode: for printable characters. Lets Windows handle layout
//     translation locally — robust against keyboard-layout mismatch.
//   wSendScancode: for non-printable keys (Enter / Backspace / Function /
//     arrows / modifiers). Caller already resolved the RDP scancode +
//     extended bit because libfreerdp 3 dropped keysym→keycode helpers
//     (we ship our own keysym table in input.go).
BOOL wSendUnicode(rdpInput* input, BOOL down, UINT32 codepoint) {
    UINT16 flags = down ? KBD_FLAGS_DOWN : KBD_FLAGS_RELEASE;
    return freerdp_input_send_unicode_keyboard_event(input, flags, (UINT16)codepoint);
}
BOOL wSendScancode(rdpInput* input, BOOL down, UINT16 scancode, BOOL extended) {
    UINT16 flags = down ? KBD_FLAGS_DOWN : KBD_FLAGS_RELEASE;
    if (extended) flags |= KBD_FLAGS_EXTENDED;
    return freerdp_input_send_keyboard_event(input, flags, (UINT8)(scancode & 0xFF));
}
BOOL wSendMouse(rdpInput* input, UINT16 flags, UINT16 x, UINT16 y) {
    return freerdp_input_send_mouse_event(input, flags, x, y);
}

*/
import "C"
