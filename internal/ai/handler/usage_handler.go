package handler

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	airepo "github.com/michongs/jumpserver-anonymous/internal/ai/repo"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
)

// UsageHandler serves aggregated AI token/cost usage for the observability panel.
type UsageHandler struct {
	Conv *airepo.ConversationRepo
}

// Summary is GET /ai/usage?days=&scope=&group= — token/cache/cost buckets +
// totals. group is a comma list of day|model|provider (default day,model).
// Admins may pass scope=all to aggregate across all users; everyone else (and
// the default) is scoped to their own conversations.
func (h *UsageHandler) Summary(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	adminAll := claims.Admin && c.Query("scope") == "all"

	to := time.Now()
	days := 30
	if n, err := parseUint64(c.Query("days")); err == nil && n > 0 && n <= 365 {
		days = int(n)
	}
	from := to.AddDate(0, 0, -days)

	var groups []string
	if g := strings.TrimSpace(c.Query("group")); g != "" {
		groups = strings.Split(g, ",")
	}
	buckets, err := h.Conv.AggregateUsage(c.Request.Context(), claims.UserID, adminAll, from, to,
		airepo.UsageQuery{GroupBy: groups})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var tin, tout, tcr, tcw, tcost uint64
	tmsg := 0
	for _, b := range buckets {
		tin += b.InputTokens
		tout += b.OutputTokens
		tcr += b.CacheReadTokens
		tcw += b.CacheWriteTokens
		tcost += b.CostMicros
		tmsg += b.Messages
	}
	scope := "me"
	if adminAll {
		scope = "all"
	}
	c.JSON(http.StatusOK, gin.H{
		"buckets": buckets,
		"totals": gin.H{
			"input_tokens":       tin,
			"output_tokens":      tout,
			"cache_read_tokens":  tcr,
			"cache_write_tokens": tcw,
			"cost_micros":        tcost,
			"messages":           tmsg,
		},
		"scope":     scope,
		"can_admin": claims.Admin,
		"days":      days,
	})
}

// ProviderUsage is GET /ai/providers/:id/usage?days=&scope= — usage filtered to
// one provider, grouped by day+model. Same response envelope as Summary so the
// detail panel can reuse the usage page's chart code.
func (h *UsageHandler) ProviderUsage(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	adminAll := claims.Admin && c.Query("scope") == "all"
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)

	to := time.Now()
	days := 30
	if n, err := parseUint64(c.Query("days")); err == nil && n > 0 && n <= 365 {
		days = int(n)
	}
	from := to.AddDate(0, 0, -days)

	buckets, err := h.Conv.AggregateUsage(c.Request.Context(), claims.UserID, adminAll, from, to,
		airepo.UsageQuery{GroupBy: []string{"day", "model"}, ProviderID: id})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	var tin, tout, tcr, tcw, tcost uint64
	tmsg := 0
	for _, b := range buckets {
		tin += b.InputTokens
		tout += b.OutputTokens
		tcr += b.CacheReadTokens
		tcw += b.CacheWriteTokens
		tcost += b.CostMicros
		tmsg += b.Messages
	}
	scope := "me"
	if adminAll {
		scope = "all"
	}
	c.JSON(http.StatusOK, gin.H{
		"buckets": buckets,
		"totals": gin.H{
			"input_tokens":       tin,
			"output_tokens":      tout,
			"cache_read_tokens":  tcr,
			"cache_write_tokens": tcw,
			"cost_micros":        tcost,
			"messages":           tmsg,
		},
		"scope":       scope,
		"can_admin":   claims.Admin,
		"days":        days,
		"provider_id": id,
	})
}
