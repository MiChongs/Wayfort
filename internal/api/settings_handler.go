package api

import (
	"encoding/json"
	"net/http"
	"sort"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/settings"
)

// SettingsHandler exposes the super-admin system-settings surface: a
// schema-driven config editor backed by settings.Center plus the integration
// connectivity probes. Every route is gated at the router with the
// system:admin permission (super-admin only), so there are no per-call role
// checks here.
//
// Response convention matches the rest of /api/v1: {"ok":true,...} on success,
// {"ok":false,"error":"..."} on failure.
type SettingsHandler struct {
	Center *settings.Center
	Prober *settings.Prober
	// Writer mirrors config saves into the global audit trail's 运维/治理 lane.
	// May be nil.
	Writer *audit.Writer
}

// Schema is the single payload the settings UI renders from: nav groups, every
// managed field with its current value (secrets masked) and metadata, plus the
// live integration states.
func (h *SettingsHandler) Schema(c *gin.Context) {
	groups := make([]gin.H, 0)
	for _, g := range settings.Groups() {
		groups = append(groups, gin.H{
			"id":           g.ID,
			"title":        g.Title,
			"subtitle":     g.Subtitle,
			"icon":         g.Icon,
			"order":        g.Order,
			"integrations": g.Integrations,
		})
	}

	overridden, _ := h.Center.OverriddenKeys(c.Request.Context())
	fields := make([]gin.H, 0)
	for _, s := range settings.Specs() {
		value, secretSet := h.Center.FieldValue(s)
		fh := gin.H{
			"key":        s.Key,
			"group":      s.Group,
			"type":       s.Type,
			"label":      s.Label,
			"help":       s.Help,
			"live":       s.Live,
			"advanced":   s.Advanced,
			"overridden": overridden[s.Key],
		}
		if s.Unit != "" {
			fh["unit"] = s.Unit
		}
		if s.Placeholder != "" {
			fh["placeholder"] = s.Placeholder
		}
		if s.Integration != "" {
			fh["integration"] = s.Integration
		}
		if s.DependsOn != "" {
			fh["depends_on"] = s.DependsOn
			fh["depends_value"] = s.DependsValue
		}
		if len(s.Enum) > 0 {
			fh["enum"] = s.Enum
		}
		if s.Min != nil {
			fh["min"] = *s.Min
		}
		if s.Max != nil {
			fh["max"] = *s.Max
		}
		if s.Step != nil {
			fh["step"] = *s.Step
		}
		if s.Type == settings.TypeSecret {
			fh["secret_set"] = secretSet
		} else {
			fh["value"] = value
		}
		fields = append(fields, fh)
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":           true,
		"groups":       groups,
		"fields":       fields,
		"integrations": h.Prober.List(),
	})
}

type settingsUpdateReq struct {
	Changes map[string]json.RawMessage `json:"changes"`
}

// Update validates + persists + live-applies a batch of changes.
func (h *SettingsHandler) Update(c *gin.Context) {
	var req settingsUpdateReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "请求格式有误"})
		return
	}
	if len(req.Changes) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "没有需要保存的更改"})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	var uid uint64
	var uname string
	if claims != nil {
		uid, uname = claims.UserID, claims.Username
	}
	restart, err := h.Center.Update(c.Request.Context(), req.Changes, uid, uname)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}
	if h.Writer != nil {
		keys := make([]string, 0, len(req.Changes))
		for k := range req.Changes {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		h.Writer.Log(model.AuditLog{
			Kind: model.AuditConfigChange, UserID: uid, Username: uname,
			ClientIP: c.ClientIP(), Payload: "keys=" + strings.Join(keys, ","),
		})
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "restart_keys": restart})
}

type settingsResetReq struct {
	Keys []string `json:"keys"`
}

// Reset drops overrides so the keys fall back to their YAML/code defaults.
func (h *SettingsHandler) Reset(c *gin.Context) {
	var req settingsResetReq
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Keys) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "缺少要重置的配置项"})
		return
	}
	claims := auth.FromContext(c.Request.Context())
	var uid uint64
	var uname string
	if claims != nil {
		uid, uname = claims.UserID, claims.Username
	}
	if err := h.Center.Reset(c.Request.Context(), req.Keys, uid, uname); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Integrations returns the live connectivity state of every external dependency.
func (h *SettingsHandler) Integrations(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true, "integrations": h.Prober.List()})
}

// TestIntegration runs a live probe against one dependency and returns its state.
func (h *SettingsHandler) TestIntegration(c *gin.Context) {
	id := c.Param("id")
	res, err := h.Prober.Test(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "integration": res})
}

// Audits returns the recent managed-setting change trail for the activity strip.
func (h *SettingsHandler) Audits(c *gin.Context) {
	rows, err := h.Center.RecentAudits(c.Request.Context(), 50)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "audits": rows})
}
