package api

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// SessionTerminator is implemented by every subsystem that owns live sessions
// (the SSH/Telnet gateway, the desktop manager). TerminateSession closes the
// connection if this owner holds it and reports whether it acted, so the
// handler can fall back to a direct row update for stale rows.
type SessionTerminator interface {
	TerminateSession(ctx context.Context, sessionID string) bool
}

type SessionHandler struct {
	Repo  *repo.SessionRepo
	Audit *repo.AuditRepo
	// Writer records the force-off action to the audit trail. May be nil.
	Writer *audit.Writer
	// Terminators are tried in order when an admin forces a live session off.
	Terminators []SessionTerminator
}

func (h *SessionHandler) List(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	filter := repo.ListSessionFilter{
		Status: c.Query("status"),
		Kind:   c.Query("kind"),
		Q:      c.Query("q"),
		Limit:  limit,
		Offset: offset,
	}
	if raw := c.Query("node_id"); raw != "" {
		if nid, err := strconv.ParseUint(raw, 10, 64); err == nil {
			filter.NodeID = &nid
		}
	}
	if raw := c.Query("from"); raw != "" {
		if t, err := time.Parse(time.RFC3339, raw); err == nil {
			filter.From = &t
		}
	}
	if raw := c.Query("to"); raw != "" {
		if t, err := time.Parse(time.RFC3339, raw); err == nil {
			filter.To = &t
		}
	}

	out, err := h.Repo.List(c.Request.Context(), filter)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	total, err := h.Repo.Count(c.Request.Context(), filter)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"sessions": out, "total": total})
}

// Get returns one session by id so the detail page no longer pages the whole
// list to find a single row.
func (h *SessionHandler) Get(c *gin.Context) {
	row, err := h.Repo.FindByID(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"session": row})
}

// AuditTimeline returns the audit events recorded against a session — the
// reconstructed command lines, file transfers, and lifecycle markers — in
// chronological order for the detail page timeline.
func (h *SessionHandler) AuditTimeline(c *gin.Context) {
	if h.Audit == nil {
		c.JSON(http.StatusOK, gin.H{"events": []model.AuditLog{}})
		return
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "500"))
	rows, err := h.Audit.List(c.Request.Context(), c.Param("id"), limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Audit.List orders newest-first; flip to chronological for the timeline.
	for i, j := 0, len(rows)-1; i < j; i, j = i+1, j-1 {
		rows[i], rows[j] = rows[j], rows[i]
	}
	c.JSON(http.StatusOK, gin.H{"events": rows})
}

// Phases returns the connection-stage timeline of a session (dial → auth →
// handshake → ready → … → closed) for the lifecycle gantt.
func (h *SessionHandler) Phases(c *gin.Context) {
	rows, err := h.Repo.Phases(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"phases": rows})
}

// Metrics returns the connection-quality samples (RTT / loss / bandwidth /
// reconnects) of a session within an optional [from, to] window.
func (h *SessionHandler) Metrics(c *gin.Context) {
	var from, to *time.Time
	if raw := c.Query("from"); raw != "" {
		if t, err := time.Parse(time.RFC3339, raw); err == nil {
			from = &t
		}
	}
	if raw := c.Query("to"); raw != "" {
		if t, err := time.Parse(time.RFC3339, raw); err == nil {
			to = &t
		}
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "2000"))
	rows, err := h.Repo.Metrics(c.Request.Context(), c.Param("id"), from, to, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"samples": rows})
}

// Lifecycle bundles the session row, its phase timeline, and its quality
// samples in one response so the detail dashboard loads in a single request.
func (h *SessionHandler) Lifecycle(c *gin.Context) {
	ctx := c.Request.Context()
	id := c.Param("id")
	row, err := h.Repo.FindByID(ctx, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	phases, err := h.Repo.Phases(ctx, id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	samples, err := h.Repo.Metrics(ctx, id, nil, nil, 2000)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"session": row, "phases": phases, "samples": samples})
}

// Stats backs the overview strip and trend on the sessions audit page.
func (h *SessionHandler) Stats(c *gin.Context) {
	days, _ := strconv.Atoi(c.DefaultQuery("days", "14"))
	st, err := h.Repo.Stats(c.Request.Context(), days)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, st)
}

// Terminate forces a live session off. It cancels the in-process connection via
// the registered terminators; if none own the row (already gone, or owned by
// another instance) it still marks the row terminated so the audit list reads
// true.
func (h *SessionHandler) Terminate(c *gin.Context) {
	id := c.Param("id")
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if row.Status != model.SessionActive {
		c.JSON(http.StatusConflict, gin.H{"error": "会话已结束"})
		return
	}

	handled := false
	for _, t := range h.Terminators {
		if t != nil && t.TerminateSession(c.Request.Context(), id) {
			handled = true
			break
		}
	}
	if !handled {
		// No live owner in this process — close the row out directly so the
		// list stops showing a phantom "active" session.
		end := time.Now()
		row.EndedAt = &end
		row.Status = model.SessionTerminated
		if row.Reason == "" {
			row.Reason = "管理员强制下线"
		}
		if err := h.Repo.Update(c.Request.Context(), row); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
	}

	if claims := auth.FromContext(c.Request.Context()); claims != nil && h.Writer != nil {
		h.Writer.Log(model.AuditLog{
			Kind: model.AuditSessionTerminate, UserID: claims.UserID, Username: claims.Username,
			SessionID: id, NodeID: row.NodeID, ClientIP: c.ClientIP(),
			Payload: "force-off",
		})
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "live": handled})
}

func (h *SessionHandler) Recording(c *gin.Context) {
	id := c.Param("id")
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if row.RecordingPath == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "no recording"})
		return
	}
	f, err := os.Open(row.RecordingPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	defer f.Close()
	ext := ".cast"
	contentType := "application/x-asciicast"
	switch row.RecordingType {
	case "guac":
		ext = ".guac"
		contentType = "application/octet-stream"
	case "desktop":
		ext = ".dtr"
		contentType = "application/octet-stream"
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", "attachment; filename=\""+id+ext+"\"")
	http.ServeContent(c.Writer, c.Request, id+ext, row.StartedAt, f)
}
