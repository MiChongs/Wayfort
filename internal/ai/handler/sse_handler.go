package handler

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	aimodel "github.com/michongs/wayfort/internal/ai/model"
	airepo "github.com/michongs/wayfort/internal/ai/repo"
	"github.com/michongs/wayfort/internal/ai/runner"
	"github.com/michongs/wayfort/internal/auth"
)

// SSEHandler streams runner events to the browser using Server-Sent Events.
// Two endpoints are wired:
//   - POST /messages : append a user message and start a new run, then attach
//   - GET  /stream   : re-attach to an in-progress run (for refresh/reconnect)
type SSEHandler struct {
	Conv    *airepo.ConversationRepo
	Msg     *airepo.MessageRepo
	Inv     *airepo.InvocationRepo
	Factory *runner.Factory
}

type sendMessageReq struct {
	Text string `json:"text"`
	// Images are data: URLs (base64) for vision-capable models. Optional.
	Images []string `json:"images"`
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
	if strings.TrimSpace(req.Text) == "" && len(req.Images) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text or images required"})
		return
	}
	sink, err := h.Factory.Run(c.Request.Context(), conv, req.Text, req.Images)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	pumpSSE(c, sink.C())
}

// Regenerate is POST /conversations/:id/regenerate — re-runs the last user turn
// after trimming the prior assistant reply + its tool messages. SSE response.
func (h *SSEHandler) Regenerate(c *gin.Context) {
	conv, ok := h.own(c)
	if !ok {
		return
	}
	if h.Factory.IsRunning(conv.ID) {
		c.JSON(http.StatusConflict, gin.H{"error": "本对话正在生成中"})
		return
	}
	ctx := c.Request.Context()
	lastUser, err := h.Msg.LastUserMessage(ctx, conv.ID)
	if err != nil || lastUser == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "没有可重新生成的用户消息"})
		return
	}
	if err := h.Msg.DeleteAfter(ctx, conv.ID, lastUser.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	_ = h.Inv.DeleteAfter(ctx, conv.ID, lastUser.ID)
	count, _ := h.Msg.CountByConv(ctx, conv.ID)
	conv.MessageCount = count
	if conv.ActiveLeafMessageID != nil {
		leaf := lastUser.ID
		conv.ActiveLeafMessageID = &leaf
	}
	_ = h.Conv.Update(ctx, conv)
	sink, err := h.Factory.Rerun(ctx, conv)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	pumpSSE(c, sink.C())
}

// BranchMessage is POST /conversations/:id/messages/:msg_id/branch — forks a new
// branch by re-asking from a user message with edited text, preserving the
// original branch. SSE response.
func (h *SSEHandler) BranchMessage(c *gin.Context) {
	conv, ok := h.own(c)
	if !ok {
		return
	}
	if h.Factory.IsRunning(conv.ID) {
		c.JSON(http.StatusConflict, gin.H{"error": "本对话正在生成中"})
		return
	}
	var body struct {
		Text string `json:"text" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	body.Text = strings.TrimSpace(body.Text)
	if body.Text == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "text required"})
		return
	}
	ctx := c.Request.Context()
	msgID, perr := parseUint64(c.Param("msg_id"))
	if perr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad msg_id"})
		return
	}
	msg, err := h.Msg.FindByID(ctx, msgID)
	if err != nil || msg == nil || msg.ConversationID != conv.ID {
		c.JSON(http.StatusNotFound, gin.H{"error": "message not found"})
		return
	}
	if msg.Role != "user" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "only user messages can be branched"})
		return
	}
	// Materialize the implicit parent chain (linear convs carry nil ParentID),
	// then branch as a sibling of the edited message.
	if err := h.Msg.BackfillParents(ctx, conv.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	msg, _ = h.Msg.FindByID(ctx, msgID) // reload to pick up the backfilled ParentID
	sink, err := h.Factory.Branch(ctx, conv, body.Text, msg.ParentID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	pumpSSE(c, sink.C())
}

// own resolves the conversation and enforces ownership (mirrors the inline check
// used by SendMessage/Stream).
func (h *SSEHandler) own(c *gin.Context) (*aimodel.AIConversation, bool) {
	claims := auth.FromContext(c.Request.Context())
	id := c.Param("id")
	conv, err := h.Conv.FindByID(c.Request.Context(), id)
	if err != nil || conv == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return nil, false
	}
	if conv.UserID != claims.UserID && !claims.Admin {
		c.JSON(http.StatusForbidden, gin.H{"error": "not yours"})
		return nil, false
	}
	return conv, true
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
