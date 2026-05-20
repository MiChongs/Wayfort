package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// SnippetHandler — Phase 11 snippet CRUD + variable resolution.
type SnippetHandler struct {
	Repo *repo.SnippetRepo
}

func (h *SnippetHandler) List(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	out, err := h.Repo.List(c.Request.Context(), uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Pre-extract per-snippet variables so the UI can render the placeholder
	// hint without re-parsing on every keystroke.
	type withVars struct {
		model.Snippet
		Variables []string `json:"variables"`
	}
	resp := make([]withVars, 0, len(out))
	for i := range out {
		resp = append(resp, withVars{
			Snippet:   out[i],
			Variables: extractVariables(out[i].Body),
		})
	}
	c.JSON(http.StatusOK, gin.H{"snippets": resp})
}

type snippetRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Body        string `json:"body"`
	Tags        string `json:"tags"`
	Pinned      bool   `json:"pinned"`
}

func (h *SnippetHandler) Create(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var req snippetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := validateSnippet(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	s := &model.Snippet{
		UserID:      uid,
		Name:        strings.TrimSpace(req.Name),
		Description: req.Description,
		Body:        req.Body,
		Tags:        req.Tags,
		Pinned:      req.Pinned,
	}
	if err := h.Repo.Create(c.Request.Context(), s); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, s)
}

func (h *SnippetHandler) Update(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	s, err := h.Repo.FindByID(c.Request.Context(), uid, id)
	if err != nil || s == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var req snippetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if v := strings.TrimSpace(req.Name); v != "" {
		s.Name = v
	}
	if req.Body != "" {
		s.Body = req.Body
	}
	s.Description = req.Description
	s.Tags = req.Tags
	s.Pinned = req.Pinned
	if err := validateSnippet(&snippetRequest{Name: s.Name, Body: s.Body}); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Update(c.Request.Context(), s); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, s)
}

func (h *SnippetHandler) Delete(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), uid, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Use bumps usage_count + last_used_at AND optionally resolves the body
// against caller-provided variables. The resolved string is returned so the
// UI can drop it directly into the terminal.
func (h *SnippetHandler) Use(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	s, err := h.Repo.FindByID(c.Request.Context(), uid, id)
	if err != nil || s == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var body struct {
		Variables map[string]string `json:"variables"`
	}
	_ = c.ShouldBindJSON(&body)
	resolved := resolveVariables(s.Body, body.Variables)
	_ = h.Repo.BumpUsage(c.Request.Context(), uid, id)
	c.JSON(http.StatusOK, gin.H{"resolved": resolved, "snippet": s})
}

// CommandHistoryHandler — opt-in capture + search.
type CommandHistoryHandler struct {
	Repo    *repo.CommandHistoryRepo
	Profile *repo.TerminalProfileRepo
}

func (h *CommandHistoryHandler) List(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	q := c.Query("q")
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
	var nodeID *uint64
	if v := c.Query("node_id"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			nodeID = &n
		}
	}
	rows, err := h.Repo.List(c.Request.Context(), uid, q, nodeID, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"history": rows})
}

func (h *CommandHistoryHandler) Clear(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var nodeID *uint64
	if v := c.Query("node_id"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 64); err == nil {
			nodeID = &n
		}
	}
	if err := h.Repo.Clear(c.Request.Context(), uid, nodeID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Record is intentionally a thin client-driven entry point — the frontend
// detects "user pressed Enter at a shell prompt" and POSTs the command. The
// gateway has no PTY-side regex inference so this keeps things honest.
type recordRequest struct {
	NodeID     *uint64 `json:"node_id"`
	SessionID  string  `json:"session_id"`
	Command    string  `json:"command"`
	ExitCode   int     `json:"exit_code"`
	DurationMs int64   `json:"duration_ms"`
	WorkingDir string  `json:"working_dir"`
}

func (h *CommandHistoryHandler) Record(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var req recordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cmd := strings.TrimSpace(req.Command)
	if cmd == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "command required"})
		return
	}
	// Honour the user's opt-in flag. If the profile doesn't exist yet treat
	// it as opted-out so installs don't surprise users.
	if h.Profile != nil {
		p, err := h.Profile.Get(c.Request.Context(), uid)
		if err == nil && (p == nil || !p.HistoryEnabled) {
			c.JSON(http.StatusOK, gin.H{"recorded": false, "reason": "history_disabled"})
			return
		}
	}
	row := &model.CommandHistory{
		UserID: uid, NodeID: req.NodeID, SessionID: req.SessionID,
		Command: cmd, ExitCode: req.ExitCode, DurationMs: req.DurationMs,
		WorkingDir: req.WorkingDir,
	}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"recorded": true, "id": row.ID})
}

// TerminalProfileHandler — get/set the user's synced terminal preferences.
type TerminalProfileHandler struct {
	Repo *repo.TerminalProfileRepo
}

func (h *TerminalProfileHandler) Get(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	p, err := h.Repo.Get(c.Request.Context(), uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if p == nil {
		c.JSON(http.StatusOK, gin.H{"profile": gin.H{
			"user_id": uid, "body": "", "history_enabled": false,
		}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"profile": p})
}

type terminalProfileUpdate struct {
	Body           json.RawMessage `json:"body"`
	HistoryEnabled *bool           `json:"history_enabled"`
}

func (h *TerminalProfileHandler) Set(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var req terminalProfileUpdate
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p, err := h.Repo.Get(c.Request.Context(), uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if p == nil {
		p = &model.TerminalProfile{UserID: uid}
	}
	if len(req.Body) > 0 && string(req.Body) != "null" {
		p.Body = string(req.Body)
	}
	if req.HistoryEnabled != nil {
		p.HistoryEnabled = *req.HistoryEnabled
	}
	if err := h.Repo.Upsert(c.Request.Context(), p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"profile": p})
}

// ----- helpers --------------------------------------------------------------

func requireUser(c *gin.Context) (uint64, bool) {
	cc := auth.FromContext(c.Request.Context())
	if cc == nil {
		c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return 0, false
	}
	return cc.UserID, true
}

var snippetVarRE = regexp.MustCompile(`\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}`)

func extractVariables(body string) []string {
	seen := map[string]struct{}{}
	matches := snippetVarRE.FindAllStringSubmatch(body, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		if _, ok := seen[m[1]]; ok {
			continue
		}
		seen[m[1]] = struct{}{}
		out = append(out, m[1])
	}
	sort.Strings(out)
	return out
}

func resolveVariables(body string, vars map[string]string) string {
	return snippetVarRE.ReplaceAllStringFunc(body, func(match string) string {
		sub := snippetVarRE.FindStringSubmatch(match)
		if len(sub) < 2 {
			return match
		}
		if v, ok := vars[sub[1]]; ok {
			return v
		}
		return match
	})
}

func validateSnippet(r *snippetRequest) error {
	if strings.TrimSpace(r.Name) == "" {
		return errors.New("name required")
	}
	if strings.TrimSpace(r.Body) == "" {
		return errors.New("body required")
	}
	return nil
}
