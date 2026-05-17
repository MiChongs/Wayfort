package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

type ctxKey string

const claimsKey ctxKey = "auth.claims"

func Middleware(issuer *Issuer) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := extractToken(c)
		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
			return
		}
		claims, err := issuer.Parse(token)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}
		ctx := context.WithValue(c.Request.Context(), claimsKey, claims)
		c.Request = c.Request.WithContext(ctx)
		c.Set(string(claimsKey), claims)
		c.Next()
	}
}

func RequireAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := FromContext(c.Request.Context())
		if claims == nil || !claims.Admin {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "admin required"})
			return
		}
		c.Next()
	}
}

// RejectAnonymous blocks endpoints that should never be reachable by anonymous
// JWTs (asset CRUD, real-target SSH).
func RejectAnonymous() gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := FromContext(c.Request.Context())
		if claims == nil || claims.Anonymous {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "not allowed for anonymous"})
			return
		}
		c.Next()
	}
}

func FromContext(ctx context.Context) *Claims {
	v, _ := ctx.Value(claimsKey).(*Claims)
	return v
}

func extractToken(c *gin.Context) string {
	if h := c.GetHeader("Authorization"); h != "" {
		if strings.HasPrefix(h, "Bearer ") {
			return strings.TrimPrefix(h, "Bearer ")
		}
	}
	if t := c.Query("token"); t != "" {
		return t
	}
	if sub := c.GetHeader("Sec-WebSocket-Protocol"); sub != "" {
		parts := strings.Split(sub, ",")
		for _, p := range parts {
			p = strings.TrimSpace(p)
			if strings.HasPrefix(p, "bearer.") {
				return strings.TrimPrefix(p, "bearer.")
			}
		}
	}
	return ""
}
