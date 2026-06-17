package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	aimodel "github.com/michongs/wayfort/internal/ai/model"
	airepo "github.com/michongs/wayfort/internal/ai/repo"
	"github.com/michongs/wayfort/internal/ai/runner"
	"github.com/michongs/wayfort/internal/auth"
)

type ConversationHandler struct {
	Repo    *airepo.ConversationRepo
	Msg     *airepo.MessageRepo
	Inv     *airepo.InvocationRepo
	Tasks   *airepo.TaskRepo
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
	// Return the ACTIVE branch only (when the conversation is branched), so the
	// transcript reads as a coherent line; other branches stay reachable via the
	// branch switcher (/branches + /active-leaf).
	var msgs []aimodel.AIMessage
	if conv.ActiveLeafMessageID != nil {
		msgs, _ = h.Msg.ListBranch(c.Request.Context(), conv.ID, *conv.ActiveLeafMessageID)
	} else {
		msgs, _ = h.Msg.ListByConv(c.Request.Context(), conv.ID)
	}
	invs, _ := h.Inv.ListByConv(c.Request.Context(), conv.ID)
	var tasks []aimodel.AITask
	if h.Tasks != nil {
		tasks, _ = h.Tasks.ListByConv(c.Request.Context(), conv.ID)
	}
	c.JSON(http.StatusOK, gin.H{
		"conversation": conv,
		"messages":     msgs,
		"invocations":  invs,
		"plan":         tasks,
	})
}

// GetPlan returns the conversation's live execution plan (task panel state).
func (h *ConversationHandler) GetPlan(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	var tasks []aimodel.AITask
	if h.Tasks != nil {
		tasks, _ = h.Tasks.ListByConv(c.Request.Context(), conv.ID)
	}
	c.JSON(http.StatusOK, gin.H{"plan": tasks})
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
	// ThinkingBudget toggles extended thinking. <=0 turns it off.
	ThinkingBudget *int `json:"thinking_budget"`
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
		conv.ThinkingBudget = nil
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
		if req.ThinkingBudget != nil {
			if *req.ThinkingBudget > 0 {
				conv.ThinkingBudget = req.ThinkingBudget
			} else {
				conv.ThinkingBudget = nil
			}
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
	invs, _ := h.Inv.ListByConv(c.Request.Context(), conv.ID)
	invByCall := map[string]*aimodel.AIToolInvocation{}
	for i := range invs {
		if invs[i].ToolCallID != "" {
			invByCall[invs[i].ToolCallID] = &invs[i]
		}
	}
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
			if strings.TrimSpace(m.Reasoning) != "" {
				fmt.Fprintf(&sb, "<details><summary>🧠 思考</summary>\n\n%s\n\n</details>\n\n", m.Reasoning)
			}
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
						if tc.Name == "update_plan" {
							continue
						}
						fmt.Fprintf(&sb, "### 🛠️ 工具调用 · `%s`\n\n", tc.Name)
						if tc.Arguments != "" {
							fmt.Fprintf(&sb, "**参数**:\n\n```json\n%s\n```\n\n", indentJSON(tc.Arguments))
						}
						if iv := invByCall[tc.ID]; iv != nil {
							if iv.ErrorMessage != "" {
								fmt.Fprintf(&sb, "**结果**（%s）:\n\n```\n%s\n```\n\n", iv.Status, iv.ErrorMessage)
							} else if iv.OutputText != "" {
								fmt.Fprintf(&sb, "**结果**:\n\n```\n%s\n```\n\n", iv.OutputText)
							}
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

// ListMessages is cursor-paginated history: GET /conversations/:id/messages?before_id=&limit=
// (oldest-first page; next_before_id is the cursor for the previous page). Lets
// long conversations open cheaply and lazy-load older messages on scroll-up.
func (h *ConversationHandler) ListMessages(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	beforeID, _ := parseUint64(c.Query("before_id"))
	limit := 50
	if n, err := parseUint64(c.Query("limit")); err == nil && n > 0 && n <= 200 {
		limit = int(n)
	}
	rows, err := h.Msg.ListByConvBefore(c.Request.Context(), conv.ID, beforeID, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var next uint64
	if len(rows) > 0 {
		next = rows[0].ID
	}
	c.JSON(http.StatusOK, gin.H{
		"messages":       rows,
		"next_before_id": next,
		"has_more":       len(rows) == limit && next > 1,
	})
}

// SearchMessages is the in-conversation full-text search/jump:
// GET /conversations/:id/search?q= → matching message ids + snippets.
func (h *ConversationHandler) SearchMessages(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		c.JSON(http.StatusOK, gin.H{"hits": []any{}, "count": 0})
		return
	}
	rows, err := h.Msg.SearchInConv(c.Request.Context(), conv.ID, q, 100)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	type hit struct {
		MessageID uint64    `json:"message_id"`
		Role      string    `json:"role"`
		Snippet   string    `json:"snippet"`
		CreatedAt time.Time `json:"created_at"`
	}
	hits := make([]hit, 0, len(rows))
	for _, m := range rows {
		hits = append(hits, hit{
			MessageID: m.ID,
			Role:      string(m.Role),
			Snippet:   snippetAround(extractText(m.Content), q, 90),
			CreatedAt: m.CreatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"hits": hits, "count": len(hits), "query": q})
}

// Fork clones the conversation (active branch up to upto_message_id, 0 = all)
// into a new independent conversation.
func (h *ConversationHandler) Fork(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	var body struct {
		UptoMessageID uint64 `json:"upto_message_id"`
	}
	_ = c.ShouldBindJSON(&body)
	title := strings.TrimSpace(orStr(conv.Title, "新对话")) + " (副本)"
	nc, err := h.Repo.Clone(c.Request.Context(), conv.ID, body.UptoMessageID, "conv_"+uuid.NewString(), title)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, nc)
}

// ListBranches returns the conversation's branch points (parents with >1 child)
// so the UI can render a "‹2/3›" sibling switcher.
func (h *ConversationHandler) ListBranches(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	msgs, _ := h.Msg.ListByConv(c.Request.Context(), conv.ID)
	// Group children by parent id; root-level siblings (parent_id null) use the
	// sentinel key 0 so a branch off the very first message is still surfaced.
	byParent := map[uint64][]uint64{}
	for _, m := range msgs {
		var pid uint64
		if m.ParentID != nil {
			pid = *m.ParentID
		}
		byParent[pid] = append(byParent[pid], m.ID)
	}
	type group struct {
		ParentID uint64   `json:"parent_id"`
		Siblings []uint64 `json:"siblings"`
	}
	groups := make([]group, 0)
	for pid, kids := range byParent {
		if len(kids) > 1 {
			groups = append(groups, group{ParentID: pid, Siblings: kids})
		}
	}
	c.JSON(http.StatusOK, gin.H{"branches": groups, "active_leaf": conv.ActiveLeafMessageID})
}

// SetActiveLeaf switches the displayed branch (message_id = the leaf to follow;
// null clears back to the default). Does not run a turn.
func (h *ConversationHandler) SetActiveLeaf(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	var body struct {
		MessageID *uint64 `json:"message_id"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.MessageID != nil {
		m, err := h.Msg.FindByID(c.Request.Context(), *body.MessageID)
		if err != nil || m == nil || m.ConversationID != conv.ID {
			c.JSON(http.StatusNotFound, gin.H{"error": "message not found"})
			return
		}
		// Follow the chosen node down to its branch tip so the full branch shows.
		tip, _ := h.Msg.DeepestLeaf(c.Request.Context(), conv.ID, *body.MessageID)
		conv.ActiveLeafMessageID = &tip
	} else {
		conv.ActiveLeafMessageID = nil
	}
	if err := h.Repo.Update(c.Request.Context(), conv); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, conv)
}

// Autotitle (re)generates the conversation title from its opening turns.
func (h *ConversationHandler) Autotitle(c *gin.Context) {
	conv, ok := h.requireOwn(c)
	if !ok {
		return
	}
	title, err := h.Factory.GenerateTitle(c.Request.Context(), conv.ID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"title": title})
}

// snippetAround returns a short window of `text` centered on the first
// case-insensitive occurrence of `q` (whole text if short / no match).
func snippetAround(text, q string, window int) string {
	if len(text) <= window*2 {
		return strings.TrimSpace(text)
	}
	lower := strings.ToLower(text)
	idx := strings.Index(lower, strings.ToLower(q))
	if idx < 0 {
		return strings.TrimSpace(text[:window*2]) + "…"
	}
	start := idx - window
	if start < 0 {
		start = 0
	}
	end := idx + len(q) + window
	if end > len(text) {
		end = len(text)
	}
	out := text[start:end]
	if start > 0 {
		out = "…" + out
	}
	if end < len(text) {
		out += "…"
	}
	return strings.TrimSpace(out)
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
