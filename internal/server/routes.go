package server

import (
	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/api"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/sftp"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
)

type Routes struct {
	Auth    *api.AuthHandler
	Node    *api.NodeHandler
	Proxy   *api.ProxyHandler
	Cred    *api.CredentialHandler
	Session *api.SessionHandler
	SFTP    *sftp.Handler
	WS      *webssh.Gateway
	Issuer  *auth.Issuer
}

func (rt *Routes) Mount(r *gin.Engine) {
	v1 := r.Group("/api/v1")
	{
		ag := v1.Group("/auth")
		ag.POST("/login", rt.Auth.Login)
		ag.POST("/refresh", rt.Auth.Refresh)
		ag.POST("/anonymous", rt.Auth.Anonymous)
	}
	mw := auth.Middleware(rt.Issuer)

	authed := v1.Group("")
	authed.Use(mw)
	{
		// Admin-only resource CRUD.
		admin := authed.Group("")
		admin.Use(auth.RequireAdmin())
		admin.GET("/nodes", rt.Node.List)
		admin.POST("/nodes", rt.Node.Create)
		admin.GET("/nodes/:id", rt.Node.Get)
		admin.PATCH("/nodes/:id", rt.Node.Update)
		admin.DELETE("/nodes/:id", rt.Node.Delete)
		admin.GET("/proxies", rt.Proxy.List)
		admin.POST("/proxies", rt.Proxy.Create)
		admin.PATCH("/proxies/:id", rt.Proxy.Update)
		admin.DELETE("/proxies/:id", rt.Proxy.Delete)
		admin.GET("/credentials", rt.Cred.List)
		admin.POST("/credentials", rt.Cred.Create)
		admin.PATCH("/credentials/:id", rt.Cred.Update)
		admin.DELETE("/credentials/:id", rt.Cred.Delete)

		// Authenticated (non-anonymous) operational APIs.
		ops := authed.Group("")
		ops.Use(auth.RejectAnonymous())
		ops.GET("/sessions", rt.Session.List)
		ops.GET("/sessions/:id/cast", rt.Session.Cast)
		ops.GET("/nodes/:id/sftp/ls", rt.SFTP.List)
		ops.POST("/nodes/:id/sftp/mkdir", rt.SFTP.Mkdir)
		ops.DELETE("/nodes/:id/sftp/rm", rt.SFTP.Remove)
		ops.POST("/nodes/:id/sftp/upload", rt.SFTP.Upload)
		ops.GET("/nodes/:id/sftp/download", rt.SFTP.Download)
		ops.GET("/ws/ssh/:node_id", rt.WS.HandleNodeSSH)
	}

	// Anonymous WS uses the same middleware but allows the anonymous flag.
	anon := v1.Group("")
	anon.Use(mw)
	anon.GET("/ws/ssh/anonymous", rt.WS.HandleAnonymousSSH)
}
