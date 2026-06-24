package api

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/dbstudio"
)

// DBStudioHandler exposes the cross-subproject /api/v1/dbstudio/* endpoints.
// Phase 1 wired connections/parse-uri + the ER-model 501 stubs; Phase 2 W2
// adds the saved-queries / query-history / pinned-results / view-profiles
// CRUD surface backed by the dbstudio stores.
type DBStudioHandler struct {
	Svc *dbstudio.Service
}

// NewDBStudioHandler is the standard constructor. parse-uri keeps working
// with a nil Svc; every store endpoint answers 503 when Svc is nil.
func NewDBStudioHandler(svc *dbstudio.Service) *DBStudioHandler {
	return &DBStudioHandler{Svc: svc}
}

// studioSvc returns the service or writes 503 (so a disabled feature never
// 404s). Nil-receiver-safe.
func (h *DBStudioHandler) studioSvc(c *gin.Context) (*dbstudio.Service, bool) {
	if h == nil || h.Svc == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "db studio disabled"})
		return nil, false
	}
	return h.Svc, true
}

// studioClaims extracts the JWT claims; writes 401 when absent. The ownerID
// for every store call comes from claims.UserID (uint64, matching the store
// signatures — no casts).
func (h *DBStudioHandler) studioClaims(c *gin.Context) (*auth.Claims, bool) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "missing claims"})
		return nil, false
	}
	return claims, true
}

// parseStudioID parses the :id path param as uint64 (matching the store /
// model id convention). Writes 400 on failure.
func parseStudioID(c *gin.Context) (uint64, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad id"})
		return 0, false
	}
	return id, true
}

// ParseURI — POST /api/v1/dbstudio/connections/parse-uri
//
// Body: {"uri":"mysql://user:pass@host:3306/db?ssl=true"}
// Resp: the parsed dbstudio.ConnectionURI, used to prefill the node-creation
// quick-connect form.
//
// Pure parsing — no DB action, so it skips the Phase-16 approval gate. The
// route still sits behind the JWT-protected ops group because a URI carries
// credentials that must not leak to anonymous callers.
func (h *DBStudioHandler) ParseURI(c *gin.Context) {
	var body struct {
		URI string `json:"uri"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid json: " + err.Error()})
		return
	}
	parsed, err := dbstudio.ParseConnectionURI(body.URI)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid uri: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, parsed)
}

// ERModelStub — every /api/v1/dbstudio/er-models/* route in Phase 1.
// CRUD, :id/reverse, :id/forward, :id/diff all funnel here. Returns 501 with
// a stable payload so the UI can render "not yet built" instead of guessing
// at a generic 404.
func (h *DBStudioHandler) ERModelStub(c *gin.Context) {
	c.JSON(http.StatusNotImplemented, gin.H{"error": "er-models endpoint not implemented (Phase 1 stub)"})
}

// ----- Saved queries (Task A5) --------------------------------------------

// SavedQueriesList — GET /api/v1/dbstudio/saved-queries
func (h *DBStudioHandler) SavedQueriesList(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	claims, ok := h.studioClaims(c)
	if !ok {
		return
	}
	list, err := svc.SavedQueries().List(c.Request.Context(), claims.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"queries": list})
}

// SavedQueriesCreate — POST /api/v1/dbstudio/saved-queries
func (h *DBStudioHandler) SavedQueriesCreate(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	claims, ok := h.studioClaims(c)
	if !ok {
		return
	}
	var q dbstudio.SavedQuery
	if err := c.ShouldBindJSON(&q); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid json: " + err.Error()})
		return
	}
	q.OwnerID = claims.UserID // owner is always the caller, never the body
	out, err := svc.SavedQueries().Create(c.Request.Context(), q)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, out)
}

// SavedQueriesUpdate — PUT /api/v1/dbstudio/saved-queries/:id
func (h *DBStudioHandler) SavedQueriesUpdate(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	claims, ok := h.studioClaims(c)
	if !ok {
		return
	}
	id, ok := parseStudioID(c)
	if !ok {
		return
	}
	var q dbstudio.SavedQuery
	if err := c.ShouldBindJSON(&q); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid json: " + err.Error()})
		return
	}
	q.ID = id
	q.OwnerID = claims.UserID
	out, err := svc.SavedQueries().Update(c.Request.Context(), q)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, out)
}

// SavedQueriesDelete — DELETE /api/v1/dbstudio/saved-queries/:id
func (h *DBStudioHandler) SavedQueriesDelete(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	if _, ok := h.studioClaims(c); !ok {
		return
	}
	id, ok := parseStudioID(c)
	if !ok {
		return
	}
	if err := svc.SavedQueries().Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- Query history (Task A6) --------------------------------------------

// QueryHistoryList — GET /api/v1/dbstudio/query-history?node_id=&limit=&offset=
func (h *DBStudioHandler) QueryHistoryList(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	claims, ok := h.studioClaims(c)
	if !ok {
		return
	}
	nodeID, _ := strconv.ParseUint(c.Query("node_id"), 10, 64)
	limit, _ := strconv.Atoi(c.Query("limit"))
	offset, _ := strconv.Atoi(c.Query("offset"))
	list, err := svc.QueryHistory().List(c.Request.Context(), claims.UserID, nodeID, limit, offset, time.Time{})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"history": list})
}

// ----- Pinned results (Task A7) -------------------------------------------

// PinnedResultsList — GET /api/v1/dbstudio/pinned-results
func (h *DBStudioHandler) PinnedResultsList(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	claims, ok := h.studioClaims(c)
	if !ok {
		return
	}
	list, err := svc.PinnedResults().List(c.Request.Context(), claims.UserID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"pinned": list})
}

// PinnedResultsCreate — POST /api/v1/dbstudio/pinned-results
// Body binds straight into dbstudio.PinnedResultEntry (its json tags match the
// client shape; time.Time fields accept RFC3339 strings). The snapshot is
// gzipped by the store before persistence.
func (h *DBStudioHandler) PinnedResultsCreate(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	claims, ok := h.studioClaims(c)
	if !ok {
		return
	}
	var e dbstudio.PinnedResultEntry
	if err := c.ShouldBindJSON(&e); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid json: " + err.Error()})
		return
	}
	e.OwnerID = claims.UserID
	out, err := svc.PinnedResults().Create(c.Request.Context(), e)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, out)
}

// PinnedResultsGet — GET /api/v1/dbstudio/pinned-results/:id
// Returns the full entry with Rows decoded from the snapshot blob.
func (h *DBStudioHandler) PinnedResultsGet(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	if _, ok := h.studioClaims(c); !ok {
		return
	}
	id, ok := parseStudioID(c)
	if !ok {
		return
	}
	out, err := svc.PinnedResults().Get(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, out)
}

// PinnedResultsDelete — DELETE /api/v1/dbstudio/pinned-results/:id
func (h *DBStudioHandler) PinnedResultsDelete(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	if _, ok := h.studioClaims(c); !ok {
		return
	}
	id, ok := parseStudioID(c)
	if !ok {
		return
	}
	if err := svc.PinnedResults().Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- View profiles (Task C2) --------------------------------------------

// ViewProfilesList — GET /api/v1/dbstudio/view-profiles?node_id=&table=
func (h *DBStudioHandler) ViewProfilesList(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	claims, ok := h.studioClaims(c)
	if !ok {
		return
	}
	nodeID, _ := strconv.ParseUint(c.Query("node_id"), 10, 64)
	table := c.Query("table")
	list, err := svc.ViewProfiles().List(c.Request.Context(), claims.UserID, nodeID, table)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"profiles": list})
}

// ViewProfilesCreate — POST /api/v1/dbstudio/view-profiles
func (h *DBStudioHandler) ViewProfilesCreate(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	claims, ok := h.studioClaims(c)
	if !ok {
		return
	}
	var p dbstudio.ViewProfile
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid json: " + err.Error()})
		return
	}
	p.OwnerID = claims.UserID
	out, err := svc.ViewProfiles().Create(c.Request.Context(), p)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, out)
}

// ViewProfilesGet — GET /api/v1/dbstudio/view-profiles/:id
func (h *DBStudioHandler) ViewProfilesGet(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	if _, ok := h.studioClaims(c); !ok {
		return
	}
	id, ok := parseStudioID(c)
	if !ok {
		return
	}
	out, err := svc.ViewProfiles().Get(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, out)
}

// ViewProfilesUpdate — PUT /api/v1/dbstudio/view-profiles/:id
func (h *DBStudioHandler) ViewProfilesUpdate(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	claims, ok := h.studioClaims(c)
	if !ok {
		return
	}
	id, ok := parseStudioID(c)
	if !ok {
		return
	}
	var p dbstudio.ViewProfile
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid json: " + err.Error()})
		return
	}
	p.ID = id
	p.OwnerID = claims.UserID
	out, err := svc.ViewProfiles().Update(c.Request.Context(), p)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, out)
}

// ViewProfilesDelete — DELETE /api/v1/dbstudio/view-profiles/:id
func (h *DBStudioHandler) ViewProfilesDelete(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	if _, ok := h.studioClaims(c); !ok {
		return
	}
	id, ok := parseStudioID(c)
	if !ok {
		return
	}
	if err := svc.ViewProfiles().Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ViewProfilesSetDefault — POST /api/v1/dbstudio/view-profiles/:id/set-default
func (h *DBStudioHandler) ViewProfilesSetDefault(c *gin.Context) {
	svc, ok := h.studioSvc(c)
	if !ok {
		return
	}
	if _, ok := h.studioClaims(c); !ok {
		return
	}
	id, ok := parseStudioID(c)
	if !ok {
		return
	}
	if err := svc.ViewProfiles().SetDefault(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
