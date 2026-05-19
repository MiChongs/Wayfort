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
extern UINT goRdpgfxCreateSurface(RdpgfxClientContext* ctx, const RDPGFX_CREATE_SURFACE_PDU* pdu);
extern UINT goRdpgfxDeleteSurface(RdpgfxClientContext* ctx, const RDPGFX_DELETE_SURFACE_PDU* pdu);
extern UINT goRdpgfxStartFrame(RdpgfxClientContext* ctx, const RDPGFX_START_FRAME_PDU* pdu);
extern UINT goRdpgfxEndFrame(RdpgfxClientContext* ctx, const RDPGFX_END_FRAME_PDU* pdu);
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
static pcRdpgfxSurfaceCommand wOriginalRdpgfxSurfaceCommand = NULL;
static pcRdpgfxCreateSurface wOriginalRdpgfxCreateSurface = NULL;
static pcRdpgfxDeleteSurface wOriginalRdpgfxDeleteSurface = NULL;
static pcRdpgfxStartFrame wOriginalRdpgfxStartFrame = NULL;
static pcRdpgfxEndFrame wOriginalRdpgfxEndFrame = NULL;

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

UINT wRdpgfxSurfaceCommand(RdpgfxClientContext* ctx, const RDPGFX_SURFACE_COMMAND* cmd) {
    if (wOriginalRdpgfxSurfaceCommand && wOriginalRdpgfxSurfaceCommand != wRdpgfxSurfaceCommand) {
        const UINT rc = wOriginalRdpgfxSurfaceCommand(ctx, cmd);
        if (rc != CHANNEL_RC_OK) {
            return rc;
        }
        return CHANNEL_RC_OK;
    }
    return goRdpgfxSurfaceCommand(ctx, cmd);
}

UINT wRdpgfxCreateSurface(RdpgfxClientContext* ctx, const RDPGFX_CREATE_SURFACE_PDU* pdu) {
    if (wOriginalRdpgfxCreateSurface && wOriginalRdpgfxCreateSurface != wRdpgfxCreateSurface) {
        const UINT rc = wOriginalRdpgfxCreateSurface(ctx, pdu);
        if (rc != CHANNEL_RC_OK) {
            return rc;
        }
    }
    return goRdpgfxCreateSurface(ctx, pdu);
}

UINT wRdpgfxDeleteSurface(RdpgfxClientContext* ctx, const RDPGFX_DELETE_SURFACE_PDU* pdu) {
    if (wOriginalRdpgfxDeleteSurface && wOriginalRdpgfxDeleteSurface != wRdpgfxDeleteSurface) {
        const UINT rc = wOriginalRdpgfxDeleteSurface(ctx, pdu);
        if (rc != CHANNEL_RC_OK) {
            return rc;
        }
    }
    return goRdpgfxDeleteSurface(ctx, pdu);
}

UINT wRdpgfxStartFrame(RdpgfxClientContext* ctx, const RDPGFX_START_FRAME_PDU* pdu) {
    if (wOriginalRdpgfxStartFrame && wOriginalRdpgfxStartFrame != wRdpgfxStartFrame) {
        const UINT rc = wOriginalRdpgfxStartFrame(ctx, pdu);
        if (rc != CHANNEL_RC_OK) {
            return rc;
        }
    }
    return goRdpgfxStartFrame(ctx, pdu);
}

UINT wRdpgfxEndFrame(RdpgfxClientContext* ctx, const RDPGFX_END_FRAME_PDU* pdu) {
    if (wOriginalRdpgfxEndFrame && wOriginalRdpgfxEndFrame != wRdpgfxEndFrame) {
        const UINT rc = wOriginalRdpgfxEndFrame(ctx, pdu);
        if (rc != CHANNEL_RC_OK) {
            return rc;
        }
    }
    return goRdpgfxEndFrame(ctx, pdu);
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
void wInstallRdpgfx(RdpgfxClientContext* ctx) {
    if (ctx->SurfaceCommand != wRdpgfxSurfaceCommand) {
        wOriginalRdpgfxSurfaceCommand = ctx->SurfaceCommand;
    }
    ctx->SurfaceCommand = wRdpgfxSurfaceCommand;
    if (ctx->CreateSurface != wRdpgfxCreateSurface) {
        wOriginalRdpgfxCreateSurface = ctx->CreateSurface;
    }
    ctx->CreateSurface = wRdpgfxCreateSurface;
    if (ctx->DeleteSurface != wRdpgfxDeleteSurface) {
        wOriginalRdpgfxDeleteSurface = ctx->DeleteSurface;
    }
    ctx->DeleteSurface = wRdpgfxDeleteSurface;
    if (ctx->StartFrame != wRdpgfxStartFrame) {
        wOriginalRdpgfxStartFrame = ctx->StartFrame;
    }
    ctx->StartFrame = wRdpgfxStartFrame;
    if (ctx->EndFrame != wRdpgfxEndFrame) {
        wOriginalRdpgfxEndFrame = ctx->EndFrame;
    }
    ctx->EndFrame = wRdpgfxEndFrame;
}

static RECTANGLE_16 wDesktopArea(UINT16 width, UINT16 height) {
    RECTANGLE_16 area = {0};
    area.left = 0;
    area.top = 0;
    area.right = width - 1;
    area.bottom = height - 1;
    return area;
}

BOOL wSendSuppressOutputAllow(rdpContext* ctx, UINT16 width, UINT16 height) {
    if (!ctx || width == 0 || height == 0) {
        return FALSE;
    }
    if (ctx->gdi) {
        return gdi_send_suppress_output(ctx->gdi, FALSE);
    }
    if (!ctx->update || !ctx->update->SuppressOutput) {
        return FALSE;
    }
    RECTANGLE_16 area = wDesktopArea(width, height);
    return ctx->update->SuppressOutput(ctx, TRUE, &area);
}

BOOL wSendRefreshRect(rdpContext* ctx, UINT16 width, UINT16 height) {
    if (!ctx || !ctx->update || !ctx->update->RefreshRect || width == 0 || height == 0) {
        return FALSE;
    }
    RECTANGLE_16 area = wDesktopArea(width, height);
    return ctx->update->RefreshRect(ctx, 1, &area);
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

// rdpInput-flavoured RefreshRect lives inline in input.go directly — a
// shared wrapper here collides with the rdpContext-keyed wSendRefreshRect
// defined further up (C does not allow two same-named functions in a
// single translation unit, even with different signatures), and cgo also
// rejects a shared helper because this file preprocesses with extra
// CFLAGS that input.go doesn't (WITHOUT_FREERDP_3x_DEPRECATED +
// __STDC_NO_THREADS__ on Windows).
*/
import "C"
