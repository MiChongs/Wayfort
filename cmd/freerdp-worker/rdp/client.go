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
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
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

	// Bring up the freerdp instance + context.
	C.wRegisterStaticAddins()
	instance := C.freerdp_new()
	if instance == nil {
		return errors.New("freerdp_new failed")
	}
	c.instance = unsafe.Pointer(instance)
	C.wInstallInstanceCallbacks(instance)
	if !goBool(C.freerdp_context_new(instance)) {
		C.freerdp_free(instance)
		return errors.New("freerdp_context_new failed")
	}
	rctx := instance.context
	c.context = unsafe.Pointer(rctx)
	registry.put(unsafe.Pointer(rctx), c)
	C.wRegisterChannelPubSub(rctx)

	// Settings. Plan 17 M2 enables RemoteFX + GFX + H.264 so the modern
	// codecs come in to play; CLIPRDR/RDPSND/RDPGFX/RDPDR channels are
	// loaded later in goPreConnect.
	if err := c.applySettings(); err != nil {
		C.freerdp_context_free(instance)
		C.freerdp_free(instance)
		return fmt.Errorf("settings: %w", err)
	}

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
	C.freerdp_settings_set_uint32(s, C.FreeRDP_ColorDepth, 32)
	C.freerdp_settings_set_bool(s, C.FreeRDP_NlaSecurity, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_TlsSecurity, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_IgnoreCertificate, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_AutoReconnectionEnabled, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_BitmapCacheEnabled, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_OffscreenSupportLevel, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_RemoteFxCodec, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_NSCodec, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_GfxH264, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_SupportGraphicsPipeline, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_FastPathInput, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_FastPathOutput, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_RedirectClipboard, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_AudioPlayback, C.TRUE)
	C.freerdp_settings_set_bool(s, C.FreeRDP_DeviceRedirection, C.TRUE)
	if kbd := c.params.Keyboard; kbd != "" {
		// FreeRDP wants the layout via FreeRDP_KeyboardLayout numeric ID;
		// our string form is informational for now. M2.x maps strings to IDs.
		_ = kbd
	}
	return nil
}

// runLoop owns the libfreerdp event loop. Must run on a single OS thread
// because libfreerdp's GDI assumes the thread that opened the connection
// is the same one issuing draws.
func (c *Client) runLoop(ctx context.Context) {
	defer close(c.done)
	defer c.teardown()

	instance := (*C.freerdp)(c.instance)
	rctx := (*C.rdpContext)(c.context)

	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseConnecting}})

	if !goBool(C.freerdp_connect(instance)) {
		errStr := C.GoString(C.wErrorStr(rctx))
		c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
			Phase:   desktop.PhaseError,
			Message: errStr,
			Code:    uint32(C.freerdp_get_last_error(rctx)),
		}})
		return
	}
	c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{Phase: desktop.PhaseConnected}})

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
				c.emit(desktop.ServerMessage{Status: &desktop.SessionStatus{
					Phase:   desktop.PhaseError,
					Message: C.GoString(C.wErrorStr(rctx)),
					Code:    uint32(C.freerdp_get_last_error(rctx)),
				}})
				return
			}
			// 0 with no error usually means clean disconnect requested.
			return
		}
	}
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
