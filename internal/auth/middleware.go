package auth

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type ctxKey string

const claimsKey ctxKey = "auth.claims"

// MiddlewareDeps bundles everything Middleware needs: token verification,
// jti blocklist check, and (optional) automatic activeness assertion.
type MiddlewareDeps struct {
	Issuer    *Issuer
	Blocklist *Blocklist
	// AllowChallenge lets endpoints that finalise MFA accept tokens still in the
	// mfa_required step. Default false → only fully-authenticated tokens pass.
	AllowChallenge bool
}

func Middleware(issuer *Issuer) gin.HandlerFunc {
	return MiddlewareWith(MiddlewareDeps{Issuer: issuer})
}

func MiddlewareWith(deps MiddlewareDeps) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := extractToken(c)
		if token == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing token"})
			return
		}
		claims, err := deps.Issuer.Parse(token)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}
		if !deps.AllowChallenge && claims.Step != AuthStepActive {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "token not active"})
			return
		}
		if deps.Blocklist != nil {
			ctx, cancel := context.WithTimeout(c.Request.Context(), 500*time.Millisecond)
			revoked := deps.Blocklist.IsRevoked(ctx, claims.ID)
			cancel()
			if revoked {
				c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "token revoked"})
				return
			}
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
		if claims == nil || (!claims.Admin && !hasSystem(c, claims.UserID)) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "admin required"})
			return
		}
		c.Next()
	}
}

// RequirePermission gates a route on a specific permission code. system:admin
// implies everything.
func RequirePermission(perm string, resolver *Resolver) gin.HandlerFunc {
	return func(c *gin.Context) {
		claims := FromContext(c.Request.Context())
		if claims == nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
			return
		}
		if claims.Admin {
			c.Next()
			return
		}
		if resolver == nil {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "resolver missing"})
			return
		}
		ok, err := resolver.Has(c.Request.Context(), claims.UserID, perm)
		if err != nil || !ok {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "permission denied: " + perm})
			return
		}
		c.Next()
	}
}

// RejectAnonymous blocks endpoints that should never be reachable by anonymous JWTs.
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

// hasSystem is a fall-back used by RequireAdmin when no resolver is wired (very
// early bootstrap). It just returns false — admin flag is the only path.
func hasSystem(_ *gin.Context, _ uint64) bool { return false }

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
