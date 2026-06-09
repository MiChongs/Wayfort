package desktop

import (
	"context"
	"fmt"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// This file holds the lifecycle-v3 plumbing for desktop sessions: bridging the
// worker's connection-status stream into the shared session_phases timeline,
// lifting high-value graphical interactions (clipboard / file / resize) out of
// the binary .dtr tape into the searchable audit log, and the teardown rollup.

// modelPhaseFor maps the worker's connection Phase to a lifecycle phase. CLOSED
// and ERROR are handled by recordEnd, so they return ok=false here.
func modelPhaseFor(p Phase) (model.SessionPhaseKind, bool) {
	switch p {
	case PhaseConnecting:
		return model.PhaseDial, true
	case PhaseHandshake:
		return model.PhaseHandshake, true
	case PhaseConnected:
		return model.PhaseReady, true
	case PhaseReconnecting:
		return model.PhaseReconnect, true
	default:
		return "", false
	}
}

func (s *Session) nodeIDPtr() *uint64 {
	if s.NodeID == 0 {
		return nil
	}
	nid := s.NodeID
	return &nid
}

// bridgePhase records a phase transition observed on the worker's status
// stream: it closes the previous phase, opens the new one, points
// sessions.current_phase at it, and drops the matching audit breadcrumb. The
// caller de-dupes repeated CONNECTED stats spam (lastPhase) before calling, and
// curPhase guards against re-recording the same model phase.
func (m *Manager) bridgePhase(s *Session, dt Phase, message string) {
	if m.sessions == nil || m.audit == nil {
		return
	}
	mp, ok := modelPhaseFor(dt)
	if !ok || mp == s.curPhase {
		return
	}
	ctx := context.Background()
	now := time.Now()
	if s.curPhase != "" {
		_ = m.sessions.ClosePhase(ctx, s.ID, s.curPhase, model.PhaseSucceeded, "", now)
	}
	_ = m.sessions.AppendPhase(ctx, &model.SessionPhase{
		SessionID: s.ID, Phase: mp, Status: model.PhaseRunning, StartedAt: now,
	})
	_ = m.sessions.UpdateCurrentPhase(ctx, s.ID, mp)
	if mp == model.PhaseReady {
		_ = m.sessions.SetReadyAt(ctx, s.ID, now)
		// Keep the in-memory row in sync so recordEnd's partial update doesn't
		// have to re-read it.
		if s.sessionRow != nil {
			s.sessionRow.ReadyAt = &now
		}
	}
	s.curPhase = mp
	nodeID := s.nodeIDPtr()
	m.audit.Log(model.AuditLog{
		Kind: model.AuditSessionPhase, UserID: s.UserID, Username: s.Username,
		SessionID: s.ID, NodeID: nodeID, ClientIP: s.ClientIP,
		Payload: "phase=" + string(mp),
	})
	if mp == model.PhaseReconnect {
		s.sink.AddReconnect()
		m.audit.Log(model.AuditLog{
			Kind: model.AuditSessionReconnect, UserID: s.UserID, Username: s.Username,
			SessionID: s.ID, NodeID: nodeID, ClientIP: s.ClientIP, Payload: message,
		})
	}
}

// auditGraphicalInput lifts a client-side clipboard write or window resize into
// the audit log. Payloads carry metadata only (MIME + byte length, dimensions),
// never the clipboard contents — keeps the audit searchable without leaking
// pasted secrets or bloating the table. Mouse-move / key spam is ignored (that
// is the .dtr tape's job).
func (m *Manager) auditGraphicalInput(s *Session, msg ClientMessage) {
	if m.audit == nil {
		return
	}
	nodeID := s.nodeIDPtr()
	emit := func(kind model.AuditEventKind, payload string) {
		m.audit.Log(model.AuditLog{
			Kind: kind, UserID: s.UserID, Username: s.Username,
			SessionID: s.ID, NodeID: nodeID, ClientIP: s.ClientIP, Payload: payload,
		})
	}
	switch {
	case msg.Clipboard != nil:
		emit(model.AuditGraphicalClipboard, fmt.Sprintf("dir=in mime=%s len=%d", msg.Clipboard.MIME, len(msg.Clipboard.Payload)))
	case msg.Resize != nil:
		emit(model.AuditGraphicalResize, fmt.Sprintf("%dx%d", msg.Resize.Width, msg.Resize.Height))
	}
}

// auditGraphicalClipboardOut records a server→client clipboard transfer
// (metadata only), the outbound counterpart of auditGraphicalInput.
func (m *Manager) auditGraphicalClipboardOut(s *Session, cd *ClipboardData) {
	if m.audit == nil || cd == nil {
		return
	}
	m.audit.Log(model.AuditLog{
		Kind: model.AuditGraphicalClipboard, UserID: s.UserID, Username: s.Username,
		SessionID: s.ID, NodeID: s.nodeIDPtr(), ClientIP: s.ClientIP,
		Payload: fmt.Sprintf("dir=out mime=%s len=%d", cd.MIME, len(cd.Payload)),
	})
}

// finalizeLifecycle backfills the RTT/reconnect rollups onto the in-memory row
// and closes any still-running phase. Called from recordEnd before it persists
// the row's end fields.
func (m *Manager) finalizeLifecycle(s *Session) {
	if m.sessions == nil || s.sessionRow == nil {
		return
	}
	ctx := context.Background()
	if peak, avg, recon, err := m.sessions.MetricSummary(ctx, s.ID); err == nil {
		s.sessionRow.PeakRTTMs, s.sessionRow.AvgRTTMs, s.sessionRow.ReconnectCount = peak, avg, recon
	}
	s.sessionRow.CurrentPhase = model.PhaseClosed
	_ = m.sessions.ClosePhaseAny(ctx, s.ID, model.PhaseSucceeded, time.Now())
}
