package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
)

// ProxyGroupHandler manages failover-group membership directly. The all-in-one
// path is ProxyHandler.Create/Update (via the Group DTO); these endpoints let a
// caller inspect or mutate members of an existing group on their own.
type ProxyGroupHandler struct {
	Groups  *repo.ProxyGroupRepo
	Proxies *repo.ProxyRepo
}

// group loads a proxy and asserts it is a failover group.
func (h *ProxyGroupHandler) group(c *gin.Context) (*model.Proxy, bool) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	g, err := h.Proxies.FindByID(c.Request.Context(), id)
	if err != nil || g == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return nil, false
	}
	if g.Kind != model.ProxyFailover {
		c.JSON(http.StatusBadRequest, gin.H{"error": "proxy is not a failover group"})
		return nil, false
	}
	return g, true
}

// Members GET /proxies/:id/members — list members with their resolved proxy rows
// plus the group's strategy/retry/backoff.
func (h *ProxyGroupHandler) Members(c *gin.Context) {
	g, ok := h.group(c)
	if !ok {
		return
	}
	specs, err := h.Groups.MembersOf(c.Request.Context(), g.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	links, _ := h.Groups.MembersForGroup(c.Request.Context(), g.ID)
	c.JSON(http.StatusOK, gin.H{
		"group_id":   g.ID,
		"strategy":   g.GroupStrategy,
		"retry":      g.GroupRetryMax,
		"backoff_ms": g.GroupBackoffMS,
		"links":      links,
		"members":    specs,
	})
}

// SetMembers PUT /proxies/:id/members — replace membership + group knobs.
func (h *ProxyGroupHandler) SetMembers(c *gin.Context) {
	g, ok := h.group(c)
	if !ok {
		return
	}
	var spec model.ProxyGroupSpec
	if err := c.ShouldBindJSON(&spec); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if len(spec.Members) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failover group requires at least one member"})
		return
	}
	if spec.Strategy == "" {
		spec.Strategy = model.FailoverOrdered
	}
	if !spec.Strategy.Valid() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid failover strategy"})
		return
	}
	// Validate members exist, aren't groups, aren't self.
	for _, mid := range spec.Members {
		if mid == g.ID {
			c.JSON(http.StatusBadRequest, gin.H{"error": "failover group cannot include itself"})
			return
		}
		m, err := h.Proxies.FindByID(c.Request.Context(), mid)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		if m == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "member proxy not found"})
			return
		}
		if m.Kind == model.ProxyFailover {
			c.JSON(http.StatusBadRequest, gin.H{"error": "nested failover groups are not allowed"})
			return
		}
	}
	g.GroupStrategy = spec.Strategy
	g.GroupRetryMax = spec.Retry
	g.GroupBackoffMS = spec.BackoffMS
	if err := h.Proxies.Update(c.Request.Context(), g); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := h.Groups.SetMembers(c.Request.Context(), g.ID, membersFromSpec(&spec)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// RemoveMember DELETE /proxies/:id/members/:mid — drop one membership row.
func (h *ProxyGroupHandler) RemoveMember(c *gin.Context) {
	g, ok := h.group(c)
	if !ok {
		return
	}
	mid, _ := strconv.ParseUint(c.Param("mid"), 10, 64)
	if err := h.Groups.RemoveMember(c.Request.Context(), g.ID, mid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
