package server

import (
	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/ai"
	"github.com/michongs/wayfort/internal/api"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/desktop"
	"github.com/michongs/wayfort/internal/guard"
	"github.com/michongs/wayfort/internal/insights"
	"github.com/michongs/wayfort/internal/protocols/dbcli"
	"github.com/michongs/wayfort/internal/protocols/guacamole"
	"github.com/michongs/wayfort/internal/protocols/oss"
	"github.com/michongs/wayfort/internal/protocols/tcpfwd"
	"github.com/michongs/wayfort/internal/sftp"
	"github.com/michongs/wayfort/internal/webssh"
	"github.com/michongs/wayfort/pkg/edition"
)

// firewallHandler / dockerHandler — 503-stub pattern shared with insights:
// register routes unconditionally so a disabled-by-config feature returns a
// structured 503 instead of gin's no-route 404. The stub carries a reason
// string so the UI can render "rebuild from latest source" instead of an
// opaque "subsystem unavailable".
func firewallHandler(rt *Routes) *api.FirewallHandler {
	if rt.Firewall != nil {
		return rt.Firewall
	}
	return api.NewFirewallHandlerStub("firewall subsystem not initialised on this gateway — " +
		"the binary may predate the firewall feature; rebuild from latest source")
}
func dockerHandler(rt *Routes) *api.DockerHandler {
	if rt.Docker != nil {
		return rt.Docker
	}
	return api.NewDockerHandler(nil)
}
func systemdHandler(rt *Routes) *api.SystemdHandler {
	if rt.Systemd != nil {
		return rt.Systemd
	}
	return api.NewSystemdHandlerStub("systemd subsystem not initialised on this gateway — " +
		"the binary may predate the service-management feature; rebuild from latest source")
}

// opsStubReason is the shared 503 message for the Wave 1-3 ops modules when the
// gateway binary predates them.
const opsStubReason = "ops subsystem not initialised on this gateway — rebuild from latest source"

func processHandler(rt *Routes) *api.ProcessHandler {
	if rt.Process != nil {
		return rt.Process
	}
	return api.NewProcessHandlerStub(opsStubReason)
}
func perfHandler(rt *Routes) *api.PerfHandler {
	if rt.Perf != nil {
		return rt.Perf
	}
	return api.NewPerfHandlerStub(opsStubReason)
}
func logsHandler(rt *Routes) *api.LogsHandler {
	if rt.Logs != nil {
		return rt.Logs
	}
	return api.NewLogsHandlerStub(opsStubReason)
}
func hardwareHandler(rt *Routes) *api.HardwareHandler {
	if rt.Hardware != nil {
		return rt.Hardware
	}
	return api.NewHardwareHandlerStub(opsStubReason)
}
func kernelHandler(rt *Routes) *api.KernelHandler {
	if rt.Kernel != nil {
		return rt.Kernel
	}
	return api.NewKernelHandlerStub(opsStubReason)
}
func storageHandler(rt *Routes) *api.StorageHandler {
	if rt.Storage != nil {
		return rt.Storage
	}
	return api.NewStorageHandlerStub(opsStubReason)
}
func nettoolsHandler(rt *Routes) *api.NetToolsHandler {
	if rt.NetTools != nil {
		return rt.NetTools
	}
	return api.NewNetToolsHandlerStub(opsStubReason)
}
func cronHandler(rt *Routes) *api.CronHandler {
	if rt.Cron != nil {
		return rt.Cron
	}
	return api.NewCronHandlerStub(opsStubReason)
}
func wireguardHandler(rt *Routes) *api.WireGuardHandler {
	if rt.WireGuard != nil {
		return rt.WireGuard
	}
	return api.NewWireGuardHandlerStub(opsStubReason)
}
func filesHandler(rt *Routes) *api.FilesHandler {
	if rt.Files != nil {
		return rt.Files
	}
	return api.NewFilesHandlerStub(opsStubReason)
}
func loganalyticsHandler(rt *Routes) *api.LogAnalyticsHandler {
	if rt.LogAnalytics != nil {
		return rt.LogAnalytics
	}
	return api.NewLogAnalyticsHandlerStub(opsStubReason)
}
func backupHandler(rt *Routes) *api.BackupHandler {
	if rt.Backup != nil {
		return rt.Backup
	}
	return api.NewBackupHandlerStub(opsStubReason)
}
func captureHandler(rt *Routes) *api.CaptureHandler {
	if rt.Capture != nil {
		return rt.Capture
	}
	return api.NewCaptureHandlerStub(opsStubReason)
}
func pkgHandler(rt *Routes) *api.PkgHandler {
	if rt.Pkg != nil {
		return rt.Pkg
	}
	return api.NewPkgHandlerStub(opsStubReason)
}
func sysuserHandler(rt *Routes) *api.SysUserHandler {
	if rt.SysUser != nil {
		return rt.SysUser
	}
	return api.NewSysUserHandlerStub(opsStubReason)
}
func secauditHandler(rt *Routes) *api.SecAuditHandler {
	if rt.SecAudit != nil {
		return rt.SecAudit
	}
	return api.NewSecAuditHandlerStub(opsStubReason)
}

// insightsHandler returns rt.Insights if non-nil, else a stub that always
// responds 503. Lets us register routes unconditionally so missing /
// stale config never manifests as a 404.
func insightsHandler(rt *Routes) *insights.Handler {
	if rt.Insights != nil {
		return rt.Insights
	}
	return insights.NewHandler(nil)
}

// Plan 17 — same pattern for the desktop control / WS handlers. When the
// subsystem is disabled the stub returns 503 from its own gate logic.
func desktopControl(rt *Routes) *desktop.ControlHandler {
	if rt.DesktopControl != nil {
		return rt.DesktopControl
	}
	return desktop.NewControlHandler(nil)
}
func desktopWS(rt *Routes) *desktop.WSHandler {
	if rt.DesktopWS != nil {
		return rt.DesktopWS
	}
	return desktop.NewWSHandler(nil, nil)
}

type Routes struct {
	Auth          *api.AuthHandler
	Node          *api.NodeHandler
	Proxy         *api.ProxyHandler
	Domain        *api.DomainHandler
	Agent         *api.AgentHandler
	AgentDownload *api.AgentDownloadHandler
	PKI           *api.PKIHandler
	// WriteRateLimiter throttles per-user state-changing requests (overload
	// guard §11). Nil disables the middleware.
	WriteRateLimiter *guard.RateLimiter
	// Prometheus exposes /metrics (§16). Nil disables the endpoint.
	Prometheus    *api.PrometheusHandler
	ChainTemplate *api.ChainTemplateHandler
	ProxyGroup    *api.ProxyGroupHandler
	ProxyHealth   *api.HealthHandler
	ProxyMetrics  *api.MetricsHandler
	Cred          *api.CredentialHandler
	Session       *api.SessionHandler
	Audit         *api.AuditHandler
	SFTP          *sftp.Handler
	OSS           *oss.Handler
	WS            *webssh.Gateway
	Guacamole     *guacamole.Handler
	DBCLI         *dbcli.Handler
	TCPFwd        *tcpfwd.Handler
	TCPRelay      *tcpfwd.WSRelay
	TCPEvents     *tcpfwd.WSEvents
	Issuer        *auth.Issuer
	Blocklist     *auth.Blocklist
	Resolver      *auth.Resolver

	// New surfaces.
	User       *api.UserHandler
	Role       *api.RoleHandler
	Dept       *api.DepartmentHandler
	Group      *api.GroupHandler
	AssetGroup *api.AssetGroupHandler
	Tag        *api.TagHandler
	TagGroup   *api.TagGroupHandler
	Grant      *api.GrantHandler
	AccessTree *api.AccessTreeHandler
	Me         *api.MeHandler
	Dashboard  *api.DashboardHandler
	OIDCClient *api.OIDCClientHandler

	// In-app notification center (security alerts + system notices). Nil disables
	// the /me/notifications routes.
	Notifications *api.NotificationHandler
	// Security center — anomalous-login list/stats + GeoIP DB status/refresh.
	// Nil disables the /admin/security routes.
	Security *api.SecurityHandler

	AI *ai.Set

	// Phase 11 — terminal personalization (snippets, command history,
	// synced profile). All gated on the standard user auth middleware.
	Snippet         *api.SnippetHandler
	CommandHistory  *api.CommandHistoryHandler
	TerminalProfile *api.TerminalProfileHandler

	// Phase 12 — SSH power features (user-scoped).
	SSHKey    *api.SSHKeysHandler
	KnownHost *api.KnownHostsHandler
	BulkRun   *api.BulkRunHandler

	// Plan 14 — per-node live system telemetry served on the SSH page.
	Insights *insights.Handler

	// Plan 17 — new RDP/desktop backend (FreeRDP worker subprocess +
	// custom browser viewer). When set the gateway exposes the
	// /desktop/sessions REST control plane and the /ws/v2/desktop/:id
	// WebSocket data plane alongside the legacy guacd routes.
	DesktopControl *desktop.ControlHandler
	DesktopWS      *desktop.WSHandler
	// DesktopDrive serves the per-user file drive that's redirected into RDP
	// sessions (list / upload / download / delete / mkdir).
	DesktopDrive *desktop.DriveHandler

	// Workspace v2 — server-management panels (firewall, docker, systemd)
	// that run SSH commands on the managed node.
	Firewall     *api.FirewallHandler
	Docker       *api.DockerHandler
	Systemd      *api.SystemdHandler
	Process      *api.ProcessHandler
	Perf         *api.PerfHandler
	Logs         *api.LogsHandler
	Hardware     *api.HardwareHandler
	Kernel       *api.KernelHandler
	Storage      *api.StorageHandler
	NetTools     *api.NetToolsHandler
	Cron         *api.CronHandler
	Pkg          *api.PkgHandler
	SysUser      *api.SysUserHandler
	SecAudit     *api.SecAuditHandler
	WireGuard    *api.WireGuardHandler
	Files        *api.FilesHandler
	LogAnalytics *api.LogAnalyticsHandler
	Backup       *api.BackupHandler
	Capture      *api.CaptureHandler

	// Phase 14 — KMS provider setup wizard. Admin-only endpoints
	// under /api/v1/setup/kms/*.
	KMS *api.KMSHandler

	// Edition / licensing. Provider feeds the per-feature route gates (feat());
	// EditionAPI serves /me/edition + the super-admin install/remove surface.
	// In the open-source build this is the Community provider (grants nothing).
	Edition    edition.Provider
	EditionAPI *api.EditionHandler

	// Access control — the consolidated 访问控制 rule module (CRUD over the unified
	// AccessRule model: command_filter / user_login / asset_connection_review /
	// data_masking / connection_method). Nil disables the admin CRUD routes.
	AccessRule *api.AccessRuleHandler

	// System settings — DB-backed runtime configuration center. Super-admin
	// only (gated with the system:admin permission). Nil when not wired.
	Settings *api.SettingsHandler

	// Watermark — per-user anti-leak watermark payload, readable by every
	// authenticated user (reads the live settings snapshot). Nil when not wired.
	Watermark *api.WatermarkHandler

	// Phase 15 — Approval Service surface. Nil when the subsystem is
	// disabled (the routes are still registered and return 503 stubs the
	// same way insights/firewall do).
	Approval *api.ApprovalHandler

	// Break-glass (应急访问) — emergency-access governance over the approval
	// engine. Nil when unwired; every handler degrades to 503.
	BreakGlass *api.BreakGlassHandler

	// Phase 17 — visual DB browser. Backs the structured schema /
	// table-rows / SQL editor UI; complements the legacy /ws/dbcli
	// terminal which stays for operators who want a literal psql/mysql
	// shell.
	DB *api.DBHandler

	// Phase 1 — cross-subproject Db Studio. parse-uri is live (pure URI
	// parser, no DB round-trip); the ER-model surface stubs to 501 until
	// its sub-project plan ships concrete persistence. Nil-safe like the
	// other handlers — routes mount only when wired.
	DbStudio *api.DBStudioHandler
}

func (rt *Routes) Mount(r *gin.Engine) {
	// NOTE: the reverse-connect agent control plane (/agent/v1/{enroll,renew,
	// tunnel}) is NOT mounted here. It runs on a dedicated mTLS listener stood up
	// in main.go (cfg.Agent.Addr) so the gateway can terminate TLS itself and
	// verify agent client certificates — see AgentGatewayHandler.MountAgentTLS.

	// Prometheus scrape endpoint at the root (no JWT — guarded by its own bearer
	// token when configured). §16.
	if rt.Prometheus != nil {
		r.GET("/metrics", rt.Prometheus.Metrics)
	}

	// Reverse-connect agent binary + install script (security-architecture.md
	// §14). Unauthenticated by design — the binary is not a secret; enrollment is
	// gated by the one-time token and the pending→activate human check. Returns
	// 503 until binaries are staged (scripts/build-agent.sh → agent.dist_dir).
	if rt.AgentDownload != nil {
		r.GET("/dl/gateway-agent", rt.AgentDownload.Binary)
		r.GET("/dl/gateway-agent.sh", rt.AgentDownload.Script)
	}

	v1 := r.Group("/api/v1")
	{
		ag := v1.Group("/auth")
		ag.POST("/login", rt.Auth.Login)
		ag.POST("/login/totp", rt.Auth.LoginTOTP)
		ag.POST("/login/email-otp/send", rt.Auth.LoginEmailOTPSend)
		ag.POST("/login/email-otp", rt.Auth.LoginEmailOTP)
		ag.POST("/login/recovery", rt.Auth.LoginRecovery)
		ag.POST("/login/passkey/begin", rt.Auth.PasskeyBegin)
		ag.POST("/login/passkey/finish", rt.Auth.PasskeyFinish)
		ag.POST("/refresh", rt.Auth.Refresh)
		ag.GET("/anonymous/info", rt.Auth.AnonymousInfo)
		ag.POST("/anonymous", rt.Auth.Anonymous)
		ag.GET("/providers", rt.Auth.Providers)
		ag.GET("/oidc/:provider/login", rt.Auth.OIDCLogin)
		ag.GET("/oidc/:provider/callback", rt.Auth.OIDCCallback)
	}
	mw := auth.MiddlewareWith(auth.MiddlewareDeps{
		Issuer:    rt.Issuer,
		Blocklist: rt.Blocklist,
	})
	perm := func(p string) gin.HandlerFunc { return auth.RequirePermission(p, rt.Resolver) }
	// feat gates a route on an edition feature (independent of RBAC — even a
	// super-admin is blocked when the feature isn't licensed). A nil Authority
	// allows through, so an un-licensed build behaves exactly as before.
	feat := func(f string) gin.HandlerFunc { return edition.RequireFeature(f, rt.Edition) }

	// OnlyOffice Document Server callbacks — authorized by the signed
	// per-document token in ?t=, not the user JWT (the Document Server pulls
	// files and posts saves with no user session of its own).
	officeGroup := v1.Group("/office")
	{
		officeGroup.GET("/nodes/:id/sftp/file", rt.SFTP.OfficeFile)
		officeGroup.POST("/nodes/:id/sftp/callback", rt.SFTP.OfficeCallback)
		officeGroup.GET("/nodes/:id/oss/file", rt.OSS.OfficeFile)
		officeGroup.POST("/nodes/:id/oss/callback", rt.OSS.OfficeCallback)
	}

	authed := v1.Group("")
	authed.Use(mw)
	// Overload guard — per-user write-rate limit on state-changing requests.
	authed.Use(writeRateLimit(rt.WriteRateLimiter))
	{
		// Logout — any authenticated session.
		authed.POST("/auth/logout", rt.Auth.Logout)

		// /me self-service
		me := authed.Group("/me")
		me.GET("/profile", rt.Me.Profile)
		if rt.Watermark != nil {
			me.GET("/watermark", rt.Watermark.Get)
		}
		me.PATCH("/profile", rt.Me.UpdateProfile)
		me.POST("/password", rt.Me.ChangePassword)
		me.GET("/mfa", rt.Me.ListMFA)
		me.POST("/mfa/totp/begin", rt.Me.BeginTOTP)
		me.POST("/mfa/totp/finish", rt.Me.FinishTOTP)
		me.DELETE("/mfa/:id", rt.Me.DeleteMFA)
		me.POST("/mfa/recovery-codes/regenerate", rt.Me.RegenerateRecoveryCodes)
		me.GET("/passkeys", rt.Me.ListPasskeys)
		me.POST("/passkeys/register/begin", rt.Me.BeginPasskeyRegister)
		me.POST("/passkeys/register/finish", rt.Me.FinishPasskeyRegister)
		me.DELETE("/passkeys/:id", rt.Me.DeletePasskey)
		me.GET("/favorites", rt.Me.ListFavorites)
		me.POST("/favorites/:node_id", rt.Me.AddFavorite)
		me.DELETE("/favorites/:node_id", rt.Me.RemoveFavorite)
		me.GET("/recent-nodes", rt.Me.RecentNodes)
		me.GET("/login-history", rt.Me.LoginHistory)
		// In-app notification center (security alerts + system notices).
		if rt.Notifications != nil {
			me.GET("/notifications", rt.Notifications.List)
			me.GET("/notifications/unread-count", rt.Notifications.UnreadCount)
			me.GET("/notifications/stream", rt.Notifications.Stream)
			me.POST("/notifications/read-all", rt.Notifications.MarkAllRead)
			me.POST("/notifications/:id/read", rt.Notifications.MarkRead)
			me.DELETE("/notifications/:id", rt.Notifications.Delete)
		}
		me.GET("/nodes", rt.Me.VisibleNodes)
		me.GET("/directory", rt.AccessTree.MyDirectory)
		me.GET("/access", rt.Dashboard.Access)
		// Edition / entitlements — readable by every authenticated user (no
		// secrets); the frontend reads this to gate nav + show an upsell banner.
		if rt.EditionAPI != nil {
			me.GET("/edition", rt.EditionAPI.Get)
		}

		// Phase 11 — terminal personalization. User-scoped (no admin
		// perm needed): every authenticated user manages their own
		// snippets / history / profile.
		me.GET("/snippets", rt.Snippet.List)
		me.POST("/snippets", rt.Snippet.Create)
		me.PATCH("/snippets/:id", rt.Snippet.Update)
		me.DELETE("/snippets/:id", rt.Snippet.Delete)
		me.POST("/snippets/:id/use", rt.Snippet.Use)
		me.GET("/command-history", rt.CommandHistory.List)
		me.POST("/command-history", rt.CommandHistory.Record)
		me.DELETE("/command-history", rt.CommandHistory.Clear)
		me.GET("/terminal-profile", rt.TerminalProfile.Get)
		me.PATCH("/terminal-profile", rt.TerminalProfile.Set)

		// Phase 12 — SSH power: keys / known hosts / bulk run.
		me.GET("/ssh-keys", rt.SSHKey.List)
		me.POST("/ssh-keys", rt.SSHKey.Create)
		me.PATCH("/ssh-keys/:id", rt.SSHKey.Update)
		me.DELETE("/ssh-keys/:id", rt.SSHKey.Delete)
		me.GET("/known-hosts", rt.KnownHost.List)
		me.POST("/known-hosts", rt.KnownHost.Create)
		me.PATCH("/known-hosts/:id", rt.KnownHost.Update)
		me.DELETE("/known-hosts/:id", rt.KnownHost.Delete)
		me.GET("/bulk-runs", rt.BulkRun.List)
		me.POST("/bulk-runs", rt.BulkRun.Run)
		me.GET("/bulk-runs/:id", rt.BulkRun.Get)
		me.DELETE("/bulk-runs/:id", rt.BulkRun.Delete)

		// Asset catalogue — read-only for every authenticated user. The
		// workspace tree needs the full group/tag taxonomy to render
		// "by group" / "by tag" views even for non-admins; mutations
		// remain admin-locked further down.
		authed.GET("/asset-groups", rt.AssetGroup.List)
		authed.GET("/tags", rt.Tag.List)
		authed.GET("/tag-groups", rt.TagGroup.List)
		authed.GET("/dashboard", rt.Dashboard.Summary)

		// Admin: users / roles / orgs
		admin := authed.Group("")
		admin.GET("/users", perm(auth.PermUserManage), rt.User.List)
		admin.GET("/users/stats", perm(auth.PermUserManage), rt.User.Stats)
		admin.POST("/users", perm(auth.PermUserManage), rt.User.Create)
		admin.POST("/users/bulk", perm(auth.PermUserManage), rt.User.Bulk)
		admin.GET("/users/:id", perm(auth.PermUserManage), rt.User.Detail)
		admin.PATCH("/users/:id", perm(auth.PermUserManage), rt.User.Update)
		admin.DELETE("/users/:id", perm(auth.PermUserManage), rt.User.Delete)
		admin.POST("/users/:id/reset-password", perm(auth.PermUserManage), rt.User.ResetPassword)
		admin.POST("/users/:id/unlock", perm(auth.PermUserManage), rt.User.Unlock)
		admin.POST("/users/:id/force-logout", perm(auth.PermUserManage), rt.User.ForceLogout)
		admin.GET("/users/:id/roles", perm(auth.PermUserManage), rt.User.ListRoles)
		admin.PUT("/users/:id/roles", perm(auth.PermUserManage), rt.User.ReplaceRoles)
		admin.PUT("/users/:id/tags", perm(auth.PermUserManage), rt.User.SetTags)

		admin.GET("/roles", perm(auth.PermRoleManage), rt.Role.List)
		admin.POST("/roles", perm(auth.PermRoleManage), rt.Role.Create)
		admin.PATCH("/roles/:id", perm(auth.PermRoleManage), rt.Role.Update)
		admin.DELETE("/roles/:id", perm(auth.PermRoleManage), rt.Role.Delete)
		admin.GET("/permissions", perm(auth.PermRoleManage), rt.Role.Permissions)

		admin.GET("/departments", perm(auth.PermDeptManage), rt.Dept.List)
		admin.GET("/departments/tree", perm(auth.PermDeptManage), rt.Dept.Tree)
		admin.POST("/departments", perm(auth.PermDeptManage), rt.Dept.Create)
		admin.PATCH("/departments/:id", perm(auth.PermDeptManage), rt.Dept.Update)
		admin.PUT("/departments/:id/parent", perm(auth.PermDeptManage), rt.Dept.Move)
		admin.DELETE("/departments/:id", perm(auth.PermDeptManage), rt.Dept.Delete)
		admin.GET("/departments/:id/members", perm(auth.PermDeptManage), rt.Dept.Members)
		admin.POST("/departments/:id/members", perm(auth.PermDeptManage), rt.Dept.AddMember)
		admin.DELETE("/departments/:id/members/:uid", perm(auth.PermDeptManage), rt.Dept.RemoveMember)

		admin.GET("/groups", perm(auth.PermGroupManage), rt.Group.List)
		admin.POST("/groups", perm(auth.PermGroupManage), rt.Group.Create)
		admin.PATCH("/groups/:id", perm(auth.PermGroupManage), rt.Group.Update)
		admin.PUT("/groups/:id/parent", perm(auth.PermGroupManage), rt.Group.Move)
		admin.DELETE("/groups/:id", perm(auth.PermGroupManage), rt.Group.Delete)
		admin.GET("/groups/:id/members", perm(auth.PermGroupManage), rt.Group.Members)
		admin.POST("/groups/:id/members", perm(auth.PermGroupManage), rt.Group.AddMember)
		admin.DELETE("/groups/:id/members/:uid", perm(auth.PermGroupManage), rt.Group.RemoveMember)

		// Assets
		admin.GET("/nodes", perm(auth.PermNodeList), rt.Node.List)
		admin.POST("/nodes", perm(auth.PermNodeCreate), rt.Node.Create)
		admin.GET("/nodes/:id", perm(auth.PermNodeRead), rt.Node.Get)
		admin.PATCH("/nodes/:id", perm(auth.PermNodeUpdate), rt.Node.Update)
		admin.DELETE("/nodes/:id", perm(auth.PermNodeDelete), rt.Node.Delete)
		admin.POST("/nodes/:id/test", perm(auth.PermNodeRead), rt.Node.Test)
		// Bulk enable/disable from the asset tree's batch bar.
		admin.POST("/nodes/batch/enable", perm(auth.PermNodeUpdate), rt.Node.BatchEnable)
		admin.POST("/nodes/batch/disable", perm(auth.PermNodeUpdate), rt.Node.BatchDisable)
		// OSS "test & discover": list buckets for a provider/endpoint +
		// credential during node creation so the admin can visually pick a
		// default bucket. Gated by node-create (no per-node grant yet).
		if rt.OSS != nil {
			admin.POST("/oss/discover", perm(auth.PermNodeCreate), rt.OSS.Discover)
		}
		admin.GET("/proxies", perm(auth.PermProxyManage), rt.Proxy.List)
		admin.POST("/proxies", perm(auth.PermProxyManage), rt.Proxy.Create)
		admin.PATCH("/proxies/:id", perm(auth.PermProxyManage), rt.Proxy.Update)
		admin.DELETE("/proxies/:id", perm(auth.PermProxyManage), rt.Proxy.Delete)
		// Network domains — connectivity source of truth (security-architecture.md §3).
		if rt.Domain != nil {
			admin.GET("/domains", perm(auth.PermDomainManage), rt.Domain.List)
			admin.POST("/domains", perm(auth.PermDomainManage), rt.Domain.Create)
			admin.PATCH("/domains/:id", perm(auth.PermDomainManage), rt.Domain.Update)
			admin.DELETE("/domains/:id", perm(auth.PermDomainManage), rt.Domain.Delete)
		}
		// Reverse-connect Gateway Agents — admin lifecycle (security-architecture.md §4).
		// Reverse-connect Gateway Agents — Enterprise feature (reverse_agent).
		if rt.Agent != nil {
			ra := admin.Group("", feat(edition.FeatureReverseAgent))
			ra.GET("/domains/:id/agents", perm(auth.PermAgentManage), rt.Agent.List)
			ra.POST("/domains/:id/agents/enroll-token", perm(auth.PermAgentManage), rt.Agent.GenerateEnrollToken)
			ra.POST("/agents/:agentId/activate", perm(auth.PermAgentManage), rt.Agent.Activate)
			ra.POST("/agents/:agentId/revoke", perm(auth.PermAgentManage), rt.Agent.Revoke)
			ra.DELETE("/agents/:agentId", perm(auth.PermAgentManage), rt.Agent.Delete)
			// Agent面 status + install-command composition for the console.
			ra.GET("/agent-gateway/info", perm(auth.PermAgentManage), rt.Agent.Info)
		}
		// Internal PKI — CA metadata + issued-cert ledger (security-architecture.md §6).
		// Part of the reverse_agent feature (the agents' mTLS trust root).
		if rt.PKI != nil {
			rp := admin.Group("", feat(edition.FeatureReverseAgent))
			rp.GET("/pki/ca", perm(auth.PermPKIManage), rt.PKI.CA)
			rp.GET("/pki/certificates", perm(auth.PermPKIManage), rt.PKI.Certificates)
			rp.POST("/pki/certificates/:serial/revoke", perm(auth.PermPKIManage), rt.PKI.Revoke)
		}
		// Phase 10 — proxy chain validate / test / templates.
		admin.POST("/proxies/chains/validate", perm(auth.PermProxyManage), rt.Proxy.ValidateChain)
		admin.POST("/proxies/chains/test", perm(auth.PermProxyManage), rt.Proxy.TestChain)
		admin.GET("/proxies/chain-templates", perm(auth.PermProxyManage), rt.ChainTemplate.List)
		admin.POST("/proxies/chain-templates", perm(auth.PermProxyManage), rt.ChainTemplate.Create)
		admin.PATCH("/proxies/chain-templates/:id", perm(auth.PermProxyManage), rt.ChainTemplate.Update)
		admin.DELETE("/proxies/chain-templates/:id", perm(auth.PermProxyManage), rt.ChainTemplate.Delete)
		// Live health — background prober snapshot + SSE stream + on-demand probe.
		if rt.ProxyHealth != nil {
			admin.GET("/proxies/health", perm(auth.PermProxyManage), rt.ProxyHealth.Snapshot)
			admin.GET("/proxies/health/stream", perm(auth.PermProxyManage), rt.ProxyHealth.Stream)
			admin.POST("/proxies/health/probe", perm(auth.PermProxyManage), rt.ProxyHealth.ProbeNow)
		}
		// Connection metrics — in-memory snapshot + SSE stream.
		if rt.ProxyMetrics != nil {
			admin.GET("/proxies/metrics", perm(auth.PermProxyManage), rt.ProxyMetrics.Snapshot)
			admin.GET("/proxies/metrics/stream", perm(auth.PermProxyManage), rt.ProxyMetrics.Stream)
		}
		// Failover-group membership (the all-in-one path is POST/PATCH /proxies).
		if rt.ProxyGroup != nil {
			admin.GET("/proxies/:id/members", perm(auth.PermProxyManage), rt.ProxyGroup.Members)
			admin.PUT("/proxies/:id/members", perm(auth.PermProxyManage), rt.ProxyGroup.SetMembers)
			admin.DELETE("/proxies/:id/members/:mid", perm(auth.PermProxyManage), rt.ProxyGroup.RemoveMember)
		}
		admin.GET("/credentials", perm(auth.PermCredentialManage), rt.Cred.List)
		admin.POST("/credentials", perm(auth.PermCredentialManage), rt.Cred.Create)
		admin.PATCH("/credentials/:id", perm(auth.PermCredentialManage), rt.Cred.Update)
		admin.DELETE("/credentials/:id", perm(auth.PermCredentialManage), rt.Cred.Delete)
		admin.GET("/credentials/:id/usage", perm(auth.PermCredentialManage), rt.Cred.Usage)
		admin.POST("/credentials/:id/test", perm(auth.PermCredentialManage), rt.Cred.Test)
		// asset-groups / tags read routes moved up to authed (catalogue).
		admin.POST("/asset-groups", perm(auth.PermAssetGroupManage), rt.AssetGroup.Create)
		admin.PATCH("/asset-groups/:id", perm(auth.PermAssetGroupManage), rt.AssetGroup.Update)
		admin.PUT("/asset-groups/:id/parent", perm(auth.PermAssetGroupManage), rt.AssetGroup.Move)
		admin.DELETE("/asset-groups/:id", perm(auth.PermAssetGroupManage), rt.AssetGroup.Delete)
		admin.POST("/asset-groups/:id/nodes", perm(auth.PermAssetGroupManage), rt.AssetGroup.AddNode)
		admin.DELETE("/asset-groups/:id/nodes/:nid", perm(auth.PermAssetGroupManage), rt.AssetGroup.RemoveNode)
		// Bulk membership for the asset tree (drag many / batch "加入·移出分组").
		admin.POST("/asset-groups/:id/nodes/batch", perm(auth.PermAssetGroupManage), rt.AssetGroup.AddNodesBatch)
		admin.DELETE("/asset-groups/:id/nodes/batch", perm(auth.PermAssetGroupManage), rt.AssetGroup.RemoveNodesBatch)
		admin.POST("/tags", perm(auth.PermTagManage), rt.Tag.Create)
		admin.PATCH("/tags/:id", perm(auth.PermTagManage), rt.Tag.Update)
		admin.DELETE("/tags/:id", perm(auth.PermTagManage), rt.Tag.Delete)
		// Tag groups (namespaces / categories).
		admin.POST("/tag-groups", perm(auth.PermTagManage), rt.TagGroup.Create)
		admin.PATCH("/tag-groups/:id", perm(auth.PermTagManage), rt.TagGroup.Update)
		admin.DELETE("/tag-groups/:id", perm(auth.PermTagManage), rt.TagGroup.Delete)
		// Node ↔ tag wiring: granular attach/detach, plus a full replace (the
		// tag-picker save path).
		admin.POST("/nodes/:id/tags", perm(auth.PermTagManage), rt.Tag.Attach)
		admin.PUT("/nodes/:id/tags", perm(auth.PermTagManage), rt.Tag.Replace)
		admin.DELETE("/nodes/:id/tags/:tid", perm(auth.PermTagManage), rt.Tag.Detach)
		// Bulk: put / pull one tag on many nodes (asset tree batch 打·去标签).
		admin.POST("/tags/:id/nodes/batch", perm(auth.PermTagManage), rt.Tag.AttachBatch)
		admin.DELETE("/tags/:id/nodes/batch", perm(auth.PermTagManage), rt.Tag.DetachBatch)
		admin.GET("/asset-grants", perm(auth.PermGrantManage), rt.Grant.List)
		admin.POST("/asset-grants", perm(auth.PermGrantManage), rt.Grant.Create)
		admin.POST("/asset-grants/batch", perm(auth.PermGrantManage), rt.Grant.CreateBatch)
		admin.DELETE("/asset-grants/:id", perm(auth.PermGrantManage), rt.Grant.Delete)
		// 访问策略透视：按人看（穿透解析）/ 按资产看（谁能访问）。
		admin.GET("/access/by-grantee", perm(auth.PermGrantManage), rt.Grant.ByGrantee)
		admin.GET("/access/by-subject", perm(auth.PermGrantManage), rt.Grant.BySubject)

		// 授权目录：按对象(用户/用户组/部门)编辑其专属资产树，树即授权。
		// 与散列授权统一在 grant:manage 权限下。
		admin.GET("/access-tree", perm(auth.PermGrantManage), rt.AccessTree.Get)
		admin.POST("/access-tree/folders", perm(auth.PermGrantManage), rt.AccessTree.CreateFolder)
		admin.PATCH("/access-tree/folders/:id", perm(auth.PermGrantManage), rt.AccessTree.UpdateFolder)
		admin.PUT("/access-tree/folders/:id/parent", perm(auth.PermGrantManage), rt.AccessTree.MoveFolder)
		admin.DELETE("/access-tree/folders/:id", perm(auth.PermGrantManage), rt.AccessTree.DeleteFolder)
		admin.POST("/access-tree/items", perm(auth.PermGrantManage), rt.AccessTree.AddItems)
		admin.PATCH("/access-tree/items/:id", perm(auth.PermGrantManage), rt.AccessTree.UpdateItem)
		admin.DELETE("/access-tree/items/:id", perm(auth.PermGrantManage), rt.AccessTree.DeleteItem)
		admin.POST("/access-tree/folders/:id/apply-subtree", perm(auth.PermGrantManage), rt.AccessTree.ApplySubtree)
		admin.POST("/access-tree/clone", perm(auth.PermGrantManage), rt.AccessTree.Clone)
		admin.POST("/access-tree/reorder", perm(auth.PermGrantManage), rt.AccessTree.Reorder)
		admin.GET("/access-templates", perm(auth.PermGrantManage), rt.AccessTree.ListTemplates)
		admin.POST("/access-templates", perm(auth.PermGrantManage), rt.AccessTree.CreateTemplate)
		admin.DELETE("/access-templates/:id", perm(auth.PermGrantManage), rt.AccessTree.DeleteTemplate)

		// OIDC client management
		if rt.OIDCClient != nil {
			admin.GET("/oidc-clients", perm(auth.PermOIDCManage), rt.OIDCClient.List)
			admin.POST("/oidc-clients", perm(auth.PermOIDCManage), rt.OIDCClient.Create)
			admin.PATCH("/oidc-clients/:id", perm(auth.PermOIDCManage), rt.OIDCClient.Update)
			admin.DELETE("/oidc-clients/:id", perm(auth.PermOIDCManage), rt.OIDCClient.Delete)
		}

		// Edition / licensing — super-admin install/remove + admin view.
		if rt.EditionAPI != nil {
			eg := admin.Group("/edition", perm(auth.PermSystemAdmin))
			eg.GET("", rt.EditionAPI.AdminGet)
			eg.POST("/license", rt.EditionAPI.Install)
			eg.DELETE("/license", rt.EditionAPI.Remove)
		}

		// Access control — consolidated 访问控制 rule CRUD. One permission gates all
		// five rule kinds; X-Pack kinds are additionally edition-gated in the
		// handler (and hidden in the UI without the feature).
		if rt.AccessRule != nil {
			acg := admin.Group("/access-rules", perm(auth.PermAccessControlManage))
			acg.GET("", rt.AccessRule.List)
			acg.POST("", rt.AccessRule.Create)
			acg.PATCH("/:id", rt.AccessRule.Update)
			acg.DELETE("/:id", rt.AccessRule.Delete)
		}

		// System settings — DB-backed runtime configuration center. Gated on
		// system:admin (super-admin only): these knobs reshape auth policy,
		// secret handling and every protocol gateway.
		if rt.Settings != nil {
			sg := admin.Group("/settings", perm(auth.PermSystemAdmin))
			sg.GET("/schema", rt.Settings.Schema)
			sg.POST("", rt.Settings.Update)
			sg.POST("/reset", rt.Settings.Reset)
			sg.GET("/integrations", rt.Settings.Integrations)
			sg.POST("/integrations/:id/test", rt.Settings.TestIntegration)
			sg.GET("/audits", rt.Settings.Audits)
		}

		// Operational: sessions, SFTP, WS endpoints
		ops := authed.Group("")
		ops.Use(auth.RejectAnonymous())
		ops.GET("/sessions", perm(auth.PermSessionList), rt.Session.List)
		ops.GET("/sessions/stats", perm(auth.PermSessionList), rt.Session.Stats)
		ops.GET("/sessions/:id", perm(auth.PermSessionRead), rt.Session.Get)
		ops.GET("/sessions/:id/audit", perm(auth.PermSessionRead), rt.Session.AuditTimeline)
		// Lifecycle v3 — connection-stage timeline + connection-quality samples.
		ops.GET("/sessions/:id/phases", perm(auth.PermSessionRead), rt.Session.Phases)
		ops.GET("/sessions/:id/metrics", perm(auth.PermSessionRead), rt.Session.Metrics)
		ops.GET("/sessions/:id/lifecycle", perm(auth.PermSessionRead), rt.Session.Lifecycle)
		ops.POST("/sessions/:id/terminate", perm(auth.PermSessionTerminate), rt.Session.Terminate)
		ops.GET("/sessions/:id/recording", perm(auth.PermSessionRead), rt.Session.Recording)
		ops.GET("/sessions/:id/cast", perm(auth.PermSessionRead), rt.Session.Recording)

		// Audit center — global trail across every subsystem. Read-gated on
		// audit:read (the `auditor` role + super-admins hold it).
		if rt.Audit != nil {
			ops.GET("/audit-logs", perm(auth.PermAuditRead), rt.Audit.List)
			ops.GET("/audit-logs/stats", perm(auth.PermAuditRead), rt.Audit.Stats)
			ops.GET("/audit-logs/stream", perm(auth.PermAuditRead), rt.Audit.Stream)
			ops.GET("/audit-logs/export", perm(auth.PermAuditRead), rt.Audit.Export)
			// M4 — tamper-evidence integrity report (hash-chain verify + checkpoints).
			ops.GET("/audit-logs/integrity", perm(auth.PermAuditRead), rt.Audit.Integrity)
		}

		// Security center — anomalous-login list/stats + GeoIP database status and
		// manual refresh. Reads gate on audit:read; the GeoIP refresh (outbound
		// download) gates on system:admin.
		// Security analytics (anomaly + GeoIP) — Enterprise feature.
		if rt.Security != nil {
			sec := ops.Group("", feat(edition.FeatureSecurityAnalytics))
			sec.GET("/admin/security/anomalies", perm(auth.PermAuditRead), rt.Security.ListAnomalies)
			sec.GET("/admin/security/anomalies/stats", perm(auth.PermAuditRead), rt.Security.AnomalyStats)
			sec.GET("/admin/security/geoip/status", perm(auth.PermAuditRead), rt.Security.GeoIPStatus)
			sec.POST("/admin/security/geoip/refresh", perm(auth.PermSystemAdmin), rt.Security.GeoIPRefresh)
		}
		ops.GET("/nodes/:id/sftp/ls", rt.SFTP.List)
		ops.GET("/nodes/:id/sftp/stat", rt.SFTP.Stat)
		ops.POST("/nodes/:id/sftp/mkdir", rt.SFTP.Mkdir)
		ops.DELETE("/nodes/:id/sftp/rm", rt.SFTP.Remove)
		ops.POST("/nodes/:id/sftp/upload", rt.SFTP.Upload)
		ops.GET("/nodes/:id/sftp/download", rt.SFTP.Download)
		ops.POST("/nodes/:id/sftp/rename", rt.SFTP.Rename)
		ops.POST("/nodes/:id/sftp/chmod", rt.SFTP.Chmod)
		ops.GET("/nodes/:id/sftp/read", rt.SFTP.ReadText)
		ops.POST("/nodes/:id/sftp/write", rt.SFTP.WriteText)
		ops.GET("/nodes/:id/sftp/search", rt.SFTP.Search)
		ops.POST("/nodes/:id/sftp/copy", rt.SFTP.Copy)
		ops.GET("/nodes/:id/sftp/archive", rt.SFTP.Archive)
		ops.GET("/nodes/:id/sftp/office/config", rt.SFTP.OfficeConfig)
		// Object-storage bastion (OSS): per-node grant checks live in the
		// handler (connect → browse/stat/stats, download → get/preview,
		// upload → put/mkdir/copy/delete). Writes also pass the approval gate.
		if rt.OSS != nil {
			ops.GET("/nodes/:id/oss/buckets", rt.OSS.Buckets)
			ops.GET("/nodes/:id/oss/objects", rt.OSS.Objects)
			ops.GET("/nodes/:id/oss/stat", rt.OSS.Stat)
			ops.GET("/nodes/:id/oss/download", rt.OSS.Download)
			ops.GET("/nodes/:id/oss/preview", rt.OSS.Preview)
			ops.GET("/nodes/:id/oss/stats", rt.OSS.Stats)
			ops.POST("/nodes/:id/oss/upload", rt.OSS.Upload)
			ops.POST("/nodes/:id/oss/mkdir", rt.OSS.Mkdir)
			ops.DELETE("/nodes/:id/oss/object", rt.OSS.Delete)
			ops.GET("/nodes/:id/oss/office/config", rt.OSS.OfficeConfig)
			ops.POST("/nodes/:id/oss/copy", rt.OSS.Copy)
		}
		// Plan 14 — system insights endpoints (sibling to SFTP, same auth).
		// Routes are ALWAYS registered. When the manager is disabled the
		// handler returns 503 with a structured body. This way a stale
		// config (no `insights:` section) doesn't manifest as a 404 from
		// gin's no-route fallback, which is impossible to distinguish on
		// the client side from "the deploy is one version behind".
		ops.GET("/nodes/:id/insights/system", insightsHandler(rt).System)
		ops.GET("/nodes/:id/insights/system/stream", insightsHandler(rt).SystemStream)
		ops.GET("/nodes/:id/insights/processes", insightsHandler(rt).Processes)
		ops.GET("/nodes/:id/insights/network", insightsHandler(rt).Network)
		// Workspace v2 — firewall & docker management. Reads are open to
		// any authenticated user with node access; mutations require the
		// matching :manage permission. 503 stubs when disabled.
		ops.GET("/nodes/:id/firewall/status", firewallHandler(rt).Status)
		ops.GET("/nodes/:id/firewall/status/stream", firewallHandler(rt).StatusStream)
		ops.GET("/nodes/:id/firewall/rules", firewallHandler(rt).ListRules)
		ops.GET("/nodes/:id/firewall/diagnose", firewallHandler(rt).Diagnose)
		ops.GET("/nodes/:id/firewall/conntrack", firewallHandler(rt).Conntrack)
		ops.GET("/nodes/:id/firewall/conntrack/stream", firewallHandler(rt).ConntrackStream)
		ops.GET("/nodes/:id/firewall/logs/stream", firewallHandler(rt).LogsStream)
		ops.GET("/nodes/:id/firewall/install/probe", firewallHandler(rt).ProbeInstall)
		ops.POST("/nodes/:id/firewall/install/stream", perm(auth.PermFirewallManage), firewallHandler(rt).InstallStream)
		ops.POST("/nodes/:id/firewall/fail2ban/install/stream", perm(auth.PermFirewallManage), firewallHandler(rt).InstallF2BStream)
		ops.GET("/nodes/:id/firewall/presets", firewallHandler(rt).Presets)
		ops.GET("/nodes/:id/firewall/templates", firewallHandler(rt).Templates)
		ops.GET("/nodes/:id/firewall/exposure", firewallHandler(rt).Exposure)
		ops.GET("/nodes/:id/firewall/export", firewallHandler(rt).Export)
		ops.POST("/nodes/:id/firewall/import/preview", perm(auth.PermFirewallManage), firewallHandler(rt).ImportPreview)
		ops.POST("/nodes/:id/firewall/apply", perm(auth.PermFirewallManage), firewallHandler(rt).SafeApply)
		ops.POST("/nodes/:id/firewall/commit", perm(auth.PermFirewallManage), firewallHandler(rt).CommitApply)
		ops.POST("/nodes/:id/firewall/rollback", perm(auth.PermFirewallManage), firewallHandler(rt).Rollback)
		ops.GET("/nodes/:id/firewall/fail2ban", firewallHandler(rt).Fail2ban)
		ops.GET("/nodes/:id/firewall/fail2ban/stream", firewallHandler(rt).Fail2banStream)
		ops.POST("/nodes/:id/firewall/fail2ban/ban", perm(auth.PermFirewallManage), firewallHandler(rt).F2BBan)
		ops.POST("/nodes/:id/firewall/fail2ban/unban", perm(auth.PermFirewallManage), firewallHandler(rt).F2BUnban)
		ops.POST("/nodes/:id/firewall/rules", perm(auth.PermFirewallManage), firewallHandler(rt).AddRule)
		ops.DELETE("/nodes/:id/firewall/rules/:index", perm(auth.PermFirewallManage), firewallHandler(rt).DeleteRule)
		ops.POST("/nodes/:id/firewall/rules/insert", perm(auth.PermFirewallManage), firewallHandler(rt).InsertRule)
		ops.PUT("/nodes/:id/firewall/rules/:index", perm(auth.PermFirewallManage), firewallHandler(rt).EditRule)
		ops.POST("/nodes/:id/firewall/rules/move", perm(auth.PermFirewallManage), firewallHandler(rt).MoveRule)
		ops.POST("/nodes/:id/firewall/rules/bulk-delete", perm(auth.PermFirewallManage), firewallHandler(rt).BulkDelete)
		ops.POST("/nodes/:id/firewall/persist", perm(auth.PermFirewallManage), firewallHandler(rt).Persist)
		ops.POST("/nodes/:id/firewall/enable", perm(auth.PermFirewallManage), firewallHandler(rt).Enable)
		ops.POST("/nodes/:id/firewall/disable", perm(auth.PermFirewallManage), firewallHandler(rt).Disable)
		ops.GET("/nodes/:id/docker/status", dockerHandler(rt).Status)
		ops.GET("/nodes/:id/docker/containers", dockerHandler(rt).ListContainers)
		ops.GET("/nodes/:id/docker/images", dockerHandler(rt).ListImages)
		ops.GET("/nodes/:id/docker/containers/:cid/logs", dockerHandler(rt).Logs)
		ops.POST("/nodes/:id/docker/containers/:cid/start", perm(auth.PermDockerManage), dockerHandler(rt).Start)
		ops.POST("/nodes/:id/docker/containers/:cid/stop", perm(auth.PermDockerManage), dockerHandler(rt).Stop)
		ops.POST("/nodes/:id/docker/containers/:cid/restart", perm(auth.PermDockerManage), dockerHandler(rt).Restart)
		ops.DELETE("/nodes/:id/docker/containers/:cid", perm(auth.PermDockerManage), dockerHandler(rt).Remove)
		// Docker — expanded: inspect / stats / top / networks / volumes + more verbs.
		ops.GET("/nodes/:id/docker/containers/:cid/inspect", dockerHandler(rt).Inspect)
		ops.GET("/nodes/:id/docker/containers/:cid/top", dockerHandler(rt).Top)
		ops.GET("/nodes/:id/docker/stats", dockerHandler(rt).Stats)
		ops.GET("/nodes/:id/docker/stats/stream", dockerHandler(rt).StatsStream)
		ops.GET("/nodes/:id/docker/networks", dockerHandler(rt).Networks)
		ops.GET("/nodes/:id/docker/volumes", dockerHandler(rt).Volumes)
		ops.POST("/nodes/:id/docker/containers/:cid/pause", perm(auth.PermDockerManage), dockerHandler(rt).Pause)
		ops.POST("/nodes/:id/docker/containers/:cid/unpause", perm(auth.PermDockerManage), dockerHandler(rt).Unpause)
		ops.POST("/nodes/:id/docker/containers/:cid/kill", perm(auth.PermDockerManage), dockerHandler(rt).Kill)
		ops.POST("/nodes/:id/docker/containers/:cid/rename", perm(auth.PermDockerManage), dockerHandler(rt).Rename)
		ops.POST("/nodes/:id/docker/images/pull", perm(auth.PermDockerManage), dockerHandler(rt).PullImage)
		ops.POST("/nodes/:id/docker/images/remove", perm(auth.PermDockerManage), dockerHandler(rt).RemoveImage)
		ops.POST("/nodes/:id/docker/prune", perm(auth.PermDockerManage), dockerHandler(rt).Prune)
		// Workspace ops dock — systemd service management. Reads gated by
		// ActionConnect; control actions by PermServiceManage.
		ops.GET("/nodes/:id/systemd/status", systemdHandler(rt).Status)
		ops.GET("/nodes/:id/systemd/units", systemdHandler(rt).ListUnits)
		ops.GET("/nodes/:id/systemd/unit", systemdHandler(rt).Detail)
		ops.GET("/nodes/:id/systemd/journal", systemdHandler(rt).Journal)
		ops.POST("/nodes/:id/systemd/action", perm(auth.PermServiceManage), systemdHandler(rt).Action)
		// Ops dock — process management. Reads ActionConnect; signal/renice PermProcessManage.
		ops.GET("/nodes/:id/process/list", processHandler(rt).List)
		ops.GET("/nodes/:id/process/list/stream", processHandler(rt).Stream)
		ops.GET("/nodes/:id/process/detail", processHandler(rt).Detail)
		ops.POST("/nodes/:id/process/signal", perm(auth.PermProcessManage), processHandler(rt).Signal)
		ops.POST("/nodes/:id/process/renice", perm(auth.PermProcessManage), processHandler(rt).Renice)
		// Ops dock — performance diagnostics (read-only).
		ops.GET("/nodes/:id/perf/snapshot", perfHandler(rt).Snapshot)
		ops.GET("/nodes/:id/perf/snapshot/stream", perfHandler(rt).Stream)
		ops.GET("/nodes/:id/perf/dmesg", perfHandler(rt).Dmesg)
		// Ops dock — log viewer (read-only; follow streams over SSE).
		ops.GET("/nodes/:id/logs/files", logsHandler(rt).Files)
		ops.GET("/nodes/:id/logs/tail", logsHandler(rt).Tail)
		ops.GET("/nodes/:id/logs/follow", logsHandler(rt).Follow)
		// Ops dock — hardware inventory (read-only).
		ops.GET("/nodes/:id/hardware", hardwareHandler(rt).Info)
		// Ops dock — kernel params. Read ActionConnect; sysctl write PermKernelManage.
		ops.GET("/nodes/:id/kernel", kernelHandler(rt).Info)
		ops.POST("/nodes/:id/kernel/sysctl", perm(auth.PermKernelManage), kernelHandler(rt).SetSysctl)
		// Ops dock — storage. Read ActionConnect; mount/umount PermStorageManage.
		ops.GET("/nodes/:id/storage", storageHandler(rt).Info)
		ops.POST("/nodes/:id/storage/mount", perm(auth.PermStorageManage), storageHandler(rt).Mount)
		ops.POST("/nodes/:id/storage/umount", perm(auth.PermStorageManage), storageHandler(rt).Unmount)
		// Ops dock — network. Read+diagnose ActionConnect; iface up/down PermNetworkManage.
		ops.GET("/nodes/:id/network", nettoolsHandler(rt).Info)
		ops.GET("/nodes/:id/network/stream", nettoolsHandler(rt).Stream)
		ops.POST("/nodes/:id/network/diagnose", nettoolsHandler(rt).Diagnose)
		ops.POST("/nodes/:id/network/iface", perm(auth.PermNetworkManage), nettoolsHandler(rt).SetIface)
		// Ops dock — scheduled tasks. Read ActionConnect; edits PermCronManage.
		ops.GET("/nodes/:id/cron", cronHandler(rt).Info)
		ops.POST("/nodes/:id/cron/add", perm(auth.PermCronManage), cronHandler(rt).AddEntry)
		ops.POST("/nodes/:id/cron/remove", perm(auth.PermCronManage), cronHandler(rt).RemoveEntry)
		ops.POST("/nodes/:id/cron/timer", perm(auth.PermCronManage), cronHandler(rt).SetTimer)
		// Ops dock — packages. Read ActionConnect; install/remove/upgrade PermPackageManage.
		ops.GET("/nodes/:id/packages/status", pkgHandler(rt).Status)
		ops.GET("/nodes/:id/packages/upgradable", pkgHandler(rt).Upgradable)
		ops.GET("/nodes/:id/packages/search", pkgHandler(rt).Search)
		ops.GET("/nodes/:id/packages/info", pkgHandler(rt).Info)
		ops.GET("/nodes/:id/packages/installed", pkgHandler(rt).Installed)
		ops.GET("/nodes/:id/packages/files", pkgHandler(rt).Files)
		ops.GET("/nodes/:id/packages/history", pkgHandler(rt).History)
		ops.POST("/nodes/:id/packages/hold", perm(auth.PermPackageManage), pkgHandler(rt).Hold)
		ops.POST("/nodes/:id/packages/action", perm(auth.PermPackageManage), pkgHandler(rt).Do)
		// Ops dock — local users. Read ActionConnect; lock/group PermSysUserManage.
		ops.GET("/nodes/:id/users", sysuserHandler(rt).Info)
		ops.POST("/nodes/:id/users/lock", perm(auth.PermSysUserManage), sysuserHandler(rt).Lock)
		ops.POST("/nodes/:id/users/group", perm(auth.PermSysUserManage), sysuserHandler(rt).AddToGroup)
		// Ops dock — security posture. Report read ActionConnect; Apply PermSecurityManage.
		ops.GET("/nodes/:id/security", secauditHandler(rt).Report)
		ops.POST("/nodes/:id/security/apply", perm(auth.PermSecurityManage), secauditHandler(rt).Apply)
		// Ops dock — WireGuard. Reads (status/stream/probe/conf/gateway) require
		// ActionConnect on the node; every mutation (incl. the SSE write streams
		// install + apply) is gated by wireguard:manage.
		ops.GET("/nodes/:id/wireguard", wireguardHandler(rt).Status)
		ops.GET("/nodes/:id/wireguard/stream", wireguardHandler(rt).Stream)
		ops.GET("/nodes/:id/wireguard/probe", wireguardHandler(rt).Probe)
		ops.GET("/nodes/:id/wireguard/gateway", wireguardHandler(rt).GatewayStatus)
		ops.GET("/nodes/:id/wireguard/ifaces/:name", wireguardHandler(rt).GetIfaceConfig)
		ops.GET("/nodes/:id/wireguard/ifaces/:name/conf", wireguardHandler(rt).ReadConf)
		wgManage := perm(auth.PermWireGuardManage)
		ops.POST("/nodes/:id/wireguard/iface", wgManage, wireguardHandler(rt).SetInterface)
		ops.POST("/nodes/:id/wireguard/install/stream", wgManage, wireguardHandler(rt).Install)
		ops.POST("/nodes/:id/wireguard/keys", wgManage, wireguardHandler(rt).GenKeyPair)
		ops.POST("/nodes/:id/wireguard/psk", wgManage, wireguardHandler(rt).GenPSK)
		ops.POST("/nodes/:id/wireguard/ifaces", wgManage, wireguardHandler(rt).CreateIface)
		ops.PATCH("/nodes/:id/wireguard/ifaces/:name", wgManage, wireguardHandler(rt).UpdateIface)
		ops.DELETE("/nodes/:id/wireguard/ifaces/:name", wgManage, wireguardHandler(rt).DeleteIface)
		ops.POST("/nodes/:id/wireguard/ifaces/:name/autostart", wgManage, wireguardHandler(rt).SetAutostart)
		ops.PUT("/nodes/:id/wireguard/ifaces/:name/conf", wgManage, wireguardHandler(rt).WriteConf)
		ops.POST("/nodes/:id/wireguard/ifaces/:name/conf/diff", wgManage, wireguardHandler(rt).DiffConf)
		ops.POST("/nodes/:id/wireguard/ifaces/:name/apply/stream", wgManage, wireguardHandler(rt).ApplyConfigStream)
		ops.POST("/nodes/:id/wireguard/ifaces/:name/peers", wgManage, wireguardHandler(rt).AddPeer)
		ops.POST("/nodes/:id/wireguard/ifaces/:name/peers/update", wgManage, wireguardHandler(rt).UpdatePeer)
		ops.POST("/nodes/:id/wireguard/ifaces/:name/peers/delete", wgManage, wireguardHandler(rt).DeletePeer)
		ops.POST("/nodes/:id/wireguard/ifaces/:name/clients", wgManage, wireguardHandler(rt).NewClient)
		ops.POST("/nodes/:id/wireguard/gateway/forwarding", wgManage, wireguardHandler(rt).EnableForwarding)
		ops.POST("/nodes/:id/wireguard/gateway/nat", wgManage, wireguardHandler(rt).SetNAT)
		// Ops dock — file manager + config editor. List/read ActionConnect;
		// write/chmod gated by storage:manage (filesystem mutations).
		ops.GET("/nodes/:id/files/list", filesHandler(rt).List)
		ops.GET("/nodes/:id/files/read", filesHandler(rt).Read)
		ops.POST("/nodes/:id/files/write", perm(auth.PermStorageManage), filesHandler(rt).Write)
		ops.POST("/nodes/:id/files/chmod", perm(auth.PermStorageManage), filesHandler(rt).Chmod)
		// Ops dock — log analytics (read-only cross-file / journald search).
		ops.POST("/nodes/:id/loganalytics/search", loganalyticsHandler(rt).Search)
		// Ops dock — backup snapshots + `at` scheduling. Info ActionConnect;
		// snapshot/job mutations gated by storage:manage.
		ops.GET("/nodes/:id/backup", backupHandler(rt).Info)
		ops.POST("/nodes/:id/backup/snapshot", perm(auth.PermStorageManage), backupHandler(rt).Snapshot)
		ops.POST("/nodes/:id/backup/at", perm(auth.PermStorageManage), backupHandler(rt).AddAt)
		ops.POST("/nodes/:id/backup/at/remove", perm(auth.PermStorageManage), backupHandler(rt).RemoveAt)
		// Ops dock — bounded packet capture. Interfaces ActionConnect; capture/pcap
		// (run tcpdump) gated by network:manage (sniffing is privileged).
		ops.GET("/nodes/:id/capture/interfaces", captureHandler(rt).Interfaces)
		ops.POST("/nodes/:id/capture/run", perm(auth.PermNetworkManage), captureHandler(rt).Capture)
		ops.POST("/nodes/:id/capture/pcap", perm(auth.PermNetworkManage), captureHandler(rt).Pcap)
		// Plan 17 — new desktop backend (worker subprocess + browser viewer).
		// Always registered for the same observability reason as insights:
		// missing/stale config returns 503, not 404.
		// Desktop/RDP (FreeRDP + IronRDP) is a Community feature — intentionally
		// NOT behind feat(edition.FeatureDesktop). Do not re-add an edition gate
		// here; graphical sessions ship in the open-source build.
		ops.POST("/desktop/sessions", desktopControl(rt).Start)
		ops.DELETE("/desktop/sessions/:session_id", desktopControl(rt).End)
		ops.GET("/desktop/stats", desktopControl(rt).Stats)
		// Per-user file drive (redirected into RDP sessions). Each user only
		// ever sees their own folder; the handler scopes by the JWT subject.
		if rt.DesktopDrive != nil {
			ops.GET("/desktop/drive", rt.DesktopDrive.Info)
			ops.GET("/desktop/drive/list", rt.DesktopDrive.List)
			ops.POST("/desktop/drive/upload", rt.DesktopDrive.Upload)
			ops.GET("/desktop/drive/download", rt.DesktopDrive.Download)
			ops.DELETE("/desktop/drive", rt.DesktopDrive.Delete)
			ops.POST("/desktop/drive/mkdir", rt.DesktopDrive.Mkdir)
			ops.POST("/desktop/drive/rename", rt.DesktopDrive.Rename)
		}
		// Plan 19.5 — operator can re-run the worker bootstrap without
		// restarting the gateway (e.g. after installing MSYS2 / brew /
		// apt deps). Admin-only because it spawns package-manager
		// commands and a CGo compile.
		ops.POST("/desktop/bootstrap", auth.RequireAdmin(), desktopControl(rt).RetryBootstrap)

		// Phase 14 — KMS provider setup wizard. All endpoints
		// require admin because the ingested AuthSecret is a
		// credential that grants decrypt-everything-this-gateway-
		// owns access.
		// Advanced KMS (multi-provider setup / rotation / rewrap) — Flagship feature.
		if rt.KMS != nil {
			km := ops.Group("", feat(edition.FeatureAdvancedKMS))
			km.GET("/setup/kms/status", auth.RequireAdmin(), rt.KMS.Status)
			km.GET("/setup/kms", auth.RequireAdmin(), rt.KMS.List)
			km.POST("/setup/kms", auth.RequireAdmin(), rt.KMS.Create)
			km.POST("/setup/kms/:id/test", auth.RequireAdmin(), rt.KMS.Test)
			km.POST("/setup/kms/:id/promote", auth.RequireAdmin(), rt.KMS.Promote)
			km.DELETE("/setup/kms/:id", auth.RequireAdmin(), rt.KMS.Delete)
			km.POST("/setup/kms/rewrap", auth.RequireAdmin(), rt.KMS.Rewrap)
		}

		// Phase 15 — Approval Service. The Create / List / Get / Cancel
		// + tasks-for-me + decide + delegate surface is open to any
		// authenticated user (with row-level filtering inside the
		// handler). Templates, subscriptions and the ledger dump are
		// admin-gated through the relevant approval:* permission codes.
		if rt.Approval != nil {
			ag := ops.Group("/approvals")
			ag.POST("", rt.Approval.CreateRequest)
			ag.GET("", rt.Approval.ListRequests)
			// Workspace connection gate: is approval required / already granted,
			// and is there an in-flight request to resume?
			ag.GET("/preflight", rt.Approval.Preflight)
			// Per-user workspace summary strip (待我处理 / 我发起 / 今日已决策 / 我的授权).
			ag.GET("/overview", rt.Approval.Overview)
			// Admin governance snapshot (status / risk distribution, throughput, SLA).
			ag.GET("/stats", perm(auth.PermApprovalAdmin), rt.Approval.Stats)
			// Realtime (SSE): per-user notification stream + per-request status.
			// Registered before "/:id" so the static path wins the route match.
			ag.GET("/stream", rt.Approval.StreamUser)
			ag.GET("/:id", rt.Approval.GetRequest)
			ag.GET("/:id/stream", rt.Approval.StreamRequest)
			ag.POST("/:id/cancel", rt.Approval.CancelRequest)
			ag.GET("/:id/audit/verify", rt.Approval.VerifyChain)

			ag.GET("/tasks/me", rt.Approval.MyTasks)
			// Enriched approver inbox — pending tasks pre-joined with their parent
			// request, killing the per-row N+1 the old list suffered.
			ag.GET("/tasks/inbox", rt.Approval.Inbox)
			ag.POST("/tasks/bulk", perm(auth.PermApprovalDecide), rt.Approval.BulkDecide)
			ag.POST("/tasks/:task_id/approve", perm(auth.PermApprovalDecide), rt.Approval.Approve)
			ag.POST("/tasks/:task_id/reject", perm(auth.PermApprovalDecide), rt.Approval.Reject)
			ag.POST("/tasks/:task_id/delegate", perm(auth.PermApprovalDecide), rt.Approval.Delegate)

			// Issued-grant views: the current user's own access, and the
			// admin-wide governance list.
			ag.GET("/grants/mine", rt.Approval.MyGrants)
			ag.GET("/grants", perm(auth.PermApprovalAdmin), rt.Approval.ListGrants)
			// Self-service early release (beneficiary ends their own grant);
			// admin-wide revoke stays gated below.
			ag.POST("/grants/:id/release", rt.Approval.ReleaseGrant)
			ag.POST("/grants/:id/revoke", perm(auth.PermApprovalAdmin), rt.Approval.RevokeGrant)
			ag.GET("/grants/check", rt.Approval.CheckGrant)

			ag.GET("/audit/events", perm(auth.PermApprovalAuditRead), rt.Approval.EventsSince)

			ag.GET("/templates", perm(auth.PermApprovalTemplateManage), rt.Approval.ListTemplates)
			ag.POST("/templates", perm(auth.PermApprovalTemplateManage), rt.Approval.CreateTemplate)
			ag.PATCH("/templates/:id", perm(auth.PermApprovalTemplateManage), rt.Approval.UpdateTemplate)
			ag.DELETE("/templates/:id", perm(auth.PermApprovalTemplateManage), rt.Approval.DeleteTemplate)

			ag.GET("/subscriptions", perm(auth.PermApprovalSubscribeManage), rt.Approval.ListSubscriptions)
			ag.POST("/subscriptions", perm(auth.PermApprovalSubscribeManage), rt.Approval.CreateSubscription)
			ag.PATCH("/subscriptions/:id", perm(auth.PermApprovalSubscribeManage), rt.Approval.UpdateSubscription)
			ag.DELETE("/subscriptions/:id", perm(auth.PermApprovalSubscribeManage), rt.Approval.DeleteSubscription)
		}

		// Break-glass (应急访问). Self-service activate / list-mine / get for any
		// authenticated user (the policy + global gates decide what actually
		// happens). Governance (cross-user list, stats, policy CRUD, post-use
		// review) is gated on break_glass:manage; the kill-switch (revoke) is
		// gated higher on system:admin — privilege separation so a break-glass
		// operator can never silently revoke the audit trail of their own access.
		// Static paths are registered before "/:id" so they win the route match.
		if rt.BreakGlass != nil {
			bg := ops.Group("/break-glass", feat(edition.FeatureBreakGlass))
			bg.POST("/activations", rt.BreakGlass.Activate)
			bg.GET("/activations/mine", rt.BreakGlass.ListMine)
			bg.GET("/activations", perm(auth.PermBreakGlassManage), rt.BreakGlass.List)
			bg.GET("/stats", perm(auth.PermBreakGlassManage), rt.BreakGlass.Stats)
			bg.GET("/activations/:id", rt.BreakGlass.Get)
			bg.POST("/activations/:id/revoke", perm(auth.PermSystemAdmin), rt.BreakGlass.Revoke)
			bg.POST("/activations/:id/review", perm(auth.PermBreakGlassManage), rt.BreakGlass.SubmitReview)
			bg.GET("/policies", perm(auth.PermBreakGlassManage), rt.BreakGlass.ListPolicies)
			bg.POST("/policies", perm(auth.PermBreakGlassManage), rt.BreakGlass.CreatePolicy)
			bg.PATCH("/policies/:id", perm(auth.PermBreakGlassManage), rt.BreakGlass.UpdatePolicy)
			bg.DELETE("/policies/:id", perm(auth.PermBreakGlassManage), rt.BreakGlass.DeletePolicy)
		}
		ops.GET("/ws/v2/desktop/:session_id", desktopWS(rt).Handle)
		ops.GET("/ws/ssh/:node_id", rt.WS.HandleNodeSSH)
		ops.GET("/ws/telnet/:node_id", rt.WS.HandleNodeTelnet)
		// Lifecycle v3 — read-only live monitoring (over-the-shoulder). Separate
		// session:observe permission; the terminal endpoint covers SSH/Telnet/DB
		// CLI (all reuse webssh.Session's hub tee).
		ops.GET("/ws/observe/terminal/:session_id", perm(auth.PermSessionObserve), rt.WS.HandleObserveTerminal)
		ops.GET("/ws/observe/desktop/:session_id", perm(auth.PermSessionObserve), desktopWS(rt).HandleObserve)
		if rt.Guacamole != nil {
			ops.GET("/ws/rdp/:node_id", rt.Guacamole.HandleRDP)
			ops.GET("/ws/vnc/:node_id", rt.Guacamole.HandleVNC)
		}
		if rt.DBCLI != nil {
			ops.GET("/ws/dbcli/:node_id", rt.DBCLI.Handle)
		}
		// Phase 17 — structured DB browser. Reads (schema / columns /
		// rows / SELECT-only Query) are open to any authenticated user
		// with access to the node; writes (Exec) flow through the
		// approval gate via h.Approval inside the handler.
		if rt.DB != nil {
			// Phase 22 — engine catalog (cluster-level, no node id) +
			// per-node capabilities. The UI consumes both during the
			// "new node" sheet and DB Studio mount.
			ops.GET("/db/engines", rt.DB.Engines)
			ops.GET("/nodes/:id/db/capabilities", rt.DB.Capabilities)
			ops.GET("/nodes/:id/db/ping", rt.DB.Ping)
			ops.GET("/nodes/:id/db/databases", rt.DB.Databases)
			ops.GET("/nodes/:id/db/schema", rt.DB.Schema)
			ops.GET("/nodes/:id/db/columns", rt.DB.Columns)
			ops.GET("/nodes/:id/db/indexes", rt.DB.Indexes)
			ops.GET("/nodes/:id/db/foreign_keys", rt.DB.ForeignKeys)
			ops.GET("/nodes/:id/db/stats", rt.DB.TableStats)
			ops.GET("/nodes/:id/db/ddl", rt.DB.TableDDL)
			ops.GET("/nodes/:id/db/rows", rt.DB.Rows)
			ops.GET("/nodes/:id/db/database_stats", rt.DB.DatabaseStats)
			ops.GET("/nodes/:id/db/triggers", rt.DB.Triggers)
			ops.GET("/nodes/:id/db/column_stats", rt.DB.ColumnStats)
			ops.GET("/nodes/:id/db/export", rt.DB.Export)
			ops.POST("/nodes/:id/db/query", rt.DB.Query)
			ops.POST("/nodes/:id/db/exec", rt.DB.Exec)
			ops.POST("/nodes/:id/db/explain", rt.DB.Explain)
			// Phase 30 — multi-statement script. Splits on top-level ;
			// (quotes / dollar-quotes respected) and returns per-stmt
			// results. Writes pass through the same approval gate as
			// /db/exec; reads run straight through.
			ops.POST("/nodes/:id/db/query-multi", rt.DB.QueryMulti)
			// Phase 19 — row-level edits. Approval gate (sql_exec)
			// inside each handler.
			ops.POST("/nodes/:id/db/row/update", rt.DB.RowUpdate)
			ops.POST("/nodes/:id/db/row/insert", rt.DB.RowInsert)
			ops.POST("/nodes/:id/db/row/delete", rt.DB.RowDelete)
			// Phase 20 — server-side process panel + cancel
			ops.GET("/nodes/:id/db/processes", rt.DB.Processes)
			ops.POST("/nodes/:id/db/kill", rt.DB.Kill)
			// Phase 2 — capability families (Completion / Planner / Profiler).
			// Each handler 503s when the service is disabled and 501s when the
			// engine hasn't implemented the family.
			ops.GET("/nodes/:id/db/completion/snapshot", rt.DB.CompletionSnapshot)
			ops.POST("/nodes/:id/db/plan", rt.DB.Plan)
			ops.GET("/nodes/:id/db/profile/stats", rt.DB.ProfileStats)
			ops.GET("/nodes/:id/db/profile/distribution", rt.DB.ProfileDistribution)
			ops.GET("/nodes/:id/db/profile/topn", rt.DB.ProfileTopN)
			ops.GET("/nodes/:id/db/profile/patterns", rt.DB.ProfilePatterns)
		}
		// Phase 1 — cross-subproject Db Studio. parse-uri is the live
		// (pure) endpoint backing the node-creation quick-connect form;
		// the ER-model surface stubs to 501 until sub-project F lands.
		// Mounted under ops so the existing JWT + RejectAnonymous
		// middleware applies — a connection URI carries credentials.
		if rt.DbStudio != nil {
			ops.POST("/dbstudio/connections/parse-uri", rt.DbStudio.ParseURI)
			erm := ops.Group("/dbstudio/er-models")
			erm.GET("", rt.DbStudio.ERModelStub)
			erm.POST("", rt.DbStudio.ERModelStub)
			erm.GET("/:id", rt.DbStudio.ERModelStub)
			erm.PUT("/:id", rt.DbStudio.ERModelStub)
			erm.DELETE("/:id", rt.DbStudio.ERModelStub)
			erm.POST("/:id/reverse", rt.DbStudio.ERModelStub)
			erm.POST("/:id/forward", rt.DbStudio.ERModelStub)
			erm.POST("/:id/diff", rt.DbStudio.ERModelStub)
		}
		if rt.TCPRelay != nil {
			ops.GET("/ws/tcp/:node_id", rt.TCPRelay.Handle)
		}
		if rt.TCPEvents != nil {
			ops.GET("/ws/portforward/events", perm(auth.PermPortForward), rt.TCPEvents.Handle)
		}
		if rt.TCPFwd != nil {
			ops.POST("/portforward", perm(auth.PermPortForward), rt.TCPFwd.Create)
			ops.PATCH("/portforward/:id", perm(auth.PermPortForward), rt.TCPFwd.Patch)
			ops.DELETE("/portforward/:id", perm(auth.PermPortForward), rt.TCPFwd.Delete)
			ops.GET("/portforward", perm(auth.PermPortForward), rt.TCPFwd.List)
		}
	}

	// AI assistant subsystem
	if rt.AI != nil && rt.AI.Enabled {
		aiGroup := authed.Group("/ai", feat(edition.FeatureAI))
		aiGroup.GET("/providers", perm(auth.PermAIUse), rt.AI.Provider.List)
		aiGroup.POST("/providers", perm(auth.PermAIProviderUser), rt.AI.Provider.Create)
		aiGroup.PATCH("/providers/:id", perm(auth.PermAIProviderUser), rt.AI.Provider.Update)
		aiGroup.DELETE("/providers/:id", perm(auth.PermAIProviderUser), rt.AI.Provider.Delete)
		aiGroup.POST("/providers/:id/test", perm(auth.PermAIUse), rt.AI.Provider.Test)
		aiGroup.GET("/providers/:id/models", perm(auth.PermAIUse), rt.AI.Provider.Models)
		aiGroup.PUT("/providers/:id/models", perm(auth.PermAIProviderUser), rt.AI.Provider.SaveModels)
		aiGroup.GET("/providers/:id/ratelimit", perm(auth.PermAIUse), rt.AI.Provider.RateLimit)
		aiGroup.GET("/providers/:id/usage", perm(auth.PermAIUse), rt.AI.Usage.ProviderUsage)
		// Provider catalog + live health. Distinct path segments (provider-presets /
		// provider-health) so they never collide with the /providers/:id param node.
		aiGroup.GET("/provider-presets", perm(auth.PermAIUse), rt.AI.Provider.Presets)
		aiGroup.POST("/provider-test", perm(auth.PermAIProviderUser), rt.AI.Provider.TestDraft)
		aiGroup.POST("/provider-discover-models", perm(auth.PermAIProviderUser), rt.AI.Provider.DiscoverModels)
		aiGroup.GET("/provider-health", perm(auth.PermAIUse), rt.AI.AIHealth.Snapshot)
		aiGroup.GET("/provider-health/stream", perm(auth.PermAIUse), rt.AI.AIHealth.Stream)
		aiGroup.POST("/provider-health/probe", perm(auth.PermAIProviderUser), rt.AI.AIHealth.ProbeNow)

		aiGroup.GET("/usage", perm(auth.PermAIUse), rt.AI.Usage.Summary)

		aiGroup.GET("/agents", perm(auth.PermAIUse), rt.AI.Agent.List)
		aiGroup.POST("/agents", perm(auth.PermAIAgentCreate), rt.AI.Agent.Create)
		aiGroup.PATCH("/agents/:id", perm(auth.PermAIAgentCreate), rt.AI.Agent.Update)
		aiGroup.DELETE("/agents/:id", perm(auth.PermAIAgentCreate), rt.AI.Agent.Delete)
		aiGroup.GET("/tools", perm(auth.PermAIUse), rt.AI.Agent.Catalogue)

		// Knowledge base (RAG) + documents. Distinct top-level segments
		// (knowledge-bases / knowledge-search / embedding-setting / memories) keep
		// them off the /providers|/agents|/conversations :id param nodes.
		aiGroup.GET("/knowledge-bases", perm(auth.PermAIUse), rt.AI.Knowledge.List)
		aiGroup.POST("/knowledge-bases", perm(auth.PermAIKnowledge), rt.AI.Knowledge.Create)
		aiGroup.PATCH("/knowledge-bases/:kb_id", perm(auth.PermAIKnowledge), rt.AI.Knowledge.Update)
		aiGroup.DELETE("/knowledge-bases/:kb_id", perm(auth.PermAIKnowledge), rt.AI.Knowledge.Delete)
		aiGroup.GET("/knowledge-bases/:kb_id/documents", perm(auth.PermAIUse), rt.AI.Knowledge.ListDocs)
		aiGroup.POST("/knowledge-bases/:kb_id/documents", perm(auth.PermAIKnowledge), rt.AI.Knowledge.UploadDoc)
		aiGroup.GET("/knowledge-bases/:kb_id/documents/:doc_id", perm(auth.PermAIUse), rt.AI.Knowledge.DocStatus)
		aiGroup.DELETE("/knowledge-bases/:kb_id/documents/:doc_id", perm(auth.PermAIKnowledge), rt.AI.Knowledge.DeleteDoc)
		aiGroup.POST("/knowledge-bases/:kb_id/documents/:doc_id/reingest", perm(auth.PermAIKnowledge), rt.AI.Knowledge.ReingestDoc)
		aiGroup.POST("/knowledge-bases/:kb_id/import-url", perm(auth.PermAIKnowledge), rt.AI.Knowledge.ImportURL)
		aiGroup.GET("/knowledge-bases/:kb_id/ingest/stream", perm(auth.PermAIUse), rt.AI.Knowledge.IngestStream)
		aiGroup.POST("/knowledge-search", perm(auth.PermAIUse), rt.AI.Knowledge.Search)
		aiGroup.GET("/embedding-setting", perm(auth.PermAIUse), rt.AI.Knowledge.GetEmbeddingSetting)
		aiGroup.PUT("/embedding-setting", perm(auth.PermAIKnowledge), rt.AI.Knowledge.SetEmbeddingSetting)

		// Long-term memory.
		aiGroup.GET("/memories", perm(auth.PermAIUse), rt.AI.Memory.List)
		aiGroup.PATCH("/memories/:mem_id", perm(auth.PermAIUse), rt.AI.Memory.Update)
		aiGroup.DELETE("/memories/:mem_id", perm(auth.PermAIUse), rt.AI.Memory.Delete)

		aiGroup.GET("/conversations", perm(auth.PermAIUse), rt.AI.Conversation.List)
		aiGroup.GET("/conversations/search", perm(auth.PermAIUse), rt.AI.Conversation.Search)
		aiGroup.POST("/conversations", perm(auth.PermAIUse), rt.AI.Conversation.Create)
		aiGroup.GET("/conversations/:id", perm(auth.PermAIUse), rt.AI.Conversation.Get)
		aiGroup.PATCH("/conversations/:id", perm(auth.PermAIUse), rt.AI.Conversation.Update)
		aiGroup.DELETE("/conversations/:id", perm(auth.PermAIUse), rt.AI.Conversation.Delete)
		aiGroup.POST("/conversations/:id/cancel", perm(auth.PermAIUse), rt.AI.Conversation.Cancel)
		aiGroup.GET("/conversations/:id/export.md", perm(auth.PermAIUse), rt.AI.Conversation.ExportMarkdown)
		aiGroup.GET("/conversations/:id/tasks", perm(auth.PermAIUse), rt.AI.Conversation.GetPlan)
		aiGroup.GET("/conversations/:id/search", perm(auth.PermAIUse), rt.AI.Conversation.SearchMessages)
		aiGroup.GET("/conversations/:id/branches", perm(auth.PermAIUse), rt.AI.Conversation.ListBranches)
		aiGroup.POST("/conversations/:id/active-leaf", perm(auth.PermAIUse), rt.AI.Conversation.SetActiveLeaf)
		aiGroup.POST("/conversations/:id/fork", perm(auth.PermAIUse), rt.AI.Conversation.Fork)
		aiGroup.POST("/conversations/:id/autotitle", perm(auth.PermAIUse), rt.AI.Conversation.Autotitle)
		aiGroup.PATCH("/conversations/:id/messages/:msg_id", perm(auth.PermAIUse), rt.AI.Conversation.EditMessage)

		aiGroup.GET("/conversations/:id/messages", perm(auth.PermAIUse), rt.AI.Conversation.ListMessages)
		aiGroup.POST("/conversations/:id/messages", perm(auth.PermAIUse), rt.AI.SSE.SendMessage)
		aiGroup.POST("/conversations/:id/messages/:msg_id/branch", perm(auth.PermAIUse), rt.AI.SSE.BranchMessage)
		aiGroup.POST("/conversations/:id/regenerate", perm(auth.PermAIUse), rt.AI.SSE.Regenerate)
		aiGroup.GET("/conversations/:id/stream", perm(auth.PermAIUse), rt.AI.SSE.Stream)

		aiGroup.POST("/conversations/:id/invocations/:inv_id/approve", perm(auth.PermAIUse), rt.AI.Invocation.Approve)
		aiGroup.POST("/conversations/:id/invocations/:inv_id/reject", perm(auth.PermAIUse), rt.AI.Invocation.Reject)
		aiGroup.POST("/conversations/:id/invocations/:inv_id/answer", perm(auth.PermAIUse), rt.AI.Invocation.Answer)
	}

	// Anonymous WS uses the same middleware but allows the anonymous flag.
	anon := v1.Group("")
	anon.Use(mw)
	anon.GET("/ws/ssh/anonymous", rt.WS.HandleAnonymousSSH)
}
