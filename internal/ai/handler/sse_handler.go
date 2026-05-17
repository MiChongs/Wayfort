package handler

import (
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/michongs/jumpserver-anonymous/internal/ai/runner"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
)

// SSEHandler streams runner events to the browser using Server-Sent Events.
// Two endpoints are wired:
//   - POST /messages : append a user message and start a new run, then attach
//   - GET  /stream   : re-attach to an in-progress run (for refresh/reconnect)
type SSEHandler struct {
	Conv    *airepo.ConversationRepo
	Factory *runner.Factory
}

type sendMessageReq struct {
	Text string `json:"text" binding:"required"`
}

// SendMessage is POST /api/v1/ai/conversations/:id/messages and is itself an
// SSE response: it kicks off a runner turn and streams events back inline.
func (h *SSEHandler) SendMessage(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id := c.Param("id")
	conv, err := h.Conv.FindByID(c.Request.Context(), id)
	if err != nil || conv == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if conv.UserID != claims.UserID && !claims.Admin {
		c.JSON(http.StatusForbidden, gin.H{"error": "not yours"})
		return
	}
	var req sendMessageReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	sink, err := h.Factory.Run(c.Request.Context(), conv, req.Text)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	pumpSSE(c, sink.C())
}

// Stream is GET /api/v1/ai/conversations/:id/stream — re-attaches to a live
// run that was started by SendMessage. Returns 404 if the run already finished.
func (h *SSEHandler) Stream(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	id := c.Param("id")
	conv, err := h.Conv.FindByID(c.Request.Context(), id)
	if err != nil || conv == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if conv.UserID != claims.UserID && !claims.Admin {
		c.JSON(http.StatusForbidden, gin.H{"error": "not yours"})
		return
	}
	sink := h.Factory.Stream(id)
	if sink == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "no live run"})
		return
	}
	pumpSSE(c, sink.C())
}

// pumpSSE forwards events to the HTTP response, flushing after every frame.
// 15s ping events keep proxies from closing the connection on idle.
func pumpSSE(c *gin.Context, events <-chan runner.Event) {
	w := c.Writer
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	notify := c.Request.Context().Done()

	for {
		select {
		case ev, ok := <-events:
			if !ok {
				_, _ = io.WriteString(w, "event: done\ndata: {}\n\n")
				if flusher != nil {
					flusher.Flush()
				}
				return
			}
			b := runner.EncodeData(ev.Data)
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", ev.Kind, b)
			if flusher != nil {
				flusher.Flush()
			}
		case <-ping.C:
			_, _ = io.WriteString(w, "event: ping\ndata: {}\n\n")
			if flusher != nil {
				flusher.Flush()
			}
		case <-notify:
			return
		}
	}
}
