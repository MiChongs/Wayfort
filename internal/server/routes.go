package server

import (
	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/api"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/dbcli"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/guacamole"
	"github.com/michongs/jumpserver-anonymous/internal/protocols/tcpfwd"
	"github.com/michongs/jumpserver-anonymous/internal/sftp"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
)

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
		admin.GET("/asset-groups", perm(auth.PermAssetGroupManage), rt.AssetGroup.List)
		admin.POST("/asset-groups", perm(auth.PermAssetGroupManage), rt.AssetGroup.Create)
		admin.PATCH("/asset-groups/:id", perm(auth.PermAssetGroupManage), rt.AssetGroup.Update)
		admin.DELETE("/asset-groups/:id", perm(auth.PermAssetGroupManage), rt.AssetGroup.Delete)
		admin.POST("/asset-groups/:id/nodes", perm(auth.PermAssetGroupManage), rt.AssetGroup.AddNode)
		admin.DELETE("/asset-groups/:id/nodes/:nid", perm(auth.PermAssetGroupManage), rt.AssetGroup.RemoveNode)
		admin.GET("/tags", perm(auth.PermTagManage), rt.Tag.List)
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
		ops.POST("/nodes/:id/sftp/mkdir", rt.SFTP.Mkdir)
		ops.DELETE("/nodes/:id/sftp/rm", rt.SFTP.Remove)
		ops.POST("/nodes/:id/sftp/upload", rt.SFTP.Upload)
		ops.GET("/nodes/:id/sftp/download", rt.SFTP.Download)
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

	// Anonymous WS uses the same middleware but allows the anonymous flag.
	anon := v1.Group("")
	anon.Use(mw)
	anon.GET("/ws/ssh/anonymous", rt.WS.HandleAnonymousSSH)
}
