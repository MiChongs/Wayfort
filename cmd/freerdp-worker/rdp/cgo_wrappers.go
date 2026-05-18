//go:build freerdp

// cgo_wrappers.go — C helper functions shared across the package. Each
// .go file in the package re-declares these as `extern` in its own
// #cgo preamble; the bodies live here so the linker has exactly one
// definition.

package rdp

/*
#cgo pkg-config: freerdp3 freerdp-client3 winpr3
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
#include <freerdp/settings.h>
#include <winpr/synch.h>
#include <winpr/wtypes.h>

// All Go exports.
extern BOOL goPreConnect(freerdp* instance);
extern BOOL goPostConnect(freerdp* instance);
extern void goPostDisconnect(freerdp* instance);
extern BOOL goAuthenticate(freerdp* instance, char** username, char** password, char** domain);
extern BOOL goAuthenticateEx(freerdp* instance, char** username, char** password, char** domain,
                             rdp_auth_reason reason);
extern DWORD goVerifyCertificate(freerdp* instance, const char* host, UINT16 port,
                                 const char* common_name, const char* subject,
                                 const char* issuer, const char* fingerprint, DWORD flags);
extern int goLogonErrorInfo(freerdp* instance, UINT32 data, UINT32 type);
extern void goOnChannelConnected(rdpContext* ctx, const char* name, void* iface);
extern void goOnChannelDisconnected(rdpContext* ctx, const char* name, void* iface);
extern BOOL goOnBitmapUpdate(rdpContext* ctx, const BITMAP_UPDATE* bitmap);
extern BOOL goOnDesktopResize(rdpContext* ctx);
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

BOOL wBitmapUpdate(rdpContext* ctx, const BITMAP_UPDATE* bitmap) {
    if (wOriginalBitmapUpdate && !wOriginalBitmapUpdate(ctx, bitmap)) {
        return FALSE;
    }
    return goOnBitmapUpdate(ctx, bitmap);
}

void wInstallUpdateCallbacks(rdpUpdate* update) {
    if (update->BitmapUpdate != wBitmapUpdate) {
        wOriginalBitmapUpdate = update->BitmapUpdate;
    }
    update->BitmapUpdate  = wBitmapUpdate;
    update->DesktopResize = goOnDesktopResize;
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
    instance->Authenticate         = goAuthenticate;
    instance->AuthenticateEx       = goAuthenticateEx;
    instance->VerifyCertificateEx  = goVerifyCertificate;
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
    ctx->SurfaceCommand = goRdpgfxSurfaceCommand;
    ctx->CreateSurface  = goRdpgfxCreateSurface;
    ctx->DeleteSurface  = goRdpgfxDeleteSurface;
    ctx->StartFrame     = goRdpgfxStartFrame;
    ctx->EndFrame       = goRdpgfxEndFrame;
}

// ----- outbound CLIPRDR helpers -----
UINT wSendCliprdrFormatList(CliprdrClientContext* ctx,
                             const CLIPRDR_FORMAT* formats, UINT32 numFormats) {
    CLIPRDR_FORMAT_LIST fl = {0};
    fl.common.msgType = CB_FORMAT_LIST;
    fl.numFormats = numFormats;
    fl.formats    = (CLIPRDR_FORMAT*)formats;
    return ctx->ClientFormatList(ctx, &fl);
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
