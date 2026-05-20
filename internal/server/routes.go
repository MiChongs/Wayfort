package server

import (
	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/ai"
	"github.com/michongs/jumpserver-anonymous/internal/api"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/desktop"
	"github.com/michongs/jumpserver-anonymous/internal/insights"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/dbcli"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/guacamole"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/tcpfwd"
	"github.com/michongs/jumpserver-anonymous/internal/sftp"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
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
	Auth       *api.AuthHandler
	Node       *api.NodeHandler
	Proxy      *api.ProxyHandler
	Cred       *api.CredentialHandler
	Session    *api.SessionHandler
	SFTP       *sftp.Handler
	WS         *webssh.Gateway
	Guacamole  *guacamole.Handler
	DBCLI      *dbcli.Handler
	TCPFwd     *tcpfwd.Handler
	TCPRelay   *tcpfwd.WSRelay
	Issuer     *auth.Issuer
	Blocklist  *auth.Blocklist
	Resolver   *auth.Resolver

	// New surfaces.
	User       *api.UserHandler
	Role       *api.RoleHandler
	Dept       *api.DepartmentHandler
	Group      *api.GroupHandler
	AssetGroup *api.AssetGroupHandler
	Tag        *api.TagHandler
	Grant      *api.GrantHandler
	Me         *api.MeHandler
	OIDCClient *api.OIDCClientHandler

	AI *ai.Set

	// Phase 11 — terminal personalization (snippets, command history,
	// synced profile). All gated on the standard user auth middleware.
	Snippet         *api.SnippetHandler
	CommandHistory  *api.CommandHistoryHandler
	TerminalProfile *api.TerminalProfileHandler

	// Plan 14 — per-node live system telemetry served on the SSH page.
	Insights *insights.Handler

	// Plan 17 — new RDP/desktop backend (FreeRDP worker subprocess +
	// custom browser viewer). When set the gateway exposes the
	// /desktop/sessions REST control plane and the /ws/v2/desktop/:id
	// WebSocket data plane alongside the legacy guacd routes.
	DesktopControl *desktop.ControlHandler
	DesktopWS      *desktop.WSHandler

	// Workspace v2 — server-management panels (firewall, docker) that
	// run SSH commands on the managed node.
	Firewall *api.FirewallHandler
	Docker   *api.DockerHandler
}

func (rt *Routes) Mount(r *gin.Engine) {
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

	authed := v1.Group("")
	authed.Use(mw)
	{
		// Logout — any authenticated session.
		authed.POST("/auth/logout", rt.Auth.Logout)

		// /me self-service
		me := authed.Group("/me")
		me.GET("/profile", rt.Me.Profile)
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
		me.GET("/nodes", rt.Me.VisibleNodes)

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

		// Asset catalogue — read-only for every authenticated user. The
		// workspace tree needs the full group/tag taxonomy to render
		// "by group" / "by tag" views even for non-admins; mutations
		// remain admin-locked further down.
		authed.GET("/asset-groups", rt.AssetGroup.List)
		authed.GET("/tags", rt.Tag.List)

		// Admin: users / roles / orgs
		admin := authed.Group("")
		admin.GET("/users", perm(auth.PermUserManage), rt.User.List)
		admin.POST("/users", perm(auth.PermUserManage), rt.User.Create)
		admin.PATCH("/users/:id", perm(auth.PermUserManage), rt.User.Update)
		admin.DELETE("/users/:id", perm(auth.PermUserManage), rt.User.Delete)
		admin.POST("/users/:id/reset-password", perm(auth.PermUserManage), rt.User.ResetPassword)
		admin.POST("/users/:id/unlock", perm(auth.PermUserManage), rt.User.Unlock)
		admin.POST("/users/:id/force-logout", perm(auth.PermUserManage), rt.User.ForceLogout)
		admin.GET("/users/:id/roles", perm(auth.PermUserManage), rt.User.ListRoles)
		admin.PUT("/users/:id/roles", perm(auth.PermUserManage), rt.User.ReplaceRoles)

		admin.GET("/roles", perm(auth.PermRoleManage), rt.Role.List)
		admin.POST("/roles", perm(auth.PermRoleManage), rt.Role.Create)
		admin.PATCH("/roles/:id", perm(auth.PermRoleManage), rt.Role.Update)
		admin.DELETE("/roles/:id", perm(auth.PermRoleManage), rt.Role.Delete)
		admin.GET("/permissions", perm(auth.PermRoleManage), rt.Role.Permissions)

		admin.GET("/departments", perm(auth.PermDeptManage), rt.Dept.List)
		admin.GET("/departments/tree", perm(auth.PermDeptManage), rt.Dept.Tree)
		admin.POST("/departments", perm(auth.PermDeptManage), rt.Dept.Create)
		admin.PATCH("/departments/:id", perm(auth.PermDeptManage), rt.Dept.Update)
		admin.DELETE("/departments/:id", perm(auth.PermDeptManage), rt.Dept.Delete)

		admin.GET("/groups", perm(auth.PermGroupManage), rt.Group.List)
		admin.POST("/groups", perm(auth.PermGroupManage), rt.Group.Create)
		admin.PATCH("/groups/:id", perm(auth.PermGroupManage), rt.Group.Update)
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
		admin.GET("/proxies", perm(auth.PermProxyManage), rt.Proxy.List)
		admin.POST("/proxies", perm(auth.PermProxyManage), rt.Proxy.Create)
		admin.PATCH("/proxies/:id", perm(auth.PermProxyManage), rt.Proxy.Update)
		admin.DELETE("/proxies/:id", perm(auth.PermProxyManage), rt.Proxy.Delete)
		admin.GET("/credentials", perm(auth.PermCredentialManage), rt.Cred.List)
		admin.POST("/credentials", perm(auth.PermCredentialManage), rt.Cred.Create)
		admin.PATCH("/credentials/:id", perm(auth.PermCredentialManage), rt.Cred.Update)
		admin.DELETE("/credentials/:id", perm(auth.PermCredentialManage), rt.Cred.Delete)
		// asset-groups / tags read routes moved up to authed (catalogue).
		admin.POST("/asset-groups", perm(auth.PermAssetGroupManage), rt.AssetGroup.Create)
		admin.PATCH("/asset-groups/:id", perm(auth.PermAssetGroupManage), rt.AssetGroup.Update)
		admin.DELETE("/asset-groups/:id", perm(auth.PermAssetGroupManage), rt.AssetGroup.Delete)
		admin.POST("/asset-groups/:id/nodes", perm(auth.PermAssetGroupManage), rt.AssetGroup.AddNode)
		admin.DELETE("/asset-groups/:id/nodes/:nid", perm(auth.PermAssetGroupManage), rt.AssetGroup.RemoveNode)
		admin.POST("/tags", perm(auth.PermTagManage), rt.Tag.Create)
		admin.DELETE("/tags/:id", perm(auth.PermTagManage), rt.Tag.Delete)
		admin.POST("/nodes/:id/tags", perm(auth.PermTagManage), rt.Tag.Attach)
		admin.DELETE("/nodes/:id/tags/:tid", perm(auth.PermTagManage), rt.Tag.Detach)
		admin.GET("/asset-grants", perm(auth.PermGrantManage), rt.Grant.List)
		admin.POST("/asset-grants", perm(auth.PermGrantManage), rt.Grant.Create)
		admin.DELETE("/asset-grants/:id", perm(auth.PermGrantManage), rt.Grant.Delete)

		// OIDC client management
		if rt.OIDCClient != nil {
			admin.GET("/oidc-clients", perm(auth.PermOIDCManage), rt.OIDCClient.List)
			admin.POST("/oidc-clients", perm(auth.PermOIDCManage), rt.OIDCClient.Create)
			admin.PATCH("/oidc-clients/:id", perm(auth.PermOIDCManage), rt.OIDCClient.Update)
			admin.DELETE("/oidc-clients/:id", perm(auth.PermOIDCManage), rt.OIDCClient.Delete)
		}

		// Operational: sessions, SFTP, WS endpoints
		ops := authed.Group("")
		ops.Use(auth.RejectAnonymous())
		ops.GET("/sessions", perm(auth.PermSessionList), rt.Session.List)
		ops.GET("/sessions/:id/recording", perm(auth.PermSessionRead), rt.Session.Recording)
		ops.GET("/sessions/:id/cast", perm(auth.PermSessionRead), rt.Session.Recording)
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
		// Plan 14 — system insights endpoints (sibling to SFTP, same auth).
		// Routes are ALWAYS registered. When the manager is disabled the
		// handler returns 503 with a structured body. This way a stale
		// config (no `insights:` section) doesn't manifest as a 404 from
		// gin's no-route fallback, which is impossible to distinguish on
		// the client side from "the deploy is one version behind".
		ops.GET("/nodes/:id/insights/system", insightsHandler(rt).System)
		ops.GET("/nodes/:id/insights/processes", insightsHandler(rt).Processes)
		ops.GET("/nodes/:id/insights/network", insightsHandler(rt).Network)
		// Workspace v2 — firewall & docker management. Reads are open to
		// any authenticated user with node access; mutations require the
		// matching :manage permission. 503 stubs when disabled.
		ops.GET("/nodes/:id/firewall/status", firewallHandler(rt).Status)
		ops.GET("/nodes/:id/firewall/rules", firewallHandler(rt).ListRules)
		ops.GET("/nodes/:id/firewall/diagnose", firewallHandler(rt).Diagnose)
		ops.POST("/nodes/:id/firewall/rules", perm(auth.PermFirewallManage), firewallHandler(rt).AddRule)
		ops.DELETE("/nodes/:id/firewall/rules/:index", perm(auth.PermFirewallManage), firewallHandler(rt).DeleteRule)
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
		// Plan 17 — new desktop backend (worker subprocess + browser viewer).
		// Always registered for the same observability reason as insights:
		// missing/stale config returns 503, not 404.
		ops.POST("/desktop/sessions", desktopControl(rt).Start)
		ops.DELETE("/desktop/sessions/:session_id", desktopControl(rt).End)
		ops.GET("/desktop/stats", desktopControl(rt).Stats)
		// Plan 19.5 — operator can re-run the worker bootstrap without
		// restarting the gateway (e.g. after installing MSYS2 / brew /
		// apt deps). Admin-only because it spawns package-manager
		// commands and a CGo compile.
		ops.POST("/desktop/bootstrap", auth.RequireAdmin(), desktopControl(rt).RetryBootstrap)
		ops.GET("/ws/v2/desktop/:session_id", desktopWS(rt).Handle)
		ops.GET("/ws/ssh/:node_id", rt.WS.HandleNodeSSH)
		ops.GET("/ws/telnet/:node_id", rt.WS.HandleNodeTelnet)
		if rt.Guacamole != nil {
			ops.GET("/ws/rdp/:node_id", rt.Guacamole.HandleRDP)
			ops.GET("/ws/vnc/:node_id", rt.Guacamole.HandleVNC)
		}
		if rt.DBCLI != nil {
			ops.GET("/ws/dbcli/:node_id", rt.DBCLI.Handle)
		}
		if rt.TCPRelay != nil {
			ops.GET("/ws/tcp/:node_id", rt.TCPRelay.Handle)
		}
		if rt.TCPFwd != nil {
			ops.POST("/portforward", perm(auth.PermPortForward), rt.TCPFwd.Create)
			ops.DELETE("/portforward/:id", perm(auth.PermPortForward), rt.TCPFwd.Delete)
			ops.GET("/portforward", perm(auth.PermPortForward), rt.TCPFwd.List)
		}
	}

	// AI assistant subsystem
	if rt.AI != nil && rt.AI.Enabled {
		aiGroup := authed.Group("/ai")
		aiGroup.GET("/providers", perm(auth.PermAIUse), rt.AI.Provider.List)
		aiGroup.POST("/providers", perm(auth.PermAIProviderUser), rt.AI.Provider.Create)
		aiGroup.PATCH("/providers/:id", perm(auth.PermAIProviderUser), rt.AI.Provider.Update)
		aiGroup.DELETE("/providers/:id", perm(auth.PermAIProviderUser), rt.AI.Provider.Delete)
		aiGroup.POST("/providers/:id/test", perm(auth.PermAIUse), rt.AI.Provider.Test)
		aiGroup.GET("/providers/:id/models", perm(auth.PermAIUse), rt.AI.Provider.Models)

		aiGroup.GET("/agents", perm(auth.PermAIUse), rt.AI.Agent.List)
		aiGroup.POST("/agents", perm(auth.PermAIAgentCreate), rt.AI.Agent.Create)
		aiGroup.PATCH("/agents/:id", perm(auth.PermAIAgentCreate), rt.AI.Agent.Update)
		aiGroup.DELETE("/agents/:id", perm(auth.PermAIAgentCreate), rt.AI.Agent.Delete)
		aiGroup.GET("/tools", perm(auth.PermAIUse), rt.AI.Agent.Catalogue)

		aiGroup.GET("/conversations", perm(auth.PermAIUse), rt.AI.Conversation.List)
		aiGroup.GET("/conversations/search", perm(auth.PermAIUse), rt.AI.Conversation.Search)
		aiGroup.POST("/conversations", perm(auth.PermAIUse), rt.AI.Conversation.Create)
		aiGroup.GET("/conversations/:id", perm(auth.PermAIUse), rt.AI.Conversation.Get)
		aiGroup.PATCH("/conversations/:id", perm(auth.PermAIUse), rt.AI.Conversation.Update)
		aiGroup.DELETE("/conversations/:id", perm(auth.PermAIUse), rt.AI.Conversation.Delete)
		aiGroup.POST("/conversations/:id/cancel", perm(auth.PermAIUse), rt.AI.Conversation.Cancel)
		aiGroup.GET("/conversations/:id/export.md", perm(auth.PermAIUse), rt.AI.Conversation.ExportMarkdown)
		aiGroup.PATCH("/conversations/:id/messages/:msg_id", perm(auth.PermAIUse), rt.AI.Conversation.EditMessage)

		aiGroup.POST("/conversations/:id/messages", perm(auth.PermAIUse), rt.AI.SSE.SendMessage)
		aiGroup.GET("/conversations/:id/stream", perm(auth.PermAIUse), rt.AI.SSE.Stream)

		aiGroup.POST("/conversations/:id/invocations/:inv_id/approve", perm(auth.PermAIUse), rt.AI.Invocation.Approve)
		aiGroup.POST("/conversations/:id/invocations/:inv_id/reject", perm(auth.PermAIUse), rt.AI.Invocation.Reject)
	}

	// Anonymous WS uses the same middleware but allows the anonymous flag.
	anon := v1.Group("")
	anon.Use(mw)
	anon.GET("/ws/ssh/anonymous", rt.WS.HandleAnonymousSSH)
}
