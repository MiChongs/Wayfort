package desktop

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/model"
)

// Session is one live desktop connection: a worker + bookkeeping. The
// gateway-side WS handler pulls one of these by ID and pumps frames
// between the browser and the worker.
type Session struct {
	ID        string
	Worker    DesktopWorker
	NodeID    uint64
	UserID    uint64
	Username  string
	ClientIP  string
	StartedAt time.Time
	// VideoMode is "vp8" when this session streams video over WebRTC (the WS
	// handler then stands up a Pion bridge and routes worker Video messages to
	// it). Empty / "bitmap" = legacy WS frame path. Set once at StartSession.
	VideoMode string
	// VideoBitrateKbps is the quality-tier bitrate the worker started with — it
	// doubles as the ABR ceiling the gateway's congestion controller climbs
	// toward. 0 on non-WebRTC sessions.
	VideoBitrateKbps int

	cancel     context.CancelFunc
	manager    *Manager
	sessionRow *model.Session
	// expiryStop stops the server-side approval-expiry watcher (renewal-aware
	// hard cutoff) when the session was authorised by a time-bound grant.
	// Called on teardown.
	expiryStop func()
	// socksClose tears down the per-session SOCKS5 proxy-chain listener (and
	// releases bastion refcounts) when the session ends. nil for direct-dial
	// sessions. Internally guarded so it is safe to call from every teardown
	// path (manager.End and the WS handler).
	socksClose func()

	// recorder tees the session's frame stream + input/event audit timeline to
	// a .dtr tape. nil when recording is disabled. Close is idempotent.
	recorder      *Recorder
	recordingPath string

	// Lifecycle-v3 telemetry. bytesIn/bytesOut accumulate the WS payload sizes
	// in each direction for the bandwidth curve; sink samples them on a cadence.
	// curPhase tracks the last model phase bridged from the worker's status
	// stream — read/written only on the single worker→browser goroutine and at
	// teardown (after that goroutine exits), so no extra lock is needed.
	bytesIn  atomic.Uint64
	bytesOut atomic.Uint64
	sink     *audit.MetricSink
	curPhase model.SessionPhaseKind

	closeOnce sync.Once

	// terminated marks an admin force-off so recordEnd stamps the row as
	// terminated rather than a clean close. Guarded by Manager.mu.
	terminated bool

	// attached is claimed by the WS handler so a second WebSocket for the
	// same session_id (a duplicated tab, or a reconnect racing the old
	// socket's teardown) is rejected instead of both attaching to the one
	// Worker.Recv() channel — which would split frames between them and
	// garble/blank both canvases, and let whichever exits first close the
	// shared worker out from under the other.
	attached atomic.Bool
}

// ClaimForWS atomically marks the session as owned by a live WebSocket.
// Returns false if another WS already holds it. ReleaseWS clears the claim.
func (s *Session) ClaimForWS() bool { return s.attached.CompareAndSwap(false, true) }
func (s *Session) ReleaseWS()       { s.attached.Store(false) }

// Cancel terminates the underlying worker and unregisters from the manager.
// Safe to call multiple times.
func (s *Session) Cancel() {
	s.closeOnce.Do(func() {
		if s.manager != nil {
			_ = s.manager.End(context.Background(), s.ID)
		}
	})
}
