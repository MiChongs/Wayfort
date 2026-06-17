package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/geoip"
	"github.com/michongs/wayfort/internal/repo"
)

// SecurityHandler serves the admin security center under /api/v1/admin/security:
// the anomalous-login list + stats, and GeoIP database status / manual refresh.
// All routes are gated at the router layer (audit:read for reads, system:admin
// for the GeoIP refresh).
type SecurityHandler struct {
	History *repo.LoginHistoryRepo
	Geo     *geoip.Service
}

// ListAnomalies — GET /admin/security/anomalies
// Filters: username, country (ISO), reason (substring), min_score, days, limit, offset.
func (h *SecurityHandler) ListAnomalies(c *gin.Context) {
	f := repo.AnomalyFilter{AnomalyOnly: true}
	f.Username = c.Query("username")
	f.CountryISO = c.Query("country")
	f.Reason = c.Query("reason")
	f.MinScore, _ = strconv.Atoi(c.DefaultQuery("min_score", "0"))
	f.Limit, _ = strconv.Atoi(c.DefaultQuery("limit", "50"))
	f.Offset, _ = strconv.Atoi(c.DefaultQuery("offset", "0"))
	if days, _ := strconv.Atoi(c.Query("days")); days > 0 {
		since := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
		f.Since = &since
	}
	rows, total, err := h.History.QueryAnomalies(c.Request.Context(), f)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"anomalies": rows, "total": total})
}

// AnomalyStats — GET /admin/security/anomalies/stats?days=7
// Returns total, by-country, by-reason, and a per-day trend over the window.
func (h *SecurityHandler) AnomalyStats(c *gin.Context) {
	days, _ := strconv.Atoi(c.DefaultQuery("days", "7"))
	if days <= 0 {
		days = 7
	}
	since := time.Now().Add(-time.Duration(days) * 24 * time.Hour)

	total, byCountry, err := h.History.AnomalyStats(c.Request.Context(), since)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Reason breakdown + daily trend are computed from a bounded fetch (reasons
	// live in a CSV column; trend is cheap to derive from the same rows).
	rows, _, err := h.History.QueryAnomalies(c.Request.Context(), repo.AnomalyFilter{
		AnomalyOnly: true, Since: &since, Limit: 5000,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	reasonCounts := map[string]int64{}
	dayCounts := map[string]int64{}
	for _, r := range rows {
		for _, code := range strings.Split(r.AnomalyReasons, ",") {
			code = strings.TrimSpace(code)
			if code != "" {
				reasonCounts[code]++
			}
		}
		dayCounts[r.CreatedAt.Format("2006-01-02")]++
	}
	byReason := make([]repo.AnomalyCount, 0, len(reasonCounts))
	for k, v := range reasonCounts {
		byReason = append(byReason, repo.AnomalyCount{Key: k, Count: v})
	}
	// Stable, dense trend across the window (zero-filled).
	trend := make([]repo.AnomalyCount, 0, days)
	for i := days - 1; i >= 0; i-- {
		d := time.Now().Add(-time.Duration(i) * 24 * time.Hour).Format("2006-01-02")
		trend = append(trend, repo.AnomalyCount{Key: d, Count: dayCounts[d]})
	}

	c.JSON(http.StatusOK, gin.H{
		"total":      total,
		"days":       days,
		"by_country": byCountry,
		"by_reason":  byReason,
		"trend":      trend,
		"sampled":    len(rows),
	})
}

// GeoIPStatus — GET /admin/security/geoip/status
func (h *SecurityHandler) GeoIPStatus(c *gin.Context) {
	if h.Geo == nil {
		c.JSON(http.StatusOK, gin.H{"enabled": false})
		return
	}
	c.JSON(http.StatusOK, h.Geo.Status())
}

// GeoIPRefresh — POST /admin/security/geoip/refresh
// Forces an immediate database download/refresh. Gated on system:admin.
func (h *SecurityHandler) GeoIPRefresh(c *gin.Context) {
	if h.Geo == nil || !h.Geo.Enabled() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "geoip disabled"})
		return
	}
	// Bound the refresh so a slow/stuck download can't hang the handler forever.
	ctx, cancel := context.WithTimeout(c.Request.Context(), 5*time.Minute)
	defer cancel()
	st, err := h.Geo.RefreshNow(ctx)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error(), "status": st})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "status": st})
}
