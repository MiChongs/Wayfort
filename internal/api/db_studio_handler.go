package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/dbstudio"
)

// DBStudioHandler exposes the cross-subproject /api/v1/dbstudio/* endpoints.
// Phase 1 only wires connections/parse-uri for real (a pure URI parser with
// no DB round-trip); the ER-model surface returns a stable 501 until its
// sub-project plan ships concrete persistence.
type DBStudioHandler struct {
	Svc *dbstudio.Service
}

// NewDBStudioHandler is the standard constructor. parse-uri keeps working
// with a nil Svc (it never touches the service); ER endpoints are static 501s.
func NewDBStudioHandler(svc *dbstudio.Service) *DBStudioHandler {
	return &DBStudioHandler{Svc: svc}
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
