package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	aimodel "github.com/michongs/jumpserver-anonymous/internal/ai/model"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/michongs/jumpserver-anonymous/internal/ai/runner"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
)

type ConversationHandler struct {
	Repo    *airepo.ConversationRepo
	Msg     *airepo.MessageRepo
	Inv     *airepo.InvocationRepo
	Agents  *airepo.AgentRepo
	Factory *runner.Factory
}

type createConvReq struct {
	AgentID        uint64  `json:"agent_id" binding:"required"`
	ProviderID     *uint64 `json:"provider_id"`
	Model          string  `json:"model"`
	PermissionMode string  `json:"permission_mode"`
	Title          string  `json:"title"`
}

func (h *ConversationHandler) Create(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	var req createConvReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	agent, err := h.Agents.FindByID(c.Request.Context(), req.AgentID)
	if err != nil || agent == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "agent not found"})
		return
	}
	// Visibility check: personal agents only by owner.
	if agent.Scope == aimodel.AgentScopePersonal && (agent.OwnerID == nil || *agent.OwnerID != claims.UserID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "agent not visible"})
		return
	}
	mode := aimodel.PermissionMode(req.PermissionMode)
	if mode == "" {
		mode = agent.PermissionMode
	}
	conv := &aimodel.AIConversation{
		ID:             "conv_" + uuid.NewString(),
		UserID:         claims.UserID,
		AgentID:        req.AgentID,
		Title:          orStr(req.Title, "新对话"),
		Model:          req.Model,
		PermissionMode: mode,
		Status:         aimodel.ConvStatusActive,
	}
	if req.ProviderID != nil {
		conv.ProviderID = *req.ProviderID
	}
	if err := h.Repo.Create(c.Request.Context(), conv); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, conv)
}

func (h *ConversationHandler) List(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	rows, err := h.Repo.ListByUser(c.Request.Context(), claims.UserID, 100)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"conversations": rows})
}

func (h *ConversationHandler) Get(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	msgs, _ := h.Msg.ListByConv(c.Request.Context(), conv.ID)
	invs, _ := h.Inv.ListByConv(c.Request.Context(), conv.ID)
	c.JSON(http.StatusOK, gin.H{
		"conversation": conv,
		"messages":     msgs,
		"invocations":  invs,
	})
}

type updateConvReq struct {
	Title          string   `json:"title"`
	PermissionMode string   `json:"permission_mode"`
	Archived       *bool    `json:"archived"`
	Pinned         *bool    `json:"pinned"`
	ProviderID     *uint64  `json:"provider_id"`
	Model          *string  `json:"model"`
	Temperature    *float64 `json:"temperature"`
	TopP           *float64 `json:"top_p"`
	MaxTokens      *int     `json:"max_tokens"`
	// Sentinel: pass {"reset_overrides": true} to clear temp/top_p/max_tokens.
	ResetOverrides bool `json:"reset_overrides"`
}

func (h *ConversationHandler) Update(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	var req updateConvReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Title != "" {
		conv.Title = req.Title
	}
	if req.PermissionMode != "" {
		conv.PermissionMode = aimodel.PermissionMode(req.PermissionMode)
	}
	if req.Archived != nil {
		conv.Archived = *req.Archived
	}
	if req.Pinned != nil {
		conv.Pinned = *req.Pinned
	}
	if req.ProviderID != nil {
		conv.ProviderID = *req.ProviderID
	}
	if req.Model != nil {
		conv.Model = *req.Model
	}
	if req.ResetOverrides {
		conv.Temperature = nil
		conv.TopP = nil
		conv.MaxTokens = nil
	} else {
		if req.Temperature != nil {
			conv.Temperature = req.Temperature
		}
		if req.TopP != nil {
			conv.TopP = req.TopP
		}
		if req.MaxTokens != nil {
			conv.MaxTokens = req.MaxTokens
		}
	}
	if err := h.Repo.Update(c.Request.Context(), conv); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, conv)
}

// Search performs a full-text search across the calling user's conversations.
// Matches title, agent name (best-effort via JOIN-less LIKE on title only),
// and any message content. SQL LIKE is fine at our scale; switch to FTS if
// it ever starts costing.
func (h *ConversationHandler) Search(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		c.JSON(http.StatusOK, gin.H{"conversations": []any{}, "count": 0})
		return
	}
	limit := 50
	rows, err := h.Repo.Search(c.Request.Context(), claims.UserID, q, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"conversations": rows, "count": len(rows), "query": q})
}

// EditMessage rewrites a user message and truncates every later message in
// the conversation, leaving the conversation ready for a fresh turn. The
// edited turn is NOT auto-run server-side — the client will POST /messages
// (the existing run endpoint) right after, using the same edited text.
func (h *ConversationHandler) EditMessage(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	msgIDStr := c.Param("msg_id")
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
	msgID, perr := parseUint64(msgIDStr)
	if perr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad msg_id"})
		return
	}
	msg, err := h.Msg.FindByID(c.Request.Context(), msgID)
	if err != nil || msg == nil || msg.ConversationID != conv.ID {
		c.JSON(http.StatusNotFound, gin.H{"error": "message not found"})
		return
	}
	if msg.Role != aimodel.RoleUser {
		c.JSON(http.StatusBadRequest, gin.H{"error": "only user messages can be edited"})
		return
	}
	parts := []map[string]any{{"type": "text", "text": body.Text}}
	contentJSON, _ := json.Marshal(parts)
	msg.Content = string(contentJSON)
	if err := h.Msg.Update(c.Request.Context(), msg); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Truncate every later message + their tool invocations.
	if err := h.Msg.DeleteAfter(c.Request.Context(), conv.ID, msg.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := h.Inv.DeleteAfter(c.Request.Context(), conv.ID, msg.ID); err != nil {
		// Non-fatal: invocations are denormalised audit; log and continue.
		_ = err
	}
	count, _ := h.Msg.CountByConv(c.Request.Context(), conv.ID)
	conv.MessageCount = count
	conv.Status = aimodel.ConvStatusActive
	_ = h.Repo.Update(c.Request.Context(), conv)
	c.JSON(http.StatusOK, gin.H{"ok": true, "message_count": count, "edited_message_id": msg.ID, "text": body.Text})
}

// ExportMarkdown renders the conversation as a downloadable Markdown
// document — agent / model / mode metadata at the top, then role-prefixed
// sections for every persisted message.
func (h *ConversationHandler) ExportMarkdown(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	msgs, _ := h.Msg.ListByConv(c.Request.Context(), conv.ID)
	var sb strings.Builder
	fmt.Fprintf(&sb, "# %s\n\n", strings.TrimSpace(orStr(conv.Title, "对话")))
	fmt.Fprintf(&sb, "- **ID**: `%s`\n", conv.ID)
	fmt.Fprintf(&sb, "- **创建时间**: %s\n", conv.CreatedAt.Format(time.RFC3339))
	fmt.Fprintf(&sb, "- **模型**: `%s`\n", orStr(conv.Model, "—"))
	fmt.Fprintf(&sb, "- **权限模式**: `%s`\n", string(conv.PermissionMode))
	fmt.Fprintf(&sb, "- **消息数**: %d\n", conv.MessageCount)
	fmt.Fprintf(&sb, "- **Token**: ↑ %d / ↓ %d\n\n", conv.TotalInputTokens, conv.TotalOutputTokens)
	sb.WriteString("---\n\n")
	for _, m := range msgs {
		text := extractText(m.Content)
		switch m.Role {
		case aimodel.RoleUser:
			fmt.Fprintf(&sb, "## 🧑 用户 · %s\n\n%s\n\n", m.CreatedAt.Format("2006-01-02 15:04:05"), text)
		case aimodel.RoleAssistant:
			fmt.Fprintf(&sb, "## 🤖 助手 · %s\n\n", m.CreatedAt.Format("2006-01-02 15:04:05"))
			if text != "" {
				sb.WriteString(text)
				sb.WriteString("\n\n")
			}
			if m.ToolCalls != "" {
				var tcs []struct {
					ID        string `json:"id"`
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				}
				if err := json.Unmarshal([]byte(m.ToolCalls), &tcs); err == nil {
					for _, tc := range tcs {
						fmt.Fprintf(&sb, "### 🛠️ 工具调用 · `%s`\n\n", tc.Name)
						if tc.Arguments != "" {
							fmt.Fprintf(&sb, "**参数**:\n\n```json\n%s\n```\n\n", indentJSON(tc.Arguments))
						}
					}
				}
			}
		case aimodel.RoleTool:
			fmt.Fprintf(&sb, "### 🛠️ 工具结果\n\n```\n%s\n```\n\n", text)
		case aimodel.RoleSystem:
			fmt.Fprintf(&sb, "### 系统\n\n%s\n\n", text)
		}
	}
	filename := fmt.Sprintf("conversation-%s.md", conv.ID)
	c.Header("Content-Type", "text/markdown; charset=utf-8")
	c.Header("Content-Disposition", `attachment; filename="`+filename+`"`)
	c.String(http.StatusOK, sb.String())
}

// ---- small helpers ----

func extractText(content string) string {
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal([]byte(content), &parts); err != nil {
		return content
	}
	var out []string
	for _, p := range parts {
		if p.Type == "text" || p.Type == "" {
			out = append(out, p.Text)
		}
	}
	return strings.Join(out, "")
}

func indentJSON(raw string) string {
	var anyVal any
	if err := json.Unmarshal([]byte(raw), &anyVal); err != nil {
		return raw
	}
	b, err := json.MarshalIndent(anyVal, "", "  ")
	if err != nil {
		return raw
	}
	return string(b)
}

func parseUint64(s string) (uint64, error) {
	var x uint64
	_, err := fmt.Sscanf(s, "%d", &x)
	return x, err
}

func (h *ConversationHandler) Delete(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	if err := h.Repo.Delete(c.Request.Context(), conv.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *ConversationHandler) Cancel(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	h.Factory.Cancel(conv.ID)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *ConversationHandler) requireOwn(c *gin.Context) (*aimodel.AIConversation, bool) {
	claims := auth.FromContext(c.Request.Context())
	id := c.Param("id")
	conv, err := h.Repo.FindByID(c.Request.Context(), id)
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

func orStr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
