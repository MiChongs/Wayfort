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
// Channels (CLIPRDR / RDPSND / RDPGFX / RDPDR) are subscribed in
// channels.go. They emit ServerMessage events through the same `out`
// channel as the surface pipeline.

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
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/michongs/jumpserver-anonymous/internal/desktop"
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

	// Pointer state: the last cursor BGRA hash so we can dedup repeats.
	lastCursorHash uint64

	// Input state.
	mu              sync.Mutex
	pendingClipText []byte
	prevButtons     uint32
}

// NewClient — libfreerdp-backed worker. Call Start to actually connect.
func NewClient(logger *zap.Logger) desktop.DesktopWorker {
	return &Client{
		logger: logger,
		out:    make(chan desktop.ServerMessage, 128),
		in:     make(chan desktop.ClientMessage, 256),
		done:   make(chan struct{}),
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

	// Plan 17 M2 enables RemoteFX + GFX + H.264 so the modern codecs come
	// into play; CLIPRDR/RDPSND/RDPGFX/RDPDR channels are loaded later in
	// goPreConnect.
	if err := c.bringUpInstance(); err != nil {
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
		zap.Uint32("height", c.height))

	// Spawn the event loop and the input pump.
	runCtx, cancel := context.WithCancel(ctx)
	c.cancel = cancel
	go c.runLoop(runCtx)
	go c.inputPump(runCtx)
	return nil
}

func (c *Client) applySettings() error {
	rctx := (*C.rdpContext)(c.context)
	s := C.wContextSettings(rctx)
	host := C.CString(c.params.Host)
	defer C.free(unsafe.Pointer(host))
	user := C.CString(c.params.Username)
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
	if c.params.Domain != "" {
		dom := C.CString(c.params.Domain)
		defer C.free(unsafe.Pointer(dom))
		C.freerdp_settings_set_string(s, C.FreeRDP_Domain, dom)
	}
	C.freerdp_settings_set_uint32(s, C.FreeRDP_DesktopWidth, C.UINT32(c.width))
	C.freerdp_settings_set_uint32(s, C.FreeRDP_DesktopHeight, C.UINT32(c.height))

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

	// EarlyCapabilityFlags:
	//   0x0001 RNS_UD_CS_SUPPORT_ERRINFO_PDU
	//   0x0020 RNS_UD_CS_VALID_CONNECTION_TYPE   (must accompany ConnectionType)
	//   0x0080 RNS_UD_CS_SUPPORT_STATUSINFO_PDU
	//   0x0200 RNS_UD_CS_SUPPORT_DYNVC_GFX_PROTOCOL
	C.freerdp_settings_set_uint32(s, C.FreeRDP_EarlyCapabilityFlags, 0x0001|0x0020|0x0080|0x0200)

	// ConnectionType = CONNECTION_TYPE_BROADBAND_LOW (2). Tunnelled
	// gateway → RDS link is RTT-bounded, not LAN.
	C.freerdp_settings_set_uint32(s, C.FreeRDP_ConnectionType, 2)

	// Multitransport / network autodetect / batched channel join: off.
	// The gateway has no UDP sidechannel, some Server 2022 builds
	// deadlock on the network autodetect PDU, and RDP 8.1's batched
	// channel-join sequence is rejected by older RDS we still target.
	C.freerdp_settings_set_bool(s, C.FreeRDP_SupportMultitransport, C.FALSE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_NetworkAutoDetect, C.FALSE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_SupportSkipChannelJoin, C.FALSE)

	opts := c.params.RDP

	// Color depth — operator can drop to 16/24 for bandwidth-constrained
	// links. Default 32 keeps full RGB+alpha for modern Windows visuals.
	colorDepth := uint8(32)
	if opts.ColorDepth != nil && (*opts.ColorDepth == 16 || *opts.ColorDepth == 24 || *opts.ColorDepth == 32) {
		colorDepth = *opts.ColorDepth
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

	C.freerdp_settings_set_bool(s, C.FreeRDP_AutoReconnectionEnabled, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_BitmapCacheEnabled, C.TRUE)
	// FreeRDP 3.x typed OffscreenSupportLevel as UINT32 (a capability
	// level: 0 = unsupported, 1 = supported). The old set_bool call here
	// triggered "Invalid key index 2816 ... FREERDP_SETTINGS_TYPE_UINT32"
	// at runtime and the setting silently no-op'd, which broke the
	// MCS capability set the server sees during negotiation.
	C.freerdp_settings_set_uint32(s, C.FreeRDP_OffscreenSupportLevel, 1)
	C.freerdp_settings_set_bool(s, C.FreeRDP_FastPathInput, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_FastPathOutput, C.TRUE)

	// Codec / GFX toggles. Defaults match the previous hardcoded values
	// so existing nodes negotiate the same modern codecs.
	C.freerdp_settings_set_bool(s, C.FreeRDP_RemoteFxCodec, cBoolDefault(opts.EnableRemoteFx, true))
	C.freerdp_settings_set_bool(s, C.FreeRDP_NSCodec, cBoolDefault(opts.EnableNSCodec, true))
	C.freerdp_settings_set_bool(s, C.FreeRDP_GfxH264, cBoolDefault(opts.EnableH264, true))
	C.freerdp_settings_set_bool(s, C.FreeRDP_SupportGraphicsPipeline, cBoolDefault(opts.EnableGraphicsPipeline, true))

	// Performance vs. fidelity tradeoffs. All default false (i.e. keep
	// Windows visuals enabled), letting the operator switch them on to
	// reduce bandwidth on slow links.
	C.freerdp_settings_set_bool(s, C.FreeRDP_DisableWallpaper, cBoolDefault(opts.DisableWallpaper, false))
	C.freerdp_settings_set_bool(s, C.FreeRDP_DisableFullWindowDrag, cBoolDefault(opts.DisableFullWindowDrag, false))
	C.freerdp_settings_set_bool(s, C.FreeRDP_DisableMenuAnims, cBoolDefault(opts.DisableMenuAnims, false))
	C.freerdp_settings_set_bool(s, C.FreeRDP_DisableThemes, cBoolDefault(opts.DisableThemes, false))
	C.freerdp_settings_set_bool(s, C.FreeRDP_AllowFontSmoothing, cBoolDefault(opts.AllowFontSmoothing, true))
	C.freerdp_settings_set_bool(s, C.FreeRDP_AllowDesktopComposition, cBoolDefault(opts.AllowDesktopComposition, true))

	// Redirection toggles. Defaults preserve the previous hardcoded "on"
	// behavior for clipboard / audio / device redirection.
	C.freerdp_settings_set_bool(s, C.FreeRDP_RedirectClipboard, cBoolDefault(opts.RedirectClipboard, true))
	C.freerdp_settings_set_bool(s, C.FreeRDP_AudioPlayback, cBoolDefault(opts.AudioPlayback, true))
	C.freerdp_settings_set_bool(s, C.FreeRDP_DeviceRedirection, cBoolDefault(opts.DeviceRedirection, true))

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
		zap.Uint32("connection_type", 2))
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

// runLoop owns the libfreerdp event loop. Must run on a single OS thread
// because libfreerdp's GDI assumes the thread that opened the connection
// is the same one issuing draws.
func (c *Client) runLoop(ctx context.Context) {
	defer close(c.done)
	defer c.teardown()

	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseConnecting}})

	if !c.connectWithAutoNlaRetry() {
		return
	}
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseConnected}})

	rctx := (*C.rdpContext)(c.context)
	// 16 is enough for the typical channel set; bump if we observe handle
	// exhaustion in the wild.
	const maxHandles = 64
	var handles [maxHandles]C.HANDLE
	for {
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
		// noticing ctx cancellation.
		_ = C.WaitForMultipleObjects(count, &handles[0], C.FALSE, 100)
		if !goBool(C.freerdp_check_event_handles(rctx)) {
			if C.freerdp_get_last_error(rctx) != C.FREERDP_ERROR_SUCCESS {
				code := uint32(C.freerdp_get_last_error(rctx))
				raw := C.GoString(C.wErrorStr(rctx))
				c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
					Phase:   desktop.PhaseError,
					Message: humanizeConnectError(code, raw),
					Code:    code,
				}})
				return
			}
			// 0 with no error usually means clean disconnect requested.
			return
		}
	}
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
		zap.String("selected_protocol", protocolMaskString(selected)))

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
	const protoHybrid = 0x00000002    // PROTOCOL_HYBRID  (NLA / CredSSP)
	const protoHybridEx = 0x00000008  // PROTOCOL_HYBRID_EX (NLA-EX, Win10+)
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
	if c.instance == nil {
		return
	}
	instance := (*C.freerdp)(c.instance)
	C.freerdp_disconnect(instance)
	C.freerdp_context_free(instance)
	C.freerdp_free(instance)
	registry.remove(c.context)
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
	c.instance = nil
	c.context = nil
}

// emit posts to out without blocking for more than ~250ms; drops if the
// consumer has stalled (the gateway is supposed to drain promptly).
func (c *Client) emit(m desktop.ServerMessage) {
	select {
	case c.out <- m:
	case <-time.After(250 * time.Millisecond):
		c.logger.Warn("emit drop — out queue stuck")
	}
}

// goBool helper.
func goBool(b C.BOOL) bool { return b != 0 }
