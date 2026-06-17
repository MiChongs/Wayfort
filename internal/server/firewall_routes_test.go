package server

import (
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/api"
)

// TestFirewallRoutesRegister guards the firewall route tree, where static
// segments (rules/insert, rules/move, rules/bulk-delete) sit alongside the
// rules/:index param — the classic place gin's radix tree could panic.
func TestFirewallRoutesRegister(t *testing.T) {
	gin.SetMode(gin.TestMode)
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("firewall routes panicked on registration: %v", r)
		}
	}()
	r := gin.New()
	ops := r.Group("/api/v1")
	h := api.NewFirewallHandlerStub("test")
	mw := func(c *gin.Context) {}

	ops.GET("/nodes/:id/firewall/status", h.Status)
	ops.GET("/nodes/:id/firewall/status/stream", h.StatusStream)
	ops.GET("/nodes/:id/firewall/rules", h.ListRules)
	ops.GET("/nodes/:id/firewall/diagnose", h.Diagnose)
	ops.GET("/nodes/:id/firewall/conntrack", h.Conntrack)
	ops.GET("/nodes/:id/firewall/conntrack/stream", h.ConntrackStream)
	ops.GET("/nodes/:id/firewall/logs/stream", h.LogsStream)
	ops.POST("/nodes/:id/firewall/rules", mw, h.AddRule)
	ops.DELETE("/nodes/:id/firewall/rules/:index", mw, h.DeleteRule)
	ops.POST("/nodes/:id/firewall/rules/insert", mw, h.InsertRule)
	ops.PUT("/nodes/:id/firewall/rules/:index", mw, h.EditRule)
	ops.POST("/nodes/:id/firewall/rules/move", mw, h.MoveRule)
	ops.POST("/nodes/:id/firewall/rules/bulk-delete", mw, h.BulkDelete)
	ops.POST("/nodes/:id/firewall/persist", mw, h.Persist)
	ops.POST("/nodes/:id/firewall/enable", mw, h.Enable)
	ops.POST("/nodes/:id/firewall/disable", mw, h.Disable)
	ops.GET("/nodes/:id/firewall/install/probe", h.ProbeInstall)
	ops.POST("/nodes/:id/firewall/install/stream", mw, h.InstallStream)
	ops.POST("/nodes/:id/firewall/fail2ban/install/stream", mw, h.InstallF2BStream)
	ops.GET("/nodes/:id/firewall/presets", h.Presets)
	ops.GET("/nodes/:id/firewall/templates", h.Templates)
	ops.GET("/nodes/:id/firewall/exposure", h.Exposure)
	ops.GET("/nodes/:id/firewall/export", h.Export)
	ops.POST("/nodes/:id/firewall/import/preview", mw, h.ImportPreview)
	ops.POST("/nodes/:id/firewall/apply", mw, h.SafeApply)
	ops.POST("/nodes/:id/firewall/commit", mw, h.CommitApply)
	ops.POST("/nodes/:id/firewall/rollback", mw, h.Rollback)
	ops.GET("/nodes/:id/firewall/fail2ban", h.Fail2ban)
	ops.GET("/nodes/:id/firewall/fail2ban/stream", h.Fail2banStream)
	ops.POST("/nodes/:id/firewall/fail2ban/ban", mw, h.F2BBan)
	ops.POST("/nodes/:id/firewall/fail2ban/unban", mw, h.F2BUnban)
}
