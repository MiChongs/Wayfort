package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/logs"
)

// LogsHandler exposes read-only log access: file enumeration, one-shot tail, and
// a Server-Sent-Events follow stream. All require ActionConnect on the node.
type LogsHandler struct {
	Mgr               *logs.Manager
	unavailableReason string
}

func NewLogsHandler(mgr *logs.Manager) *LogsHandler { return &LogsHandler{Mgr: mgr} }
func NewLogsHandlerStub(reason string) *LogsHandler  { return &LogsHandler{unavailableReason: reason} }

func (h *LogsHandler) Files(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	l, err := h.Mgr.List(c.Request.Context(), claims.UserID, nodeID)
	if err != nil {
		respondLogsErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, l)
}

func (h *LogsHandler) Tail(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	lines, _ := strconv.Atoi(c.DefaultQuery("lines", "200"))
	t, err := h.Mgr.Tail(c.Request.Context(), claims.UserID, nodeID, c.Query("source"), c.Query("ref"), lines)
	if err != nil {
		respondLogsErr(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, t)
}

// Follow streams log lines over SSE until the client disconnects. The request
// context cancellation propagates into Manager.Follow, which kills the remote
// `journalctl -f` / `tail -F`.
func (h *LogsHandler) Follow(c *gin.Context) {
	nodeID, claims, ok := h.ctx(c)
	if !ok {
		return
	}
	lines, _ := strconv.Atoi(c.DefaultQuery("lines", "200"))
	source, ref := c.Query("source"), c.Query("ref")

	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	c.Writer.WriteHeader(http.StatusOK)
	c.Writer.Flush()

	ctx := c.Request.Context()
	lineCh := make(chan string, 512)
	errCh := make(chan error, 1)
	go func() {
		errCh <- h.Mgr.Follow(ctx, claims.UserID, nodeID, source, ref, lines, func(l string) {
			select {
			case lineCh <- l:
			case <-ctx.Done():
			}
		})
	}()

	write := func(event, data string) bool {
		if _, err := fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, data); err != nil {
			return false
		}
		c.Writer.Flush()
		return true
	}
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case l := <-lineCh:
			b, _ := json.Marshal(l)
			if !write("line", string(b)) {
				return
			}
		case err := <-errCh:
			if err != nil {
				b, _ := json.Marshal(err.Error())
				write("err", string(b)) // not "error" — that collides with EventSource's native error event
			}
			write("done", "{}")
			return
		case <-ping.C:
			if _, err := fmt.Fprint(c.Writer, ": ping\n\n"); err != nil {
				return
			}
			c.Writer.Flush()
		}
	}
}

func (h *LogsHandler) ctx(c *gin.Context) (uint64, *auth.Claims, bool) {
	if h == nil || h.Mgr == nil {
		msg := "logs subsystem unavailable"
		if h != nil && h.unavailableReason != "" {
			msg = h.unavailableReason
		}
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": msg, "code": "subsystem_unavailable"})
		return 0, nil, false
	}
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return 0, nil, false
	}
	nodeID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad node id"})
		return 0, nil, false
	}
	return nodeID, claims, true
}

func respondLogsErr(c *gin.Context, err error) {
	switch {
	case errors.Is(err, logs.ErrUnauthorized):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error(), "code": "unauthorized"})
	case errors.Is(err, logs.ErrDisabled):
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": err.Error(), "code": "disabled"})
	case errors.Is(err, logs.ErrUnreachable):
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "code": "unreachable"})
	case errors.Is(err, logs.ErrBadRef), errors.Is(err, logs.ErrBadSource):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "code": "bad_request"})
	default:
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
	}
}
