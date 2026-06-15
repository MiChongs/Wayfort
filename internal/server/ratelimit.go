package server

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/guard"
)

// writeRateLimit returns a middleware that throttles state-changing requests
// (POST/PUT/PATCH/DELETE) per authenticated user — the write-API gate of the
// overload guard (security-architecture.md §11). Read methods pass through
// untouched. Nil limiter → no-op. Keyed by user id (falling back to client IP
// for the rare unauthenticated write), so one user can't exhaust the gateway
// with a write storm.
func writeRateLimit(rl *guard.RateLimiter) gin.HandlerFunc {
	return func(c *gin.Context) {
		if rl == nil {
			c.Next()
			return
		}
		switch c.Request.Method {
		case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		default:
			c.Next()
			return
		}
		key := "ip:" + c.ClientIP()
		if claims := auth.FromContext(c.Request.Context()); claims != nil {
			key = "u:" + strconv.FormatUint(claims.UserID, 10)
		}
		if err := rl.Allow(key); err != nil {
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "写操作过于频繁，请稍后重试", "code": string(guard.RejectRateLimited),
			})
			return
		}
		c.Next()
	}
}
