//go:build freerdp

// rdp/client.go — libfreerdp 3.x driven RDP worker (Plan 17 M2). Wraps the
// FreeRDP client API so the rest of the worker stays in idiomatic Go.
//
// Lifecycle:
//   NewClient → Start spawns the libfreerdp event loop in a goroutine.
//   The loop calls freerdp_connect; on success registers update callbacks
//   (BitmapUpdate, Pointer, Synchronize); polls freerdp_get_event_handles
//   until disconnect; finally freerdp_disconnect + freerdp_context_free.
//
// Channels are subscribed in channels.go. RDPGFX is decoded worker-side by
// FreeRDP's GDI graphics pipeline and emitted as ordinary desktop frames;
// audio and drive redirection remain deferred.

package rdp

/*
#cgo pkg-config: freerdp3 freerdp-client3 winpr3

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <freerdp/freerdp.h>
#include <freerdp/client.h>
#include <freerdp/client/channels.h>
#include <freerdp/event.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/settings.h>
#include <winpr/synch.h>
#include <winpr/wtypes.h>

// All cgo bridge helpers are defined in cgo_wrappers.go (one definition
// per process, shared across files). Re-declare here so this translation
// unit sees them.
extern void wInstallInstanceCallbacks(freerdp* instance);
extern void wInstallUpdateCallbacks(rdpUpdate* update);
extern void wInstallPointerCallbacks(rdpPointer* pt);
extern void wRegisterChannelPubSub(rdpContext* ctx);
extern void wRegisterStaticAddins(void);
extern rdpSettings* wContextSettings(rdpContext* ctx);
extern rdpInput*    wContextInput(rdpContext* ctx);
extern rdpUpdate*   wContextUpdate(rdpContext* ctx);
extern const char*  wErrorStr(rdpContext* ctx);
extern UINT32       wGetRequestedProtocols(rdpContext* ctx);
extern UINT32       wGetSelectedProtocol(rdpContext* ctx);
extern UINT32       wGetNegotiationFlags(rdpContext* ctx);
extern BOOL         wAddDriveRedirect(rdpSettings* settings, const char* name, const char* path);
extern UINT32       wDeviceCount(rdpSettings* settings);
extern UINT32       wStaticChannelCount(rdpSettings* settings);
extern UINT32       wDynamicChannelCount(rdpSettings* settings);
extern const char*  wStaticChannelName(rdpSettings* settings, UINT32 index);
extern const char*  wDynamicChannelName(rdpSettings* settings, UINT32 index);
extern BOOL         wSendFocusIn(rdpContext* ctx);
extern int          wSendPendingFocusIn(freerdp* instance);
extern BOOL         wSendSuppressOutputAllow(rdpContext* ctx, UINT16 width, UINT16 height);
extern BOOL         wSendDesktopRefreshRect(rdpContext* ctx, UINT16 width, UINT16 height);
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/michongs/jumpserver-anonymous/internal/desktop"
	ants "github.com/panjf2000/ants/v2"
	"go.uber.org/zap"
)

// Client is the public DesktopWorker implementation backed by libfreerdp.
type Client struct {
	logger *zap.Logger
	params desktop.StartParams

	instance unsafe.Pointer // *C.freerdp
	context  unsafe.Pointer // *C.rdpContext

	out chan desktop.ServerMessage
	in  chan desktop.ClientMessage

	cancel  context.CancelFunc
	done    chan struct{}
	closing atomic.Bool
	closeMu sync.Once

	width  uint32
	height uint32

	// Channel handles populated in goOnChannelConnected.
	cliprdr unsafe.Pointer // *CliprdrClientContext
	rdpsnd  unsafe.Pointer // *RdpsndClientContext
	rdpgfx  unsafe.Pointer // *RdpgfxClientContext

	rdpgfxMu             sync.Mutex
	rdpgfxSurfaces       map[uint16]rdpgfxSurfaceState
	rdpgfxGDIInitialized atomic.Bool

	cliprdrCapsSent           atomic.Bool
	cliprdrFormatListSent     atomic.Bool
	clipboardFallbackTried    bool
	gfxCompatFallbackTried    bool
	gfxCompatProfile          bool
	safeGraphicsFallbackTried bool
	safeGraphicsProfile       bool

	// Pointer state: the last cursor BGRA hash so we can dedup repeats.
	lastCursorHash uint64

	// One-shot flag: true after the first decoded frame has been forwarded.
	// Used by update callbacks to log a single INFO line confirming
	// "frames are flowing" — without it the gateway log can't distinguish
	// "connect succeeded but server sent no frames" from "frames flowed
	// then browser closed unexpectedly".
	firstFrameLogged         atomic.Bool
	framesEmitted            atomic.Uint64
	framesDropped            atomic.Uint64
	framesEncodeQueued       atomic.Uint64
	framesEncodeFallback     atomic.Uint64
	framesEncodedRaw         atomic.Uint64
	framesEncodedJPEG        atomic.Uint64
	framesEncodedZlib        atomic.Uint64
	frameEncodeInBytes       atomic.Uint64
	frameEncodeOutBytes      atomic.Uint64
	frameResyncPending       atomic.Bool
	frameResyncs             atomic.Uint64
	emitDropLastLogNano      atomic.Int64
	emitDropSuppressed       atomic.Uint64
	beginPaints              atomic.Uint64
	endPaints                atomic.Uint64
	bitmapUpdates            atomic.Uint64
	surfaceBits              atomic.Uint64
	desktopResizes           atomic.Uint64
	paintRegions             atomic.Uint64
	emptyPaints              atomic.Uint64
	refreshRequests          atomic.Uint64
	refreshFailures          atomic.Uint64
	saveSessionInfos         atomic.Uint64
	rdpgfxResetGraphics      atomic.Uint64
	rdpgfxOnOpen             atomic.Uint64
	rdpgfxOnClose            atomic.Uint64
	rdpgfxCapsAdvertise      atomic.Uint64
	rdpgfxCapsConfirm        atomic.Uint64
	rdpgfxCapsVersion        atomic.Uint32
	rdpgfxCapsFlags          atomic.Uint32
	rdpgfxSurfaceCommands    atomic.Uint64
	rdpgfxCreateSurfaces     atomic.Uint64
	rdpgfxDeleteSurfaces     atomic.Uint64
	rdpgfxMapOutput          atomic.Uint64
	rdpgfxMapScaledOutput    atomic.Uint64
	rdpgfxSolidFills         atomic.Uint64
	rdpgfxSurfaceToSurface   atomic.Uint64
	rdpgfxSurfaceToCache     atomic.Uint64
	rdpgfxCacheToSurface     atomic.Uint64
	rdpgfxEvictCache         atomic.Uint64
	rdpgfxStartFrames        atomic.Uint64
	rdpgfxEndFrames          atomic.Uint64
	rdpgfxEndFrameSeqBase    atomic.Uint64
	rdpgfxEndFrameCmdBase    atomic.Uint64
	rdpgfxUpdateSurfaces     atomic.Uint64
	rdpgfxUpdateSurfaceAreas atomic.Uint64
	rdpgfxFrameAcks          atomic.Uint64
	// Phase 9 — diagnostic counters for libfreerdp's original RDPGFX
	// handlers returning non-OK. With the experimental
	// WITH_VAAPI_H264_ENCODING build profile (or any build lacking a
	// working H.264 client decoder), the local AVC420 decode path
	// errors out. The Phase 9 observer-pattern decoupling means the
	// browser-side decode still works; these counters let operators
	// confirm at a glance whether libfreerdp's local pipeline is
	// silently failing without grepping per-line WARN logs.
	rdpgfxOriginalErrors               atomic.Uint64
	rdpgfxOriginalSurfaceCommandErrors atomic.Uint64
	rdpgfxOriginalCreateSurfaceErrors  atomic.Uint64
	rdpgfxOriginalUpdateSurfacesErrors atomic.Uint64
	logonSuccessSeen                   atomic.Bool
	logonErrorSeen                     atomic.Bool
	logonErrorData                     atomic.Uint32
	logonErrorType                     atomic.Uint32
	logonErrorAtUnixNano               atomic.Int64
	logonErrorClosed                   atomic.Bool

	framePool       *ants.Pool
	frameSeq        atomic.Uint64
	frameEmitMu     sync.Mutex
	frameEmitNext   uint64
	frameReady      map[uint64]desktop.ServerMessage
	frameSkipped    map[uint64]struct{}
	framePoolClosed atomic.Bool

	// Input state.
	mu              sync.Mutex
	pendingClipText []byte
	prevButtons     uint32

	reconnectBurst      int
	reconnectBurstStart time.Time

	// WebRTC video path: when webrtcMode is set, the run loop encodes the GDI
	// framebuffer to VP8/VP9/AV1 (videoEnc) instead of emitting dirty-bitmap
	// frames, and the gateway feeds those access units to a Pion track. videoDirty
	// is set by the paint/gfx callbacks; forceKeyframe is set on a gateway PLI.
	// The video* fields are touched only on the run-loop thread.
	webrtcMode    atomic.Bool
	videoDirty    atomic.Bool
	forceKeyframe atomic.Bool
	videoEnc      videoEncoder
	videoW        int
	videoH        int
	lastVideoAt   time.Time
	// videoTargetKbps is the live CBR target, driven by the gateway's GCC
	// bandwidth estimate (ClientMessage.SetBitrateKbps). 0 until the first
	// estimate lands; the encode loop then falls back to the quality-tier
	// bitrate. Read/written from multiple goroutines → atomic.
	videoTargetKbps atomic.Int64
}

type rdpgfxSurfaceState struct {
	id           uint16
	width        uint32
	height       uint32
	pixelFormat  uint8
	mapped       bool
	outputX      uint32
	outputY      uint32
	targetWidth  uint32
	targetHeight uint32
}

// NewClient — libfreerdp-backed worker. Call Start to actually connect.
func NewClient(logger *zap.Logger) desktop.DesktopWorker {
	return &Client{
		logger: logger,
		// `out` is sized for the GFX/H.264 burst: when AVC420 SURFACE_COMMAND
		// packets arrive in quick succession (typical Win11 desktop with
		// animations), the goroutine pumping `out` to the WS lags 1-2 ms
		// behind libfreerdp's event loop. 1024 slots buys ~50 ms of slack
		// at 60 fps before emit() starts dropping into the resync path.
		// Previous 256-slot buffer was sized for the GDI-only path and
		// hit drops once GFX was enabled.
		out:  make(chan desktop.ServerMessage, 1024),
		in:   make(chan desktop.ClientMessage, 256),
		done: make(chan struct{}),
	}
}

func (c *Client) Recv() <-chan desktop.ServerMessage { return c.out }

func (c *Client) Send(msg desktop.ClientMessage) error {
	if c.closing.Load() {
		return errors.New("client closing")
	}
	select {
	case c.in <- msg:
		return nil
	default:
		return errors.New("input queue full")
	}
}

func (c *Client) Close() error {
	c.closeMu.Do(func() {
		c.closing.Store(true)
		if c.cancel != nil {
			c.cancel()
		}
		<-c.done
		close(c.out)
	})
	return nil
}

func (c *Client) Start(ctx context.Context, p desktop.StartParams) error {
	c.params = p
	c.width = uint32(p.Width)
	c.height = uint32(p.Height)
	if c.width == 0 {
		c.width = 1280
	}
	if c.height == 0 {
		c.height = 720
	}
	if err := c.initFrameEncoder(); err != nil {
		return err
	}

	// Build the FreeRDP instance and stage settings before the event loop calls
	// freerdp_connect. Our LoadChannels wrapper queues only the settings-backed
	// channels we actually support.
	if err := c.bringUpInstance(); err != nil {
		c.closeFrameEncoder()
		return err
	}
	// Surface the actual security mode the worker will offer so
	// "ERRCONNECT_CONNECT_TRANSPORT_FAILED" sessions are debuggable from
	// the gateway log alone — the operator can immediately see whether
	// the failure was negotiating NLA, TLS, or RDP layer.
	nla, tls, rdpSec := c.params.RDP.SecurityFlags()
	c.logger.Info("freerdp connect settings",
		zap.String("host", p.Host),
		zap.Int("port", p.Port),
		zap.String("security", string(c.params.RDP.Security)),
		zap.Bool("nla", nla),
		zap.Bool("tls", tls),
		zap.Bool("rdp_security", rdpSec),
		zap.Bool("ignore_cert", c.params.RDP.IgnoreCert == nil || *c.params.RDP.IgnoreCert),
		zap.String("domain", c.params.RDP.Domain),
		zap.Uint32("width", c.width),
		zap.Uint32("height", c.height),
		zap.Int("scale", c.params.Scale))

	// Spawn the event loop. Browser input is queued on c.in by Send and
	// drained from the FreeRDP owner thread inside runLoop.
	runCtx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	go c.runLoop(runCtx)
	return nil
}

func (c *Client) applySettings() error {
	rctx := (*C.rdpContext)(c.context)
	s := C.wContextSettings(rctx)
	host := C.CString(c.params.Host)
	defer C.free(unsafe.Pointer(host))
	// Normalize the logon name. Operators commonly store "DOMAIN\\user" (or a
	// "user@domain" UPN) in the username field while leaving the domain field
	// empty; some Windows NLA/CredSSP stacks then reject the logon
	// (ERRCONNECT_LOGON_FAILURE 0x00020014) because the down-level prefix isn't
	// parsed out. Split it so FreeRDP gets a clean Username + Domain.
	loginUser, loginDomain := splitUserDomain(c.params.Username, c.params.Domain)
	user := C.CString(loginUser)
	defer C.free(unsafe.Pointer(user))
	pass := C.CString(c.params.Password)
	defer C.free(unsafe.Pointer(pass))
	port := uint32(c.params.Port)
	if port == 0 {
		port = 3389
	}

	if !goBool(C.freerdp_settings_set_string(s, C.FreeRDP_ServerHostname, host)) {
		return errors.New("set hostname")
	}
	if !goBool(C.freerdp_settings_set_uint32(s, C.FreeRDP_ServerPort, C.UINT32(port))) {
		return errors.New("set port")
	}
	if !goBool(C.freerdp_settings_set_string(s, C.FreeRDP_Username, user)) {
		return errors.New("set username")
	}
	if !goBool(C.freerdp_settings_set_string(s, C.FreeRDP_Password, pass)) {
		return errors.New("set password")
	}
	if loginDomain != "" {
		dom := C.CString(loginDomain)
		defer C.free(unsafe.Pointer(dom))
		C.freerdp_settings_set_string(s, C.FreeRDP_Domain, dom)
	}
	// Diagnostic for logon failures. The password is never logged — only its
	// length, which surfaces a stored credential accidentally carrying a
	// trailing newline / whitespace (a common cause of "Logon failed" when the
	// same password works from mstsc).
	c.logger.Info("freerdp logon identity",
		zap.String("username", loginUser),
		zap.String("domain", loginDomain),
		zap.Bool("username_had_domain_prefix", loginUser != c.params.Username),
		zap.Bool("password_present", c.params.Password != ""),
		zap.Int("password_len", len(c.params.Password)))
	autoLogon := c.params.Username != "" || c.params.Password != ""
	C.freerdp_settings_set_bool(s, C.FreeRDP_AutoLogonEnabled, cBool(autoLogon))
	C.freerdp_settings_set_bool(s, C.FreeRDP_LogonNotify, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_LogonErrors, C.TRUE)
	C.freerdp_settings_set_uint32(s, C.FreeRDP_DesktopWidth, C.UINT32(c.width))
	C.freerdp_settings_set_uint32(s, C.FreeRDP_DesktopHeight, C.UINT32(c.height))

	// High-DPI: advertise the desktop + device scale factors in the GCC client
	// core data (MS-RDPBCGR §2.2.1.3.2 desktopScaleFactor / deviceScaleFactor)
	// so the remote Windows applies display scaling at our physical
	// DesktopWidth/Height. Without this, the high-resolution physical desktop
	// renders with tiny 100%-scaled UI; with it, text/UI come out crisp and
	// correctly sized. DesktopScaleFactor is valid 100..500; DeviceScaleFactor
	// is restricted by the spec to exactly {100,140,180} — libfreerdp drops
	// out-of-range values, so snap to the nearest legal step. scale<=100 leaves
	// both unset (default 100% behaviour).
	if scale := c.params.Scale; scale >= 100 && scale <= 500 {
		dev := C.UINT32(100)
		if scale >= 160 {
			dev = 180
		} else if scale >= 120 {
			dev = 140
		}
		C.freerdp_settings_set_uint32(s, C.FreeRDP_DesktopScaleFactor, C.UINT32(scale))
		C.freerdp_settings_set_uint32(s, C.FreeRDP_DeviceScaleFactor, dev)
		// Carry the scale factors in the monitor layout the server reads back.
		C.freerdp_settings_set_bool(s, C.FreeRDP_SupportMonitorLayoutPdu, C.TRUE)
	}

	// ----- GCC ConferenceCreateRequest core data (MS-RDPBCGR §2.2.1.3.2) -----
	// Win11 / Server 2022 RDS silently drop MCS Connect Initial when these
	// TS_UD_CS_CORE fields arrive zero/empty. libfreerdp's
	// gcc_write_client_core_data writes settings values verbatim — no
	// defaults are substituted at wire-write time — so they have to be
	// populated here before freerdp_connect() builds the PDU. Symptom of
	// missing values: TLS completes, then 6+ seconds of silence followed
	// by BIO_read retries exceeded → 0x0002000D.
	hostname := "JumpServer"
	if h, err := os.Hostname(); err == nil && h != "" {
		if len(h) > 15 {
			h = h[:15]
		}
		hostname = h
	}
	chostname := C.CString(hostname)
	defer C.free(unsafe.Pointer(chostname))
	C.freerdp_settings_set_string(s, C.FreeRDP_ClientHostname, chostname)

	cprod := C.CString("1")
	defer C.free(unsafe.Pointer(cprod))
	C.freerdp_settings_set_string(s, C.FreeRDP_ClientProductId, cprod)

	// ClientBuild = Win10 22H2 build number. Any value ≥7600 signals RDP
	// 7+ to the server; 19045 is what mstsc on a fresh Win10 22H2 install
	// reports, so server-side telemetry sees a familiar build.
	C.freerdp_settings_set_uint32(s, C.FreeRDP_ClientBuild, 19045)
	C.freerdp_settings_set_uint32(s, C.FreeRDP_OsMajorType, 4) // OSMAJORTYPE_WINDOWS
	C.freerdp_settings_set_uint32(s, C.FreeRDP_OsMinorType, 7) // OSMINORTYPE_WINDOWS_NT

	// KeyboardLayout MUST be a valid LCID — 0 is rejected by modern
	// Windows. Type=4 / SubType=0 / FunctionKey=12 describes an IBM
	// enhanced 101/102 keyboard (what mstsc reports).
	kbdLayout := keyboardLayoutFromString(c.params.Keyboard)
	C.freerdp_settings_set_uint32(s, C.FreeRDP_KeyboardLayout, C.UINT32(kbdLayout))
	C.freerdp_settings_set_uint32(s, C.FreeRDP_KeyboardType, 4)
	C.freerdp_settings_set_uint32(s, C.FreeRDP_KeyboardSubType, 0)
	C.freerdp_settings_set_uint32(s, C.FreeRDP_KeyboardFunctionKey, 12)

	// SupportedColorDepths bitmask: 15+16+24+32 bpp; server picks. Typed
	// as UINT16 in libfreerdp 3.x — using set_uint32 logs "Invalid key
	// index 153 ... FREERDP_SETTINGS_TYPE_UINT16" and silently no-ops.
	C.freerdp_settings_set_uint16(s, C.FreeRDP_SupportedColorDepths, 0x000F)

	opts := c.params.RDP

	// EarlyCapabilityFlags:
	//   0x0001 RNS_UD_CS_SUPPORT_ERRINFO_PDU
	//   0x0020 RNS_UD_CS_VALID_CONNECTION_TYPE   (must accompany ConnectionType)
	//   0x0080 RNS_UD_CS_SUPPORT_STATUSINFO_PDU
	//   0x0100 RNS_UD_CS_SUPPORT_DYNVC_GFX_PROTOCOL
	//   0x0200 RNS_UD_CS_SUPPORT_DYNAMIC_TIME_ZONE
	earlyCapabilityFlags := uint32(0x0001 | 0x0020 | 0x0080)
	C.freerdp_settings_set_uint32(s, C.FreeRDP_EarlyCapabilityFlags, C.UINT32(earlyCapabilityFlags))

	// ConnectionType hint (MS-RDPBCGR TS_UD_CS_CORE.connectionType). Resolved
	// by the gateway from the node's network preset (lan/wan/mobile/…) or an
	// explicit operator override; defaults to BROADBAND_LOW (2) — the historical
	// value, safe for the RTT-bounded tunnelled gateway → RDS link. Higher hints
	// (LAN/BROADBAND_HIGH) let the server lean on richer visuals; lower ones
	// (MODEM/WAN) make it trim aggressively. RNS_UD_CS_VALID_CONNECTION_TYPE is
	// already set in EarlyCapabilityFlags above so the server honours this.
	connectionType := opts.ConnectionTypeOrDefault()
	C.freerdp_settings_set_uint32(s, C.FreeRDP_ConnectionType, C.UINT32(connectionType))

	// Bulk data compression (MPPC / RDP6, MS-RDPBCGR §3.1.8). Resolved from the
	// network preset / operator override: trades worker CPU for fewer bytes on
	// the legacy bitmap + order/cache path (worth it on WAN/mobile; pointless on
	// LAN and irrelevant to the already-compressed GFX/H.264/VP9 paths). Off by
	// default. CompressionLevel selects the window/codec generation (0=8K, 1=64K,
	// 2=RDP6, 3=RDP6.1) and is only meaningful when compression is enabled.
	bulkCompression := goBool(cBoolDefault(opts.BulkCompression, false))
	C.freerdp_settings_set_bool(s, C.FreeRDP_CompressionEnabled, cBool(bulkCompression))
	if bulkCompression {
		C.freerdp_settings_set_uint32(s, C.FreeRDP_CompressionLevel, C.UINT32(opts.CompressionLevelOrDefault()))
	}

	// Multitransport / network autodetect / heartbeat / batched channel join:
	// off. The gateway has no UDP sidechannel, some Server 2022 builds
	// deadlock on the network autodetect PDU, and FreeRDP treats heartbeat as
	// requiring RDPDR. That in turn auto-adds fake RDPSND and DRDYNVC, which
	// we don't fully wire yet and which can kill display before the first frame.
	C.freerdp_settings_set_bool(s, C.FreeRDP_SupportMultitransport, C.FALSE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_NetworkAutoDetect, C.FALSE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_SupportHeartbeatPdu, C.FALSE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_SupportSkipChannelJoin, C.FALSE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_RefreshRect, C.TRUE)
	// Advertise suppress-output so we can explicitly send the "allow display
	// updates" PDU after connect. Some hosts otherwise complete RDPGFX caps but
	// never produce the first mapped surface.
	C.freerdp_settings_set_bool(s, C.FreeRDP_SuppressOutput, C.TRUE)

	// Color depth — operator can drop to 16/24 for bandwidth-constrained
	// links. Default 32 keeps full RGB+alpha for modern Windows visuals.
	colorDepth := uint8(32)
	if opts.ColorDepth != nil && (*opts.ColorDepth == 16 || *opts.ColorDepth == 24 || *opts.ColorDepth == 32) {
		colorDepth = *opts.ColorDepth
	}
	if c.safeGraphicsProfile {
		colorDepth = 24
		C.freerdp_settings_set_uint16(s, C.FreeRDP_SupportedColorDepths, 0x0001)
	}
	C.freerdp_settings_set_uint32(s, C.FreeRDP_ColorDepth, C.UINT32(colorDepth))

	// Security mode: SecAny / unset enables every layer FreeRDP supports
	// so the server picks the strongest mutually-supported one. Operators
	// can force a single layer when a server rejects negotiation — e.g.
	// SecTLS for older Windows where NLA is off; SecRDP for very old
	// XP/Server 2003 hosts with only legacy RDP encryption.
	nla, tls, rdpSec := opts.SecurityFlags()
	C.freerdp_settings_set_bool(s, C.FreeRDP_NlaSecurity, cBool(nla))
	C.freerdp_settings_set_bool(s, C.FreeRDP_TlsSecurity, cBool(tls))
	C.freerdp_settings_set_bool(s, C.FreeRDP_RdpSecurity, cBool(rdpSec))
	// HYBRID_EX (NLA-EX) is required by Windows 10/11/2022 with recent
	// CredSSP patches — without it the server replies with
	// ERRCONNECT_SECURITY_NEGO_CONNECT_FAILED (0x0002000C) because none
	// of the offered protocols match its policy. Only enable in "any"
	// mode; explicit SecNLA / SecTLS / SecRDP shapes mean the operator
	// asked for that specific protocol only.
	extSec := opts.Security == desktop.SecAny || opts.Security == ""
	C.freerdp_settings_set_bool(s, C.FreeRDP_ExtSecurity, cBool(extSec))
	// We do NOT enable FreeRDP_RdstlsSecurity here. When RDSTLS is on,
	// libfreerdp strips NLA + NLA-EX from the X.224 client request (RDSTLS
	// is mutually exclusive with HYBRID variants in the negotiation), so
	// a direct-connect Win10/11 host without Microsoft Entra/RD Gateway
	// support sees only TLS+RDSTLS offered, picks RDSTLS, then fails
	// authentication. Empirically this broke connections that worked via
	// plain NLA. RDSTLS is therefore left off by default; operators who
	// genuinely need it for a RD Web Access / Entra-joined host can set
	// security="any" on the node and we'll keep that path opt-in later.
	//
	// Explicit RestrictedAdminModeRequired = FALSE. If the server thinks
	// the client is asking for restricted-admin (a special NLA sub-mode
	// that disables LSASS credential extraction) it may reject the
	// credential exchange in some lockdown GPOs.
	C.freerdp_settings_set_bool(s, C.FreeRDP_RestrictedAdminModeRequired, C.FALSE)
	// NegotiateSecurityLayer is TRUE by default in FreeRDP 3.x but make
	// it explicit so future libfreerdp versions can't flip the default
	// without us noticing.
	C.freerdp_settings_set_bool(s, C.FreeRDP_NegotiateSecurityLayer, C.TRUE)

	ignoreCert := true
	if opts.IgnoreCert != nil {
		ignoreCert = *opts.IgnoreCert
	}
	C.freerdp_settings_set_bool(s, C.FreeRDP_IgnoreCertificate, cBool(ignoreCert))
	C.freerdp_settings_set_bool(s, C.FreeRDP_AuthenticationOnly, C.FALSE)

	// TLS SecLevel default 0 lets OpenSSL accept TLS 1.0+. Useful for
	// older Windows Server 2008R2/2012R2 hosts; operators can raise to
	// ≥3 for stricter policy.
	tlsSecLevel := uint8(0)
	if opts.TlsSecLevel != nil && *opts.TlsSecLevel <= 5 {
		tlsSecLevel = *opts.TlsSecLevel
	}
	C.freerdp_settings_set_uint32(s, C.FreeRDP_TlsSecLevel, C.UINT32(tlsSecLevel))

	tcpConnectTimeout := uint32(8000)
	if opts.TcpConnectTimeoutMS != nil && *opts.TcpConnectTimeoutMS >= 1000 {
		tcpConnectTimeout = *opts.TcpConnectTimeoutMS
	}
	tcpAckTimeout := uint32(9000)
	if opts.TcpAckTimeoutMS != nil && *opts.TcpAckTimeoutMS >= 1000 {
		tcpAckTimeout = *opts.TcpAckTimeoutMS
	}
	C.freerdp_settings_set_uint32(s, C.FreeRDP_TcpConnectTimeout, C.UINT32(tcpConnectTimeout))
	C.freerdp_settings_set_uint32(s, C.FreeRDP_TcpAckTimeout, C.UINT32(tcpAckTimeout))

	// Proxy chain forwarding. When the gateway stood up a per-session SOCKS5
	// listener (manager.StartSession resolved node.ProxyChain), route
	// libfreerdp's transport through it so the connect to
	// ServerHostname:ServerPort is tunnelled through JumpServer's bastion /
	// SOCKS5 hops instead of dialed directly — the same way guacd reaches
	// these targets. The listener is localhost + no-auth, so we leave
	// ProxyUsername / ProxyPassword empty.
	if c.params.SOCKSHost != "" && c.params.SOCKSPort > 0 {
		C.freerdp_settings_set_uint32(s, C.FreeRDP_ProxyType, C.PROXY_TYPE_SOCKS)
		phost := C.CString(c.params.SOCKSHost)
		C.freerdp_settings_set_string(s, C.FreeRDP_ProxyHostname, phost)
		C.free(unsafe.Pointer(phost))
		C.freerdp_settings_set_uint16(s, C.FreeRDP_ProxyPort, C.UINT16(uint16(c.params.SOCKSPort)))
		c.logger.Info("freerdp transport routed through gateway SOCKS5 proxy chain",
			zap.String("proxy_host", c.params.SOCKSHost),
			zap.Int("proxy_port", c.params.SOCKSPort),
			zap.String("target", fmt.Sprintf("%s:%d", c.params.Host, c.params.Port)))
	}

	// RD Gateway (MS-TSGU): tunnel the RDP connection through a Microsoft Remote
	// Desktop Gateway when the node is only reachable that way. GatewayUsageMethod
	// DIRECT forces the gateway for the target; the transport choice decides
	// HTTP/WebSocket (modern) vs RPC-over-HTTP (legacy 2008/2012). Independent of
	// the SOCKS proxy chain above — FreeRDP routes the gateway's own TCP through
	// the proxy if both are set.
	if c.params.GatewayHost != "" {
		gwPort := uint32(443)
		if c.params.GatewayPort > 0 && c.params.GatewayPort <= 65535 {
			gwPort = uint32(c.params.GatewayPort)
		}
		C.freerdp_settings_set_bool(s, C.FreeRDP_GatewayEnabled, C.TRUE)
		C.freerdp_settings_set_uint32(s, C.FreeRDP_GatewayUsageMethod, C.TSC_PROXY_MODE_DIRECT)
		ghost := C.CString(c.params.GatewayHost)
		C.freerdp_settings_set_string(s, C.FreeRDP_GatewayHostname, ghost)
		C.free(unsafe.Pointer(ghost))
		C.freerdp_settings_set_uint32(s, C.FreeRDP_GatewayPort, C.UINT32(gwPort))
		// Transport: default "auto" tries HTTP/WebSocket then RPC.
		httpT, rpcT := true, true
		switch c.params.GatewayTransport {
		case "http":
			rpcT = false
		case "rpc":
			httpT = false
		}
		C.freerdp_settings_set_bool(s, C.FreeRDP_GatewayHttpTransport, cBool(httpT))
		C.freerdp_settings_set_bool(s, C.FreeRDP_GatewayRpcTransport, cBool(rpcT))
		C.freerdp_settings_set_bool(s, C.FreeRDP_GatewayHttpUseWebsockets, cBool(httpT))
		C.freerdp_settings_set_bool(s, C.FreeRDP_GatewayUdpTransport, C.FALSE)
		if c.params.GatewayUseSameCredentials {
			C.freerdp_settings_set_bool(s, C.FreeRDP_GatewayUseSameCredentials, C.TRUE)
		} else {
			C.freerdp_settings_set_bool(s, C.FreeRDP_GatewayUseSameCredentials, C.FALSE)
			if c.params.GatewayUsername != "" {
				gwUser, gwDom := splitUserDomain(c.params.GatewayUsername, c.params.GatewayDomain)
				cu := C.CString(gwUser)
				C.freerdp_settings_set_string(s, C.FreeRDP_GatewayUsername, cu)
				C.free(unsafe.Pointer(cu))
				if gwDom != "" {
					cd := C.CString(gwDom)
					C.freerdp_settings_set_string(s, C.FreeRDP_GatewayDomain, cd)
					C.free(unsafe.Pointer(cd))
				}
			}
			if c.params.GatewayPassword != "" {
				cp := C.CString(c.params.GatewayPassword)
				C.freerdp_settings_set_string(s, C.FreeRDP_GatewayPassword, cp)
				C.free(unsafe.Pointer(cp))
			}
		}
		c.logger.Info("freerdp routed through RD Gateway (MS-TSGU)",
			zap.String("gateway_host", c.params.GatewayHost),
			zap.Uint32("gateway_port", gwPort),
			zap.Bool("same_credentials", c.params.GatewayUseSameCredentials),
			zap.Bool("http_transport", httpT),
			zap.Bool("rpc_transport", rpcT),
			zap.String("target", fmt.Sprintf("%s:%d", c.params.Host, c.params.Port)))
	}

	C.freerdp_settings_set_bool(s, C.FreeRDP_AutoReconnectionEnabled, C.TRUE)
	C.freerdp_settings_set_uint32(s, C.FreeRDP_AutoReconnectMaxRetries, 3)
	C.freerdp_settings_set_bool(s, C.FreeRDP_BitmapCacheEnabled, cBool(!c.safeGraphicsProfile))
	// FreeRDP 3.x typed OffscreenSupportLevel as UINT32 (a capability
	// level: 0 = unsupported, 1 = supported). The old set_bool call here
	// triggered "Invalid key index 2816 ... FREERDP_SETTINGS_TYPE_UINT32"
	// at runtime and the setting silently no-op'd, which broke the
	// MCS capability set the server sees during negotiation.
	offscreenSupportLevel := uint32(1)
	if c.safeGraphicsProfile {
		offscreenSupportLevel = 0
	}
	C.freerdp_settings_set_uint32(s, C.FreeRDP_OffscreenSupportLevel, C.UINT32(offscreenSupportLevel))
	C.freerdp_settings_set_bool(s, C.FreeRDP_FastPathInput, C.TRUE)
	// Modern Windows commonly sends SurfaceBits over fast-path updates. Keep
	// output fast-path enabled even in safe mode; the safe profile only strips
	// optional caches/codecs that are not required for decoded BGRA output.
	C.freerdp_settings_set_bool(s, C.FreeRDP_FastPathOutput, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_FrameMarkerCommandEnabled, C.TRUE)

	// Codec / GFX toggles. RDPGFX is handled worker-side by FreeRDP's GDI
	// graphics pipeline: surface/cache/frame PDUs are decoded into the local
	// primary buffer, then emitted to the browser as ordinary BGRA/JPEG/Zlib
	// rectangles. The first attempt uses FreeRDP's modern network:auto-style AVC
	// profile. If a server negotiates GFX but only emits empty frames, retry with
	// /gfx-style compatibility caps: keep RDPGFX, but stop advertising H.264 so
	// the server must choose a non-AVC surface path. AVC444 is not advertised by
	// default because the browser pipeline only decodes AVC420's single H.264
	// stream; AVC444/v2 can arrive as multi-stream payloads that WebCodecs cannot
	// consume directly.
	// WebRTC video path: the run loop VP8/VP9-encodes the GDI primary_buffer, so
	// it must hold the full composite. The RDPGFX H.264 path is forwarded raw
	// (not decoded into primary_buffer) and this build has no server-side H.264
	// decoder, so we DISABLE the graphics pipeline in WebRTC mode and let the
	// legacy bitmap/NSCodec/surface path — which FreeRDP's GDI always composites
	// into primary_buffer — drive the framebuffer. webrtcMode is decided at
	// connect (the gateway sets StartParams.VideoMode to the codec from the
	// browser's WebRTC support) because this GFX choice can't change mid-session.
	webrtc := isWebRTCVideoMode(c.params.VideoMode)
	c.webrtcMode.Store(webrtc)
	if webrtc {
		c.forceKeyframe.Store(true)
		c.videoDirty.Store(true)
	}

	enableGFX := !webrtc && !c.safeGraphicsProfile && goBool(cBoolDefault(opts.EnableGraphicsPipeline, true))
	enableH264 := enableGFX && !c.gfxCompatProfile && goBool(cBoolDefault(opts.EnableH264, true))
	enableAVC444 := false
	enableRFX := enableGFX && goBool(cBoolDefault(opts.EnableRemoteFx, false))
	enableNSCodec := !c.safeGraphicsProfile && goBool(cBoolDefault(opts.EnableNSCodec, true))
	if enableGFX {
		earlyCapabilityFlags |= 0x0100
		C.freerdp_settings_set_uint32(s, C.FreeRDP_EarlyCapabilityFlags, C.UINT32(earlyCapabilityFlags))
	}
	C.freerdp_settings_set_bool(s, C.FreeRDP_RemoteFxCodec, cBool(enableRFX))
	C.freerdp_settings_set_bool(s, C.FreeRDP_NSCodec, cBool(enableNSCodec))
	C.freerdp_settings_set_bool(s, C.FreeRDP_GfxH264, cBool(enableH264))
	C.freerdp_settings_set_bool(s, C.FreeRDP_GfxAVC444, cBool(enableAVC444))
	C.freerdp_settings_set_bool(s, C.FreeRDP_GfxAVC444v2, cBool(enableAVC444))
	C.freerdp_settings_set_bool(s, C.FreeRDP_SupportGraphicsPipeline, cBool(enableGFX))

	// Performance vs. fidelity tradeoffs. All default false (i.e. keep
	// Windows visuals enabled), letting the operator switch them on to
	// reduce bandwidth on slow links.
	C.freerdp_settings_set_bool(s, C.FreeRDP_DisableWallpaper, cBoolDefault(opts.DisableWallpaper, false))
	C.freerdp_settings_set_bool(s, C.FreeRDP_DisableFullWindowDrag, cBoolDefault(opts.DisableFullWindowDrag, false))
	C.freerdp_settings_set_bool(s, C.FreeRDP_DisableMenuAnims, cBoolDefault(opts.DisableMenuAnims, false))
	C.freerdp_settings_set_bool(s, C.FreeRDP_DisableThemes, cBoolDefault(opts.DisableThemes, false))
	C.freerdp_settings_set_bool(s, C.FreeRDP_AllowFontSmoothing, cBoolDefault(opts.AllowFontSmoothing, true))
	C.freerdp_settings_set_bool(s, C.FreeRDP_AllowDesktopComposition, cBoolDefault(opts.AllowDesktopComposition, true))

	// Redirection toggles. Clipboard is wired enough for text. Audio, drive,
	// printers, smartcards, and dynamic virtual channels are not wired end to
	// end yet; force them off for now so the display path cannot be killed by
	// half-attached post-connect channels even if a node persisted old opts.
	// GFX / H.264 used to live in this warning block, but those are now
	// honoured (see the GFX/H.264 toggle section above) so only the
	// truly-still-unwired channels remain here.
	unsupportedAudio := opts.AudioPlayback != nil && *opts.AudioPlayback
	if unsupportedAudio {
		c.logger.Warn("unsupported RDP channel options ignored until browser protocol supports them",
			zap.Bool("audio_playback", unsupportedAudio))
	}
	C.freerdp_settings_set_bool(s, C.FreeRDP_RedirectClipboard, cBoolDefault(opts.RedirectClipboard, true))
	C.freerdp_settings_set_bool(s, C.FreeRDP_AudioPlayback, C.FALSE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_DeviceRedirection, C.FALSE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_RedirectDrives, C.FALSE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_RedirectPrinters, C.FALSE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_RedirectSmartCards, C.FALSE)

	// Drive redirection: mount the gateway-provided per-user folder as a
	// drive so files move between the browser host and the remote desktop.
	// Empty DrivePath leaves device redirection off entirely.
	if c.params.DrivePath != "" {
		name := c.params.DriveName
		if name == "" {
			name = "JumpServer"
		}
		// Defensive: the gateway creates this folder, but the device is
		// dropped outright if the path is missing when libfreerdp registers
		// it — so make sure it exists from the worker's own view first.
		if err := os.MkdirAll(c.params.DrivePath, 0o750); err != nil {
			c.logger.Warn("rdp drive folder could not be ensured",
				zap.String("drive_path", c.params.DrivePath), zap.Error(err))
		}
		_, statErr := os.Stat(c.params.DrivePath)
		cName := C.CString(name)
		cPath := C.CString(c.params.DrivePath)
		okDrive := goBool(C.wAddDriveRedirect(s, cName, cPath))
		C.free(unsafe.Pointer(cName))
		C.free(unsafe.Pointer(cPath))
		devCount := uint32(C.wDeviceCount(s))
		if okDrive {
			// Enable audio playback so wLoadChannels brings up rdpsnd (routed to
			// our jsaudio device). rdpsnd's presence is also what makes Windows
			// initialise its RDPDR subsystem — i.e. it's the dependency that
			// makes the redirected drive actually appear.
			C.freerdp_settings_set_bool(s, C.FreeRDP_AudioPlayback, C.TRUE)
			c.logger.Info("rdp drive redirection registered",
				zap.String("drive_name", name),
				zap.String("drive_path", c.params.DrivePath),
				zap.Bool("path_exists", statErr == nil),
				zap.Uint32("device_count", devCount),
				zap.Bool("device_redirection", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_DeviceRedirection))))
		} else {
			c.logger.Warn("rdp drive redirection failed to attach",
				zap.String("drive_path", c.params.DrivePath),
				zap.Bool("path_exists", statErr == nil))
		}
	}
	C.freerdp_settings_set_bool(s, C.FreeRDP_SupportDynamicChannels, C.FALSE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_SynchronousDynamicChannels, C.FALSE)
	c.logger.Info("freerdp channel settings",
		zap.Bool("redirect_clipboard", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_RedirectClipboard))),
		zap.Bool("audio_playback", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_AudioPlayback))),
		zap.Bool("device_redirection", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_DeviceRedirection))),
		zap.Bool("dynamic_channels", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_SupportDynamicChannels))),
		zap.Bool("heartbeat_pdu", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_SupportHeartbeatPdu))))
	c.logger.Info("freerdp graphics settings",
		zap.Bool("safe_profile", c.safeGraphicsProfile),
		zap.Bool("gfx_compat_profile", c.gfxCompatProfile),
		zap.Uint8("color_depth", colorDepth),
		zap.String("early_capability_flags", fmt.Sprintf("0x%04x", earlyCapabilityFlags)),
		zap.Bool("bitmap_cache", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_BitmapCacheEnabled))),
		zap.Uint32("offscreen_support_level", offscreenSupportLevel),
		zap.Bool("fast_path_output", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_FastPathOutput))),
		zap.Bool("refresh_rect", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_RefreshRect))),
		zap.Bool("suppress_output", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_SuppressOutput))),
		zap.Bool("support_graphics_pipeline", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_SupportGraphicsPipeline))),
		zap.Bool("frame_marker", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_FrameMarkerCommandEnabled))),
		zap.Bool("gfx_h264", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_GfxH264))),
		zap.Bool("gfx_avc444", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_GfxAVC444))),
		zap.Bool("gfx_avc444v2", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_GfxAVC444v2))),
		zap.Bool("nscodec", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_NSCodec))),
		zap.Bool("remotefx", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_RemoteFxCodec))))
	c.logger.Info("freerdp logon settings",
		zap.Bool("auto_logon", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_AutoLogonEnabled))),
		zap.Bool("logon_notify", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_LogonNotify))),
		zap.Bool("logon_errors", goBool(C.freerdp_settings_get_bool(s, C.FreeRDP_LogonErrors))))
	c.logChannelCollections(s, "after applySettings before FreeRDP load_addins")

	// Optional /admin /console session for direct RDS console attach.
	if opts.ConsoleSession != nil && *opts.ConsoleSession {
		C.freerdp_settings_set_bool(s, C.FreeRDP_ConsoleSession, C.TRUE)
	}

	c.logger.Info("freerdp GCC core data",
		zap.String("client_hostname", hostname),
		zap.Uint32("client_build", 19045),
		zap.Uint32("keyboard_layout", kbdLayout),
		zap.String("keyboard_string", c.params.Keyboard),
		zap.Uint32("os_major_type", 4),
		zap.String("network_preset", opts.NetworkPreset),
		zap.Uint8("connection_type", connectionType),
		zap.Bool("bulk_compression", bulkCompression),
		zap.Uint8("compression_level", opts.CompressionLevelOrDefault()))
	return nil
}

func cBool(b bool) C.BOOL {
	if b {
		return C.TRUE
	}
	return C.FALSE
}

func cBoolDefault(p *bool, dflt bool) C.BOOL {
	if p == nil {
		return cBool(dflt)
	}
	return cBool(*p)
}

// splitUserDomain normalizes an RDP logon name. A down-level "DOMAIN\\user"
// becomes (user, DOMAIN) so FreeRDP's NLA/CredSSP gets the parts it expects; a
// "user@domain" UPN is left intact in the username field (CredSSP handles UPNs
// natively) with no separate domain. An explicitly configured domain always
// wins over one parsed from the username. Surrounding whitespace is trimmed
// from the username (a stored "user\n" otherwise fails NLA).
func splitUserDomain(username, domain string) (user, dom string) {
	user = strings.TrimSpace(username)
	dom = domain
	if i := strings.IndexByte(user, '\\'); i >= 0 {
		if dom == "" {
			dom = user[:i]
		}
		user = user[i+1:]
	}
	return user, dom
}

func (c *Client) logChannelCollections(s *C.rdpSettings, stage string) {
	c.logger.Info("freerdp channel collections",
		zap.String("stage", stage),
		zap.Uint32("static_count", uint32(C.wStaticChannelCount(s))),
		zap.Strings("static_channels", readStaticChannelNames(s)),
		zap.Uint32("dynamic_count", uint32(C.wDynamicChannelCount(s))),
		zap.Strings("dynamic_channels", readDynamicChannelNames(s)))
}

func readStaticChannelNames(s *C.rdpSettings) []string {
	count := uint32(C.wStaticChannelCount(s))
	out := make([]string, 0, count)
	for i := uint32(0); i < count; i++ {
		name := C.wStaticChannelName(s, C.UINT32(i))
		if name == nil {
			out = append(out, "<nil>")
			continue
		}
		out = append(out, C.GoString(name))
	}
	return out
}

func readDynamicChannelNames(s *C.rdpSettings) []string {
	count := uint32(C.wDynamicChannelCount(s))
	out := make([]string, 0, count)
	for i := uint32(0); i < count; i++ {
		name := C.wDynamicChannelName(s, C.UINT32(i))
		if name == nil {
			out = append(out, "<nil>")
			continue
		}
		out = append(out, C.GoString(name))
	}
	return out
}

// runLoop owns the libfreerdp event loop. Must run on a single OS thread
// because libfreerdp's GDI assumes the thread that opened the connection
// is the same one issuing draws.
func (c *Client) runLoop(ctx context.Context) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	defer close(c.done)
	defer c.teardown()

	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseConnecting}})

	if !c.connectWithAutoNlaRetry() {
		return
	}
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseConnected}})
	c.sendFocusIn("initial activation")
	c.requestDesktopRefresh("initial activation")

	rctx := (*C.rdpContext)(c.context)
	// 16 is enough for the typical channel set; bump if we observe handle
	// exhaustion in the wild.
	const maxHandles = 64
	var handles [maxHandles]C.HANDLE
	connectedAt := time.Now()
	nextStats := time.Now().Add(5 * time.Second)
	nextFirstFrameDiag := time.Now().Add(5 * time.Second)
	for {
		c.drainInput(128)
		c.emitPendingFrameResync("queued frame recovery")
		c.sendPendingFocusIn()
		c.maybeEncodeVideo(rctx)
		if now := time.Now(); !now.Before(nextStats) {
			c.emitFrameStats()
			nextStats = now.Add(5 * time.Second)
			if !c.firstFrameLogged.Load() && !now.Before(nextFirstFrameDiag) {
				elapsed := now.Sub(connectedAt)
				c.logFirstFrameWait(elapsed)
				c.requestDesktopRefresh("no first frame diagnostic")
				if c.shouldFallbackFromRDPGFXStall(elapsed) {
					if connected := c.tryFirstFrameStallGraphicsRetry(ctx, elapsed); connected {
						rctx = (*C.rdpContext)(c.context)
						connectedAt = time.Now()
						nextFirstFrameDiag = connectedAt.Add(5 * time.Second)
						c.sendFocusIn("graphics retry activation")
						c.requestDesktopRefresh("graphics retry activation")
						continue
					}
					return
				}
				nextFirstFrameDiag = now.Add(5 * time.Second)
			}
		}
		if ctx.Err() != nil {
			return
		}
		if goBool(C.freerdp_shall_disconnect_context(rctx)) {
			return
		}
		count := C.freerdp_get_event_handles(rctx, &handles[0], maxHandles)
		if count == 0 {
			c.logger.Warn("freerdp_get_event_handles returned 0")
			return
		}
		// 100ms tick so a stuck network doesn't block the worker from
		// noticing ctx cancellation. Only ask FreeRDP to process handles when
		// WinPR reports one is signaled; calling check_event_handles after a
		// timeout can force a transport read with no data ready and trip
		// BIO_read retry limits.
		// In WebRTC mode tick faster so the VP8 capture loop hits its target
		// frame rate even when the server sends sparse update events.
		waitMS := C.DWORD(100)
		if c.webrtcMode.Load() {
			waitMS = 15
		}
		waitStatus := C.WaitForMultipleObjects(count, &handles[0], C.FALSE, waitMS)
		if waitStatus == C.WAIT_TIMEOUT {
			continue
		}
		if waitStatus == C.WAIT_FAILED {
			c.logger.Warn("WaitForMultipleObjects failed")
			return
		}
		if !goBool(C.freerdp_check_event_handles(rctx)) {
			if handled, connected := c.trySetupFallbackWithoutClipboard(ctx, rctx); handled {
				if connected {
					rctx = (*C.rdpContext)(c.context)
					connectedAt = time.Now()
					nextFirstFrameDiag = connectedAt.Add(5 * time.Second)
					c.sendFocusIn("clipboard fallback activation")
					c.requestDesktopRefresh("clipboard fallback activation")
					continue
				}
				return
			}
			if handled, connected := c.trySetupFallbackSafeGraphics(ctx, rctx); handled {
				if connected {
					rctx = (*C.rdpContext)(c.context)
					connectedAt = time.Now()
					nextFirstFrameDiag = connectedAt.Add(5 * time.Second)
					c.sendFocusIn("safe graphics fallback activation")
					c.requestDesktopRefresh("safe graphics fallback activation")
					continue
				}
				return
			}
			if c.tryAutoReconnect(ctx, rctx) {
				rctx = (*C.rdpContext)(c.context)
				connectedAt = time.Now()
				nextFirstFrameDiag = connectedAt.Add(5 * time.Second)
				c.sendFocusIn("auto-reconnect activation")
				c.requestDesktopRefresh("auto-reconnect activation")
				continue
			}
			if C.freerdp_get_last_error(rctx) != C.FREERDP_ERROR_SUCCESS {
				code := uint32(C.freerdp_get_last_error(rctx))
				raw := C.GoString(C.wErrorStr(rctx))
				requested := uint32(C.wGetRequestedProtocols(rctx))
				selected := uint32(C.wGetSelectedProtocol(rctx))
				instance := (*C.freerdp)(c.instance)
				errorInfo := uint32(C.freerdp_error_info(instance))
				disconnectUltimatum := int(C.freerdp_get_disconnect_ultimatum(rctx))
				c.logger.Warn("freerdp event loop failed",
					zap.Uint32("code", code),
					zap.String("raw", raw),
					zap.Uint32("error_info", errorInfo),
					zap.Int("disconnect_ultimatum", disconnectUltimatum),
					zap.Uint32("requested_protocols_mask", requested),
					zap.Uint32("selected_protocol_mask", selected),
					zap.String("requested_protocols", protocolMaskString(requested)),
					zap.String("selected_protocol", selectedProtocolMaskString(selected, false)))
				c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
					Phase:   desktop.PhaseError,
					Message: humanizeConnectErrorWithNego(code, raw, requested, selected),
					Code:    code,
				}})
				return
			}
			// 0 with no error usually means clean disconnect requested.
			return
		}
		c.drainInput(128)
	}
}

func (c *Client) trySetupFallbackWithoutClipboard(ctx context.Context, rctx *C.rdpContext) (handled bool, connected bool) {
	if ctx.Err() != nil || c.instance == nil || c.firstFrameLogged.Load() || c.clipboardFallbackTried || !c.clipboardEnabled() {
		return false, false
	}
	code := uint32(C.freerdp_get_last_error(rctx))
	if code != 0x0002000D {
		return false, false
	}

	c.clipboardFallbackTried = true
	instance := (*C.freerdp)(c.instance)
	raw := C.GoString(C.wErrorStr(rctx))
	requested := uint32(C.wGetRequestedProtocols(rctx))
	selected := uint32(C.wGetSelectedProtocol(rctx))
	errorInfo := uint32(C.freerdp_error_info(instance))
	disconnectUltimatum := int(C.freerdp_get_disconnect_ultimatum(rctx))
	c.logger.Warn("freerdp setup dropped before first frame; retrying once without clipboard channel",
		zap.Uint32("code", code),
		zap.String("raw", raw),
		zap.Uint32("error_info", errorInfo),
		zap.Int("disconnect_ultimatum", disconnectUltimatum),
		zap.Uint32("requested_protocols_mask", requested),
		zap.Uint32("selected_protocol_mask", selected),
		zap.String("requested_protocols", protocolMaskString(requested)),
		zap.String("selected_protocol", selectedProtocolMaskString(selected, false)))
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseReconnecting, Message: "retrying without clipboard"}})

	c.tearDownInstanceQuietly()
	c.resetFirstFrameDiagnostics()
	disabled := false
	c.params.RDP.RedirectClipboard = &disabled
	if err := c.bringUpInstance(); err != nil {
		c.logger.Error("setup retry without clipboard failed to rebuild FreeRDP instance", zap.Error(err))
		c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
			Phase:   desktop.PhaseError,
			Message: "clipboard fallback 实例重建失败: " + err.Error(),
			Code:    code,
		}})
		return true, false
	}

	instance = (*C.freerdp)(c.instance)
	rctx = (*C.rdpContext)(c.context)
	if goBool(C.freerdp_connect(instance)) {
		c.logSelectedProtocol(rctx, "setup retry without clipboard succeeded")
		c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseConnected, Message: "connected without clipboard"}})
		return true, true
	}

	code = uint32(C.freerdp_get_last_error(rctx))
	raw = C.GoString(C.wErrorStr(rctx))
	requested = uint32(C.wGetRequestedProtocols(rctx))
	selected = uint32(C.wGetSelectedProtocol(rctx))
	c.logger.Error("setup retry without clipboard failed",
		zap.Uint32("code", code),
		zap.String("raw", raw),
		zap.Uint32("requested_protocols_mask", requested),
		zap.Uint32("selected_protocol_mask", selected),
		zap.String("requested_protocols", protocolMaskString(requested)),
		zap.String("selected_protocol", selectedProtocolMaskString(selected, selected == 0)))
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
		Phase:   desktop.PhaseError,
		Message: humanizeConnectErrorWithNego(code, raw, requested, selected),
		Code:    code,
	}})
	return true, false
}

func (c *Client) clipboardEnabled() bool {
	return c.params.RDP.RedirectClipboard == nil || *c.params.RDP.RedirectClipboard
}

func (c *Client) trySetupFallbackSafeGraphics(ctx context.Context, rctx *C.rdpContext) (handled bool, connected bool) {
	if ctx.Err() != nil || c.instance == nil || c.firstFrameLogged.Load() || c.safeGraphicsFallbackTried || c.safeGraphicsProfile {
		return false, false
	}
	code := uint32(C.freerdp_get_last_error(rctx))
	if code != 0x0002000D {
		return false, false
	}

	c.safeGraphicsFallbackTried = true
	instance := (*C.freerdp)(c.instance)
	raw := C.GoString(C.wErrorStr(rctx))
	requested := uint32(C.wGetRequestedProtocols(rctx))
	selected := uint32(C.wGetSelectedProtocol(rctx))
	errorInfo := uint32(C.freerdp_error_info(instance))
	disconnectUltimatum := int(C.freerdp_get_disconnect_ultimatum(rctx))
	c.logger.Warn("freerdp setup dropped before first frame; retrying once with safe graphics profile",
		zap.Uint32("code", code),
		zap.String("raw", raw),
		zap.Uint32("error_info", errorInfo),
		zap.Int("disconnect_ultimatum", disconnectUltimatum),
		zap.Uint32("requested_protocols_mask", requested),
		zap.Uint32("selected_protocol_mask", selected),
		zap.String("requested_protocols", protocolMaskString(requested)),
		zap.String("selected_protocol", selectedProtocolMaskString(selected, false)))
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseReconnecting, Message: "retrying safe graphics profile"}})

	c.tearDownInstanceQuietly()
	c.resetFirstFrameDiagnostics()
	c.gfxCompatProfile = false
	c.safeGraphicsProfile = true
	if err := c.bringUpInstance(); err != nil {
		c.logger.Error("setup retry with safe graphics failed to rebuild FreeRDP instance", zap.Error(err))
		c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
			Phase:   desktop.PhaseError,
			Message: "safe graphics fallback 实例重建失败: " + err.Error(),
			Code:    code,
		}})
		return true, false
	}

	instance = (*C.freerdp)(c.instance)
	rctx = (*C.rdpContext)(c.context)
	if goBool(C.freerdp_connect(instance)) {
		c.logSelectedProtocol(rctx, "setup retry with safe graphics succeeded")
		c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseConnected, Message: "connected with safe graphics"}})
		return true, true
	}

	code = uint32(C.freerdp_get_last_error(rctx))
	raw = C.GoString(C.wErrorStr(rctx))
	requested = uint32(C.wGetRequestedProtocols(rctx))
	selected = uint32(C.wGetSelectedProtocol(rctx))
	c.logger.Error("setup retry with safe graphics failed",
		zap.Uint32("code", code),
		zap.String("raw", raw),
		zap.Uint32("requested_protocols_mask", requested),
		zap.Uint32("selected_protocol_mask", selected),
		zap.String("requested_protocols", protocolMaskString(requested)),
		zap.String("selected_protocol", selectedProtocolMaskString(selected, selected == 0)))
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
		Phase:   desktop.PhaseError,
		Message: humanizeConnectErrorWithNego(code, raw, requested, selected),
		Code:    code,
	}})
	return true, false
}

func (c *Client) shouldFallbackFromRDPGFXStall(elapsed time.Duration) bool {
	if c.safeGraphicsProfile || c.firstFrameLogged.Load() {
		return false
	}
	if elapsed < 10*time.Second {
		return false
	}
	return c.rdpgfxOnOpen.Load() > 0 &&
		c.rdpgfxCapsConfirm.Load() > 0 &&
		c.rdpgfxResetGraphics.Load() > 0 &&
		c.rdpgfxCreateSurfaces.Load() == 0 &&
		c.rdpgfxSurfaceCommands.Load() == 0 &&
		c.bitmapUpdates.Load() == 0 &&
		c.surfaceBits.Load() == 0
}

func (c *Client) tryFirstFrameStallGraphicsRetry(ctx context.Context, elapsed time.Duration) bool {
	if !c.gfxCompatProfile && !c.gfxCompatFallbackTried {
		return c.tryFirstFrameStallCompatGraphics(ctx, elapsed)
	}
	return c.tryFirstFrameStallSafeGraphics(ctx, elapsed)
}

func (c *Client) tryFirstFrameStallCompatGraphics(ctx context.Context, elapsed time.Duration) bool {
	if ctx.Err() != nil || c.instance == nil || c.firstFrameLogged.Load() || c.gfxCompatFallbackTried || c.safeGraphicsProfile {
		return false
	}
	c.gfxCompatFallbackTried = true
	c.logger.Warn("rdpgfx negotiated but produced no desktop surfaces; retrying with compatibility graphics profile",
		zap.Duration("elapsed", elapsed),
		zap.Uint64("rdpgfx_on_open", c.rdpgfxOnOpen.Load()),
		zap.Uint64("rdpgfx_caps_confirm", c.rdpgfxCapsConfirm.Load()),
		zap.Uint32("rdpgfx_caps_version", c.rdpgfxCapsVersion.Load()),
		zap.Uint32("rdpgfx_caps_flags", c.rdpgfxCapsFlags.Load()),
		zap.Uint64("rdpgfx_reset_graphics", c.rdpgfxResetGraphics.Load()),
		zap.Uint64("rdpgfx_start_frames", c.rdpgfxStartFrames.Load()),
		zap.Uint64("rdpgfx_end_frames", c.rdpgfxEndFrames.Load()),
		zap.Uint64("rdpgfx_frame_acks", c.rdpgfxFrameAcks.Load()))
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseReconnecting, Message: "retrying rdpgfx compatibility profile after empty frames"}})

	c.tearDownInstanceQuietly()
	c.resetFirstFrameDiagnostics()
	c.gfxCompatProfile = true
	c.safeGraphicsProfile = false
	if err := c.bringUpInstance(); err != nil {
		c.logger.Error("rdpgfx compatibility retry failed to rebuild FreeRDP instance", zap.Error(err))
		c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
			Phase:   desktop.PhaseError,
			Message: "RDPGFX compatibility retry 实例重建失败: " + err.Error(),
		}})
		return false
	}

	instance := (*C.freerdp)(c.instance)
	rctx := (*C.rdpContext)(c.context)
	if goBool(C.freerdp_connect(instance)) {
		c.logSelectedProtocol(rctx, "rdpgfx compatibility retry succeeded")
		c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseConnected, Message: "connected with rdpgfx compatibility profile"}})
		return true
	}

	code := uint32(C.freerdp_get_last_error(rctx))
	raw := C.GoString(C.wErrorStr(rctx))
	requested := uint32(C.wGetRequestedProtocols(rctx))
	selected := uint32(C.wGetSelectedProtocol(rctx))
	c.logger.Error("rdpgfx compatibility retry failed",
		zap.Uint32("code", code),
		zap.String("raw", raw),
		zap.Uint32("requested_protocols_mask", requested),
		zap.Uint32("selected_protocol_mask", selected),
		zap.String("requested_protocols", protocolMaskString(requested)),
		zap.String("selected_protocol", selectedProtocolMaskString(selected, selected == 0)))
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
		Phase:   desktop.PhaseError,
		Message: humanizeConnectErrorWithNego(code, raw, requested, selected),
		Code:    code,
	}})
	return false
}

func (c *Client) tryFirstFrameStallSafeGraphics(ctx context.Context, elapsed time.Duration) bool {
	if ctx.Err() != nil || c.instance == nil || c.firstFrameLogged.Load() || c.safeGraphicsFallbackTried || c.safeGraphicsProfile {
		return false
	}
	c.safeGraphicsFallbackTried = true
	c.logger.Warn("rdpgfx negotiated but produced no desktop surfaces; retrying with safe graphics profile",
		zap.Duration("elapsed", elapsed),
		zap.Uint64("rdpgfx_on_open", c.rdpgfxOnOpen.Load()),
		zap.Uint64("rdpgfx_caps_confirm", c.rdpgfxCapsConfirm.Load()),
		zap.Uint32("rdpgfx_caps_version", c.rdpgfxCapsVersion.Load()),
		zap.Uint32("rdpgfx_caps_flags", c.rdpgfxCapsFlags.Load()),
		zap.Uint64("rdpgfx_reset_graphics", c.rdpgfxResetGraphics.Load()),
		zap.Uint64("rdpgfx_start_frames", c.rdpgfxStartFrames.Load()),
		zap.Uint64("rdpgfx_end_frames", c.rdpgfxEndFrames.Load()),
		zap.Uint64("rdpgfx_frame_acks", c.rdpgfxFrameAcks.Load()))
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseReconnecting, Message: "retrying safe graphics profile after rdpgfx stall"}})

	c.tearDownInstanceQuietly()
	c.resetFirstFrameDiagnostics()
	c.gfxCompatProfile = false
	c.safeGraphicsProfile = true
	if err := c.bringUpInstance(); err != nil {
		c.logger.Error("rdpgfx stall safe graphics retry failed to rebuild FreeRDP instance", zap.Error(err))
		c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
			Phase:   desktop.PhaseError,
			Message: "RDPGFX stall fallback 实例重建失败: " + err.Error(),
		}})
		return false
	}

	instance := (*C.freerdp)(c.instance)
	rctx := (*C.rdpContext)(c.context)
	if goBool(C.freerdp_connect(instance)) {
		c.logSelectedProtocol(rctx, "rdpgfx stall retry with safe graphics succeeded")
		c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseConnected, Message: "connected with safe graphics after rdpgfx stall"}})
		return true
	}

	code := uint32(C.freerdp_get_last_error(rctx))
	raw := C.GoString(C.wErrorStr(rctx))
	requested := uint32(C.wGetRequestedProtocols(rctx))
	selected := uint32(C.wGetSelectedProtocol(rctx))
	c.logger.Error("rdpgfx stall retry with safe graphics failed",
		zap.Uint32("code", code),
		zap.String("raw", raw),
		zap.Uint32("requested_protocols_mask", requested),
		zap.Uint32("selected_protocol_mask", selected),
		zap.String("requested_protocols", protocolMaskString(requested)),
		zap.String("selected_protocol", selectedProtocolMaskString(selected, selected == 0)))
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
		Phase:   desktop.PhaseError,
		Message: humanizeConnectErrorWithNego(code, raw, requested, selected),
		Code:    code,
	}})
	return false
}

func (c *Client) tryAutoReconnect(ctx context.Context, rctx *C.rdpContext) bool {
	if ctx.Err() != nil || c.instance == nil {
		return false
	}
	instance := (*C.freerdp)(c.instance)
	if !c.firstFrameLogged.Load() {
		c.logger.Warn("freerdp transport dropped before first frame; not auto-reconnecting setup failure")
		return false
	}
	if !c.claimReconnectAttempt() {
		c.logger.Warn("freerdp auto-reconnect suppressed after repeated immediate drops",
			zap.Int("burst_attempts", c.reconnectBurst),
			zap.Duration("burst_window", time.Since(c.reconnectBurstStart)))
		return false
	}
	code := uint32(C.freerdp_get_last_error(rctx))
	raw := C.GoString(C.wErrorStr(rctx))
	requested := uint32(C.wGetRequestedProtocols(rctx))
	selected := uint32(C.wGetSelectedProtocol(rctx))
	errorInfo := uint32(C.freerdp_error_info(instance))
	disconnectUltimatum := int(C.freerdp_get_disconnect_ultimatum(rctx))
	c.logger.Warn("freerdp transport dropped; attempting FreeRDP auto-reconnect",
		zap.Uint32("code", code),
		zap.String("raw", raw),
		zap.Int("burst_attempt", c.reconnectBurst),
		zap.Uint32("error_info", errorInfo),
		zap.Int("disconnect_ultimatum", disconnectUltimatum),
		zap.Uint32("requested_protocols_mask", requested),
		zap.Uint32("selected_protocol_mask", selected),
		zap.String("requested_protocols", protocolMaskString(requested)),
		zap.String("selected_protocol", selectedProtocolMaskString(selected, false)))
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseReconnecting}})
	if !goBool(C.client_auto_reconnect(instance)) {
		return false
	}
	c.logSelectedProtocol((*C.rdpContext)(c.context), "freerdp auto-reconnect succeeded")
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseConnected, Message: "reconnected"}})
	return true
}

func (c *Client) claimReconnectAttempt() bool {
	const maxReconnectBurst = 3
	const reconnectStormWindow = 10 * time.Second

	now := time.Now()
	if c.reconnectBurstStart.IsZero() || now.Sub(c.reconnectBurstStart) > reconnectStormWindow {
		c.reconnectBurstStart = now
		c.reconnectBurst = 0
	}
	c.reconnectBurst++
	return c.reconnectBurst <= maxReconnectBurst
}

// connectWithAutoNlaRetry calls freerdp_connect once with the operator's
// chosen security mode and, on a specific failure signature, transparently
// rebuilds the instance with NLA forced on and retries once. Returns true
// on success.
//
// The retry only fires when:
//   - code == ERRCONNECT_SECURITY_NEGO_CONNECT_FAILED (0x0002000C)
//   - selected_protocol mask == 0 (server rejected every protocol we offered)
//   - we did NOT already offer HYBRID / HYBRID_EX (i.e. NLA wasn't in the set)
//   - the operator's chosen mode wasn't already "any" (so we have somewhere
//     to escalate to)
//
// This mirrors what mstsc.exe does internally when HYBRID_REQUIRED_BY_SERVER
// is signalled in the X.224 negResponse: the client gives up on its
// preferred mode and falls back to the server's demand. Without the retry
// we leave the operator stuck on a confusing 0x0002000C even though the
// connection would succeed two seconds later if we just offered NLA.
func (c *Client) connectWithAutoNlaRetry() bool {
	instance := (*C.freerdp)(c.instance)
	rctx := (*C.rdpContext)(c.context)

	if goBool(C.freerdp_connect(instance)) {
		c.logSelectedProtocol(rctx, "freerdp_connect succeeded")
		return true
	}

	code := uint32(C.freerdp_get_last_error(rctx))
	raw := C.GoString(C.wErrorStr(rctx))
	requested := uint32(C.wGetRequestedProtocols(rctx))
	selected := uint32(C.wGetSelectedProtocol(rctx))
	c.logger.Error("freerdp_connect failed",
		zap.Uint32("code", code),
		zap.String("raw", raw),
		zap.Uint32("requested_protocols_mask", requested),
		zap.Uint32("selected_protocol_mask", selected),
		zap.String("requested_protocols", protocolMaskString(requested)),
		zap.String("selected_protocol", selectedProtocolMaskString(selected, selected == 0)))

	if shouldAutoRetryWithNla(code, requested, selected) && c.params.RDP.Security != desktop.SecAny && c.params.RDP.Security != "" {
		c.logger.Warn("server rejected our security set — auto-retry with security=any (NLA enabled)",
			zap.String("original_security", string(c.params.RDP.Security)),
			zap.String("requested_protocols", protocolMaskString(requested)))

		c.tearDownInstanceQuietly()
		c.params.RDP.Security = desktop.SecAny
		if err := c.bringUpInstance(); err != nil {
			c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
				Phase:   desktop.PhaseError,
				Message: "auto-retry 实例重建失败: " + err.Error(),
				Code:    code,
			}})
			return false
		}
		instance = (*C.freerdp)(c.instance)
		rctx = (*C.rdpContext)(c.context)
		if goBool(C.freerdp_connect(instance)) {
			c.logSelectedProtocol(rctx, "auto-retry with NLA succeeded")
			return true
		}
		// Second attempt also failed — pull updated state for the user
		// visible error.
		code = uint32(C.freerdp_get_last_error(rctx))
		raw = C.GoString(C.wErrorStr(rctx))
		requested = uint32(C.wGetRequestedProtocols(rctx))
		selected = uint32(C.wGetSelectedProtocol(rctx))
		c.logger.Error("auto-retry with NLA also failed",
			zap.Uint32("code", code),
			zap.String("raw", raw),
			zap.Uint32("requested_protocols_mask", requested),
			zap.Uint32("selected_protocol_mask", selected))
	}

	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
		Phase:   desktop.PhaseError,
		Message: humanizeConnectErrorWithNego(code, raw, requested, selected),
		Code:    code,
	}})
	return false
}

// logSelectedProtocol emits an INFO line carrying which X.224 protocol the
// server actually picked. Called from both the first-attempt and
// auto-retry success paths so the gateway log shows the server's choice
// regardless of which attempt won. Failure paths already log
// requested/selected via the explicit zap.Error block in
// connectWithAutoNlaRetry.
func (c *Client) logSelectedProtocol(rctx *C.rdpContext, message string) {
	requested := uint32(C.wGetRequestedProtocols(rctx))
	selected := uint32(C.wGetSelectedProtocol(rctx))
	c.logger.Info(message,
		zap.Uint32("requested_protocols_mask", requested),
		zap.Uint32("selected_protocol_mask", selected),
		zap.String("requested_protocols", protocolMaskString(requested)),
		zap.String("selected_protocol", protocolMaskString(selected)))
}

// shouldAutoRetryWithNla decides whether the failure signature from
// freerdp_connect matches the "server demanded HYBRID but we didn't offer
// it" pattern. Kept as a free function so a future test can exercise it
// without a live worker.
func shouldAutoRetryWithNla(code, requested, selected uint32) bool {
	const errSecNego = 0x0002000C
	const protoHybrid = 0x00000002   // PROTOCOL_HYBRID  (NLA / CredSSP)
	const protoHybridEx = 0x00000008 // PROTOCOL_HYBRID_EX (NLA-EX, Win10+)
	if code != errSecNego {
		return false
	}
	if selected != 0 {
		// Server picked one of our protocols — failure is not "rejected
		// the whole set"; auto-retry won't help.
		return false
	}
	if requested&(protoHybrid|protoHybridEx) != 0 {
		// We already offered NLA; the server is rejecting it for a
		// reason that retrying won't fix (creds, lockout, etc.).
		return false
	}
	return true
}

func (c *Client) teardown() {
	c.closeFrameEncoder()
	c.teardownVideo()
	if c.instance == nil {
		return
	}
	instance := (*C.freerdp)(c.instance)
	C.freerdp_disconnect(instance)
	C.freerdp_context_free(instance)
	C.freerdp_free(instance)
	registry.remove(c.context)
	c.clearChannelState()
	c.instance = nil
	c.context = nil
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseClosed}})
}

// bringUpInstance allocates a fresh freerdp instance + context, wires the
// instance/channel callbacks, then applies the current params/settings.
// Used by Start() on first attempt and by the auto-NLA-retry path in
// runLoop when the server rejected the original security set.
func (c *Client) bringUpInstance() error {
	C.wRegisterStaticAddins()
	instance := C.freerdp_new()
	if instance == nil {
		return errors.New("freerdp_new failed")
	}
	C.wInstallInstanceCallbacks(instance)
	if !goBool(C.freerdp_context_new(instance)) {
		C.freerdp_free(instance)
		return errors.New("freerdp_context_new failed")
	}
	rctx := instance.context
	c.instance = unsafe.Pointer(instance)
	c.context = unsafe.Pointer(rctx)
	registry.put(unsafe.Pointer(rctx), c)
	C.wRegisterChannelPubSub(rctx)
	if err := c.applySettings(); err != nil {
		C.freerdp_context_free(instance)
		C.freerdp_free(instance)
		registry.remove(c.context)
		c.instance = nil
		c.context = nil
		return fmt.Errorf("settings: %w", err)
	}
	return nil
}

// tearDownInstanceQuietly releases the current freerdp instance without
// emitting PhaseClosed — used by the auto-retry path so the browser keeps
// seeing PhaseConnecting between the failed first attempt and the second
// attempt.
func (c *Client) tearDownInstanceQuietly() {
	if c.instance == nil {
		return
	}
	instance := (*C.freerdp)(c.instance)
	C.freerdp_disconnect(instance)
	C.freerdp_context_free(instance)
	C.freerdp_free(instance)
	registry.remove(c.context)
	c.clearChannelState()
	c.instance = nil
	c.context = nil
}

func (c *Client) clearChannelState() {
	c.cliprdr = nil
	c.rdpsnd = nil
	c.rdpgfx = nil
	c.rdpgfxGDIInitialized.Store(false)
	c.rdpgfxMu.Lock()
	c.rdpgfxSurfaces = nil
	c.rdpgfxMu.Unlock()
	c.cliprdrCapsSent.Store(false)
	c.cliprdrFormatListSent.Store(false)
}

func (c *Client) resetFirstFrameDiagnostics() {
	c.firstFrameLogged.Store(false)
	c.frameResyncPending.Store(false)
	c.beginPaints.Store(0)
	c.endPaints.Store(0)
	c.bitmapUpdates.Store(0)
	c.surfaceBits.Store(0)
	c.desktopResizes.Store(0)
	c.paintRegions.Store(0)
	c.emptyPaints.Store(0)
	c.refreshRequests.Store(0)
	c.refreshFailures.Store(0)
	c.saveSessionInfos.Store(0)
	c.rdpgfxGDIInitialized.Store(false)
	c.rdpgfxResetGraphics.Store(0)
	c.rdpgfxOnOpen.Store(0)
	c.rdpgfxOnClose.Store(0)
	c.rdpgfxCapsAdvertise.Store(0)
	c.rdpgfxCapsConfirm.Store(0)
	c.rdpgfxCapsVersion.Store(0)
	c.rdpgfxCapsFlags.Store(0)
	c.rdpgfxSurfaceCommands.Store(0)
	c.rdpgfxCreateSurfaces.Store(0)
	c.rdpgfxDeleteSurfaces.Store(0)
	c.rdpgfxMapOutput.Store(0)
	c.rdpgfxMapScaledOutput.Store(0)
	c.rdpgfxSolidFills.Store(0)
	c.rdpgfxSurfaceToSurface.Store(0)
	c.rdpgfxSurfaceToCache.Store(0)
	c.rdpgfxCacheToSurface.Store(0)
	c.rdpgfxEvictCache.Store(0)
	c.rdpgfxStartFrames.Store(0)
	c.rdpgfxEndFrames.Store(0)
	c.rdpgfxEndFrameSeqBase.Store(0)
	c.rdpgfxEndFrameCmdBase.Store(0)
	c.rdpgfxUpdateSurfaces.Store(0)
	c.rdpgfxUpdateSurfaceAreas.Store(0)
	c.rdpgfxFrameAcks.Store(0)
	c.rdpgfxOriginalErrors.Store(0)
	c.rdpgfxOriginalSurfaceCommandErrors.Store(0)
	c.rdpgfxOriginalCreateSurfaceErrors.Store(0)
	c.rdpgfxOriginalUpdateSurfacesErrors.Store(0)
	c.logonSuccessSeen.Store(false)
	c.logonErrorSeen.Store(false)
	c.logonErrorData.Store(0)
	c.logonErrorType.Store(0)
	c.logonErrorAtUnixNano.Store(0)
	c.logonErrorClosed.Store(false)
	c.rdpgfxMu.Lock()
	c.rdpgfxSurfaces = nil
	c.rdpgfxMu.Unlock()
}

// emit posts to out without blocking; FreeRDP callbacks run on the protocol
// event loop and must never wait for the gateway or browser to catch up.
func (c *Client) emit(m desktop.ServerMessage) {
	select {
	case c.out <- m:
		if n := serverMessageFrameCount(m); n > 0 {
			c.framesEmitted.Add(n)
		}
	default:
		if n := serverMessageFrameCount(m); n > 0 {
			dropped := c.framesDropped.Add(n)
			c.requestFrameResync()
			c.logEmitDrop(dropped)
			return
		}
	}
}

func serverMessageFrameCount(m desktop.ServerMessage) uint64 {
	if m.Frame != nil {
		return 1
	}
	if m.FrameBatch != nil {
		return uint64(len(m.FrameBatch.Frames))
	}
	return 0
}

func (c *Client) requestFrameResync() {
	c.frameResyncPending.Store(true)
}

func (c *Client) logEmitDrop(totalDropped uint64) {
	now := time.Now().UnixNano()
	last := c.emitDropLastLogNano.Load()
	if last != 0 && time.Duration(now-last) < time.Second {
		c.emitDropSuppressed.Add(1)
		return
	}
	if !c.emitDropLastLogNano.CompareAndSwap(last, now) {
		c.emitDropSuppressed.Add(1)
		return
	}
	suppressed := c.emitDropSuppressed.Swap(0)
	c.logger.Warn("desktop frame dropped; scheduling resync",
		zap.Uint64("total_dropped", totalDropped),
		zap.Uint64("suppressed", suppressed),
		zap.Int("queue_len", len(c.out)),
		zap.Int("queue_cap", cap(c.out)))
}

func (c *Client) emitFrameStats() {
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
		Phase: desktop.PhaseConnected,
		Message: fmt.Sprintf(
			"frames=%d dropped=%d resyncs=%d enc_raw=%d enc_jpeg=%d enc_zlib=%d enc_fallback=%d enc_in=%d enc_out=%d gfx_cmds=%d gfx_frames=%d gfx_updates=%d",
			c.framesEmitted.Load(),
			c.framesDropped.Load(),
			c.frameResyncs.Load(),
			c.framesEncodedRaw.Load(),
			c.framesEncodedJPEG.Load(),
			c.framesEncodedZlib.Load(),
			c.framesEncodeFallback.Load(),
			c.frameEncodeInBytes.Load(),
			c.frameEncodeOutBytes.Load(),
			c.rdpgfxSurfaceCommands.Load(),
			c.rdpgfxEndFrames.Load(),
			c.rdpgfxUpdateSurfaces.Load(),
		),
	}})
}

func (c *Client) sendFocusIn(reason string) {
	if c.context == nil {
		return
	}
	rctx := (*C.rdpContext)(c.context)
	if !goBool(C.wSendFocusIn(rctx)) {
		c.logger.Warn("freerdp focus-in event failed", zap.String("reason", reason))
		return
	}
	c.logger.Info("freerdp focus-in event sent", zap.String("reason", reason))
}

func (c *Client) sendPendingFocusIn() {
	if c.instance == nil {
		return
	}
	rc := int(C.wSendPendingFocusIn((*C.freerdp)(c.instance)))
	switch rc {
	case 1:
		c.logger.Info("freerdp pending focus-in events sent")
	case -1:
		c.logger.Warn("freerdp pending focus-in events failed")
	}
}

func (c *Client) requestDesktopRefresh(reason string) {
	if c.context == nil || c.width == 0 || c.height == 0 {
		return
	}
	c.refreshRequests.Add(1)
	rctx := (*C.rdpContext)(c.context)
	width := C.UINT16(c.width)
	height := C.UINT16(c.height)
	gdiSuppressedBefore := false
	if rctx.gdi != nil {
		gdiSuppressedBefore = goBool(rctx.gdi.suppressOutput)
	}
	allowOK := goBool(C.wSendSuppressOutputAllow(rctx, width, height))
	gdiSuppressedAfter := false
	if rctx.gdi != nil {
		gdiSuppressedAfter = goBool(rctx.gdi.suppressOutput)
	}
	refreshOK := goBool(C.wSendDesktopRefreshRect(rctx, width, height))
	fields := []zap.Field{
		zap.String("reason", reason),
		zap.Uint32("width", c.width),
		zap.Uint32("height", c.height),
		zap.Bool("gdi_suppress_output_before", gdiSuppressedBefore),
		zap.Bool("gdi_suppress_output_after", gdiSuppressedAfter),
		zap.Bool("suppress_output_allow_ok", allowOK),
		zap.Bool("refresh_rect_ok", refreshOK),
		zap.Uint64("request_count", c.refreshRequests.Load()),
	}
	if !allowOK || !refreshOK {
		failureCount := c.refreshFailures.Add(1)
		fields = append(fields, zap.Uint64("failure_count", failureCount))
		if failureCount == 1 || reason != "no first frame diagnostic" {
			c.logger.Warn("freerdp desktop refresh request failed", fields...)
		}
		return
	}
	c.logger.Info("freerdp desktop refresh requested", fields...)
}

func (c *Client) recordLogonError(data, typ uint32) {
	c.logonErrorData.Store(data)
	c.logonErrorType.Store(typ)
	c.logonErrorAtUnixNano.Store(time.Now().UnixNano())
	c.logonErrorSeen.Store(true)
}

func (c *Client) logFirstFrameWait(elapsed time.Duration) {
	logonErrorSeen := c.logonErrorSeen.Load()
	logonErrorData := c.logonErrorData.Load()
	logonErrorType := c.logonErrorType.Load()
	c.logger.Warn("freerdp connected but no decoded frame yet",
		zap.Duration("elapsed", elapsed),
		zap.Uint32("width", c.width),
		zap.Uint32("height", c.height),
		zap.Bool("safe_profile", c.safeGraphicsProfile),
		zap.Uint64("bitmap_updates", c.bitmapUpdates.Load()),
		zap.Uint64("surface_bits", c.surfaceBits.Load()),
		zap.Uint64("begin_paints", c.beginPaints.Load()),
		zap.Uint64("end_paints", c.endPaints.Load()),
		zap.Uint64("desktop_resizes", c.desktopResizes.Load()),
		zap.Uint64("paint_regions", c.paintRegions.Load()),
		zap.Uint64("empty_paints", c.emptyPaints.Load()),
		zap.Uint64("frames", c.framesEmitted.Load()),
		zap.Uint64("dropped", c.framesDropped.Load()),
		zap.Uint64("encode_queued", c.framesEncodeQueued.Load()),
		zap.Uint64("encode_fallback", c.framesEncodeFallback.Load()),
		zap.Uint64("encoded_raw", c.framesEncodedRaw.Load()),
		zap.Uint64("encoded_jpeg", c.framesEncodedJPEG.Load()),
		zap.Uint64("encoded_zlib", c.framesEncodedZlib.Load()),
		zap.Uint64("frame_resyncs", c.frameResyncs.Load()),
		zap.Uint64("refresh_requests", c.refreshRequests.Load()),
		zap.Uint64("refresh_failures", c.refreshFailures.Load()),
		zap.Uint64("save_session_infos", c.saveSessionInfos.Load()),
		zap.Bool("rdpgfx_gdi_initialized", c.rdpgfxGDIInitialized.Load()),
		zap.Uint64("rdpgfx_on_open", c.rdpgfxOnOpen.Load()),
		zap.Uint64("rdpgfx_on_close", c.rdpgfxOnClose.Load()),
		zap.Uint64("rdpgfx_caps_advertise", c.rdpgfxCapsAdvertise.Load()),
		zap.Uint64("rdpgfx_caps_confirm", c.rdpgfxCapsConfirm.Load()),
		zap.Uint32("rdpgfx_caps_version", c.rdpgfxCapsVersion.Load()),
		zap.Uint32("rdpgfx_caps_flags", c.rdpgfxCapsFlags.Load()),
		zap.Uint64("rdpgfx_reset_graphics", c.rdpgfxResetGraphics.Load()),
		zap.Uint64("rdpgfx_surface_commands", c.rdpgfxSurfaceCommands.Load()),
		zap.Uint64("rdpgfx_create_surfaces", c.rdpgfxCreateSurfaces.Load()),
		zap.Uint64("rdpgfx_delete_surfaces", c.rdpgfxDeleteSurfaces.Load()),
		zap.Uint64("rdpgfx_map_output", c.rdpgfxMapOutput.Load()),
		zap.Uint64("rdpgfx_map_scaled_output", c.rdpgfxMapScaledOutput.Load()),
		zap.Uint64("rdpgfx_start_frames", c.rdpgfxStartFrames.Load()),
		zap.Uint64("rdpgfx_end_frames", c.rdpgfxEndFrames.Load()),
		zap.Uint64("rdpgfx_frame_acks", c.rdpgfxFrameAcks.Load()),
		zap.Uint64("rdpgfx_update_surfaces", c.rdpgfxUpdateSurfaces.Load()),
		zap.Uint64("rdpgfx_update_surface_areas", c.rdpgfxUpdateSurfaceAreas.Load()),
		// Phase 9 — libfreerdp original-handler error counters. Non-
		// zero rdpgfx_original_surface_command_errors with non-zero
		// rdpgfx_surface_commands means the browser is decoding fine
		// while libfreerdp's local decoder is silently failing (most
		// likely the experimental WITH_VAAPI_H264_ENCODING build
		// missing a working client-side AVC decoder).
		zap.Uint64("rdpgfx_original_errors", c.rdpgfxOriginalErrors.Load()),
		zap.Uint64("rdpgfx_original_surface_command_errors", c.rdpgfxOriginalSurfaceCommandErrors.Load()),
		zap.Uint64("rdpgfx_original_create_surface_errors", c.rdpgfxOriginalCreateSurfaceErrors.Load()),
		zap.Uint64("rdpgfx_original_update_surfaces_errors", c.rdpgfxOriginalUpdateSurfacesErrors.Load()),
		zap.Bool("logon_success_seen", c.logonSuccessSeen.Load()),
		zap.Bool("logon_error_seen", logonErrorSeen),
		zap.Uint32("logon_error_data", logonErrorData),
		zap.String("logon_error_data_text", logonErrorDataText(logonErrorData)),
		zap.Uint32("logon_error_type", logonErrorType),
		zap.String("logon_error_type_text", logonErrorTypeText(logonErrorType)))
	c.surfaceLogonFailureIfStalled()
}

func (c *Client) surfaceLogonFailureIfStalled() {
	if !c.logonErrorSeen.Load() || c.logonSuccessSeen.Load() || c.logonErrorClosed.Load() {
		return
	}
	if at := c.logonErrorAtUnixNano.Load(); at > 0 && time.Since(time.Unix(0, at)) < 15*time.Second {
		return
	}
	if !c.logonErrorClosed.CompareAndSwap(false, true) {
		return
	}
	data := c.logonErrorData.Load()
	typ := c.logonErrorType.Load()
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
		Phase: desktop.PhaseError,
		Message: fmt.Sprintf(
			"RDP logon did not reach a desktop before the first frame: %s / %s",
			logonErrorDataText(data),
			logonErrorTypeText(typ),
		),
		Code: data,
	}})
}

func logonErrorDataText(data uint32) string {
	switch data {
	case 0x00000000:
		return "LOGON_FAILED_BAD_PASSWORD"
	case 0x00000001:
		return "LOGON_FAILED_UPDATE_PASSWORD"
	case 0x00000002:
		return "LOGON_FAILED_OTHER"
	case 0x00000003:
		return "LOGON_WARNING"
	default:
		return "UNKNOWN"
	}
}

func logonErrorTypeText(typ uint32) string {
	switch typ {
	case 0xFFFFFFF8:
		return "LOGON_MSG_SESSION_BUSY_OPTIONS"
	case 0xFFFFFFF9:
		return "LOGON_MSG_DISCONNECT_REFUSED"
	case 0xFFFFFFFA:
		return "LOGON_MSG_NO_PERMISSION"
	case 0xFFFFFFFB:
		return "LOGON_MSG_BUMP_OPTIONS"
	case 0xFFFFFFFC:
		return "LOGON_MSG_RECONNECT_OPTIONS"
	case 0xFFFFFFFD:
		return "LOGON_MSG_SESSION_TERMINATE"
	case 0xFFFFFFFE:
		return "LOGON_MSG_SESSION_CONTINUE"
	case 0xFFFFFFFF:
		return "ERROR_CODE_ACCESS_DENIED"
	default:
		return "UNKNOWN"
	}
}

func sessionInfoTypeText(typ uint32) string {
	switch typ {
	case 0x00000000:
		return "INFO_TYPE_LOGON"
	case 0x00000001:
		return "INFO_TYPE_LOGON_LONG"
	case 0x00000002:
		return "INFO_TYPE_LOGON_PLAIN_NOTIFY"
	case 0x00000003:
		return "INFO_TYPE_LOGON_EXTENDED_INF"
	default:
		return "UNKNOWN"
	}
}

// goBool helper.
func goBool(b C.BOOL) bool { return b != 0 }
