package api

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// This file hosts the Phase 2 capability-family REST surface: schema
// completion, visual execution plan, and data profiling. All six methods are
// receivers on *DBHandler so they share the existing gate() (nil-safe 503,
// claims + node-id parsing) and the *dbquery.Service connection-pool helpers.
//
// Capability gating is two-layered: gate() rejects a nil Svc with 503; when
// the engine hasn't implemented a family the adapter returns a nil provider
// and the handler answers 501 so the UI can branch on "not yet built".
//
// Lifecycle note: the providers borrow the shared per-(node,user,database)
// pool's *sql.DB; they do NOT take ownership, so no per-request Release —
// RunEvictor reclaims idle pools, matching the existing Schema/Columns path.

// CompletionSnapshot — GET /api/v1/nodes/:id/db/completion/snapshot?database=
// Returns the engine's flat schema snapshot (schemas/tables/columns/functions)
// for the autocomplete cache. Frontend caches with a TTL; DDL invalidates.
func (h *DBHandler) CompletionSnapshot(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	database := c.Query("database")
	prov, _, err := h.Svc.CompletionProvider(c.Request.Context(), nodeID, claims.UserID, database)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if prov == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "schema completion not supported"})
		return
	}
	snap, err := prov.Snapshot(c.Request.Context(), database)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, snap)
}

// planBody is the request shape for Plan.
type planBody struct {
	SQL      string `json:"sql"`
	Database string `json:"database"`
}

// Plan — POST /api/v1/nodes/:id/db/plan  body {sql, database?}
// Returns the parsed execution-plan tree plus the raw EXPLAIN text fallback.
func (h *DBHandler) Plan(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	var body planBody
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(body.SQL) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "sql required"})
		return
	}
	pl, _, err := h.Svc.PlannerProvider(c.Request.Context(), nodeID, claims.UserID, body.Database)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if pl == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "visual query plan not supported"})
		return
	}
	root, raw, err := pl.Plan(c.Request.Context(), body.SQL)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"root": root, "raw": raw})
}

// profileParams pulls the shared schema/table/column/database query params and
// validates the required trio, writing a 400 on miss. Returns ok=false when so.
func (h *DBHandler) profileParams(c *gin.Context) (schema, table, column, database string, ok bool) {
	schema, table, column = c.Query("schema"), c.Query("table"), c.Query("column")
	if schema == "" || table == "" || column == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema, table, column required"})
		return "", "", "", "", false
	}
	return schema, table, column, c.Query("database"), true
}

// ProfileStats — GET /api/v1/nodes/:id/db/profile/stats?schema=&table=&column=&database=
func (h *DBHandler) ProfileStats(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	schema, table, column, database, ok := h.profileParams(c)
	if !ok {
		return
	}
	prov, _, err := h.Svc.ProfilerProvider(c.Request.Context(), nodeID, claims.UserID, database)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if prov == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "data profiling not supported"})
		return
	}
	stats, err := prov.BasicStats(c.Request.Context(), schema, table, column)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, stats)
}

// ProfileDistribution — GET /api/v1/nodes/:id/db/profile/distribution?schema=&table=&column=&buckets=
// Equal-depth histogram; buckets defaults to 20.
func (h *DBHandler) ProfileDistribution(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	schema, table, column, database, ok := h.profileParams(c)
	if !ok {
		return
	}
	buckets, _ := strconv.Atoi(c.Query("buckets"))
	if buckets <= 0 {
		buckets = 20
	}
	prov, _, err := h.Svc.ProfilerProvider(c.Request.Context(), nodeID, claims.UserID, database)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if prov == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "data profiling not supported"})
		return
	}
	hist, err := prov.Distribution(c.Request.Context(), schema, table, column, buckets)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, hist)
}

// ProfileTopN — GET /api/v1/nodes/:id/db/profile/topn?schema=&table=&column=&n=
// Most frequent values; n defaults to 10.
func (h *DBHandler) ProfileTopN(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	schema, table, column, database, ok := h.profileParams(c)
	if !ok {
		return
	}
	n, _ := strconv.Atoi(c.Query("n"))
	if n <= 0 {
		n = 10
	}
	prov, _, err := h.Svc.ProfilerProvider(c.Request.Context(), nodeID, claims.UserID, database)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if prov == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "data profiling not supported"})
		return
	}
	top, err := prov.TopN(c.Request.Context(), schema, table, column, n)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, top)
}

// ProfilePatterns — GET /api/v1/nodes/:id/db/profile/patterns?schema=&table=&column=&database=
// Bundled regex catalog matches (email / phone / uuid / ipv4 / url).
func (h *DBHandler) ProfilePatterns(c *gin.Context) {
	nodeID, claims, ok := h.gate(c)
	if !ok {
		return
	}
	schema, table, column, database, ok := h.profileParams(c)
	if !ok {
		return
	}
	prov, _, err := h.Svc.ProfilerProvider(c.Request.Context(), nodeID, claims.UserID, database)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if prov == nil {
		c.JSON(http.StatusNotImplemented, gin.H{"error": "data profiling not supported"})
		return
	}
	pats, err := prov.Patterns(c.Request.Context(), schema, table, column)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, pats)
}
