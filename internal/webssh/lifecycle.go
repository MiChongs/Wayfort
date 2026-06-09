package webssh

import (
	"context"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// This file holds the lifecycle-v3 plumbing shared across every protocol that
// runs through the gateway: per-stage phase recording, the connection-quality
// metric sink, and the teardown rollup. Both the SSH/anon main path
// (gateway.go) and the sibling-protocol path (exposed.go BeginSession) reuse it.

// OpenPhase starts a lifecycle stage for a session: it appends a `running`
// phase row, points sessions.current_phase at it, drops a session.phase
// breadcrumb into the audit stream, and (for the ready stage) stamps ready_at.
// The returned closer ends the phase with an outcome; calling it more than once
// is safe (only the first call takes effect). A failed close also emits an
// abnormal session.phase row so the "仅异常" filter surfaces broken connects.
//
// Public so sibling protocol packages (dbcli, guacamole) can instrument their
// own connect path; telnet (same package) uses it directly.
func (g *Gateway) OpenPhase(sessionID string, phase model.SessionPhaseKind, claims *auth.Claims, clientIP string, nodeID *uint64) func(model.PhaseStatus, string) {
	start := nowFunc()
	ctx := context.Background()
	_ = g.sessions.AppendPhase(ctx, &model.SessionPhase{
		SessionID: sessionID, Phase: phase, Status: model.PhaseRunning, StartedAt: start,
	})
	_ = g.sessions.UpdateCurrentPhase(ctx, sessionID, phase)
	if phase == model.PhaseReady {
		_ = g.sessions.SetReadyAt(ctx, sessionID, start)
	}
	g.audit.Log(model.AuditLog{
		Kind: model.AuditSessionPhase, UserID: claims.UserID, Username: claims.Username,
		SessionID: sessionID, NodeID: nodeID, ClientIP: clientIP,
		Payload: "phase=" + string(phase),
	})
	var once sync.Once
	return func(status model.PhaseStatus, detail string) {
		once.Do(func() {
			end := nowFunc()
			_ = g.sessions.ClosePhase(ctx, sessionID, phase, status, detail, end)
			if status == model.PhaseFailed {
				payload := "phase=" + string(phase) + " " + model.PhaseFailedMarker
				if detail != "" {
					payload += " " + truncate(detail, 200)
				}
				g.audit.Log(model.AuditLog{
					Kind: model.AuditSessionPhase, UserID: claims.UserID, Username: claims.Username,
					SessionID: sessionID, NodeID: nodeID, ClientIP: clientIP, Payload: payload,
				})
			}
		})
	}
}

// MetricSink returns a per-session connection-quality sampler bound to the
// gateway's metric queue. Nil-safe: a no-op sink when metrics are unwired.
func (g *Gateway) MetricSink(sessionID string) *audit.MetricSink {
	return g.metrics.Sink(sessionID)
}

// finalizeLifecycle closes any still-running phase, backfills the RTT/reconnect
// rollups onto the in-memory row from the recorded samples, and marks the
// session closed. Shared by recordEnd (SSH/anon) and EndSession (siblings); the
// caller persists the row via a partial Finish update afterwards.
func (g *Gateway) finalizeLifecycle(row *model.Session) {
	ctx := context.Background()
	if peak, avg, recon, err := g.sessions.MetricSummary(ctx, row.ID); err == nil {
		row.PeakRTTMs, row.AvgRTTMs, row.ReconnectCount = peak, avg, recon
	}
	row.CurrentPhase = model.PhaseClosed
	_ = g.sessions.ClosePhaseAny(ctx, row.ID, model.PhaseSucceeded, time.Now())
}
