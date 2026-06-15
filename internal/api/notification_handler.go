package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/notifications"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/sse"
)

// NotificationHandler serves the per-user in-app notification center under
// /api/v1/me/notifications: list / unread-count / mark-read / delete + an SSE
// stream that pushes new notifications to the browser in realtime.
type NotificationHandler struct {
	Repo *repo.NotificationRepo
	Hub  *notifications.Hub
}

// List — GET /me/notifications?unread=1&limit=&offset=
func (h *NotificationHandler) List(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	unread := c.Query("unread") == "1" || c.Query("unread") == "true"
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	rows, total, err := h.Repo.ListByUser(c.Request.Context(), claims.UserID, unread, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	unreadCount, _ := h.Repo.UnreadCount(c.Request.Context(), claims.UserID)
	c.JSON(http.StatusOK, gin.H{"notifications": rows, "total": total, "unread_count": unreadCount})
}

// UnreadCount — GET /me/notifications/unread-count
func (h *NotificationHandler) UnreadCount(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	n, err := h.Repo.UnreadCount(c.Request.Context(), claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"unread_count": n})
}

// MarkRead — POST /me/notifications/:id/read
func (h *NotificationHandler) MarkRead(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if _, err := h.Repo.MarkRead(c.Request.Context(), id, claims.UserID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// MarkAllRead — POST /me/notifications/read-all
func (h *NotificationHandler) MarkAllRead(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	n, err := h.Repo.MarkAllRead(c.Request.Context(), claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "marked": n})
}

// Delete — DELETE /me/notifications/:id
func (h *NotificationHandler) Delete(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id, claims.UserID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Stream — GET /me/notifications/stream (SSE). Pushes each new notification
// addressed to the caller. The JWT is accepted from the ?token= query param
// (EventSource can't set Authorization headers) by the auth middleware.
func (h *NotificationHandler) Stream(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return
	}
	if h.Hub == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "notification hub disabled"})
		return
	}
	ch, cancel := h.Hub.SubscribeUser(claims.UserID)
	defer cancel()

	sse.WriteHeaders(c)
	sse.Frame(c, "ready", `{"ok":true}`)
	ctx := c.Request.Context()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case n, ok := <-ch:
			if !ok {
				return
			}
			b, err := json.Marshal(n)
			if err != nil {
				continue
			}
			if !sse.Frame(c, "notification", string(b)) {
				return
			}
		case <-ping.C:
			if !sse.Ping(c) {
				return
			}
		}
	}
}
