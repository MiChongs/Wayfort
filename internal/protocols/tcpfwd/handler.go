package tcpfwd

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// Handler exposes REST endpoints for managing TCP forwarders. The Manager is
// expected to be running already (Run was called inside the main errgroup).
type Handler struct {
	Manager *Manager
	Nodes   *repo.NodeRepo
	Repo    *repo.PortForwardRepo
}

type createReq struct {
	NodeID uint64   `json:"node_id" binding:"required"`
	TTL    string   `json:"ttl"`
	Label  string   `json:"label"`
	Tags   []string `json:"tags"`
	Pinned bool     `json:"pinned"`
}

// patchReq carries the partial update the owner wants to apply. All fields
// are pointers so a missing JSON key means "leave that column alone". Empty
// string and empty array are honoured as "clear it".
type patchReq struct {
	Label  *string   `json:"label,omitempty"`
	Tags   *[]string `json:"tags,omitempty"`
	Pinned *bool     `json:"pinned,omitempty"`
}

func (h *Handler) Create(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	var req createReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	node, err := h.Nodes.FindByID(c.Request.Context(), req.NodeID)
	if err != nil || node == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	var ttl time.Duration
	if req.TTL != "" {
		d, perr := time.ParseDuration(req.TTL)
		if perr != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "bad ttl: " + perr.Error()})
			return
		}
		ttl = d
	}
	row, err := h.Manager.Create(c.Request.Context(), claims.UserID, claims.Username, node, CreateOpts{
		TTL:    ttl,
		Label:  req.Label,
		Tags:   req.Tags,
		Pinned: req.Pinned,
	})
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, row)
}

// Patch updates the user-supplied metadata (label / tags / pinned) of an
// existing forwarder. Owner-only: a non-admin user editing somebody else's
// row gets 403.
func (h *Handler) Patch(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	id := c.Param("id")
	var req patchReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Label == nil && req.Tags == nil && req.Pinned == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no fields to update"})
		return
	}
	row, err := h.Manager.UpdateMeta(c.Request.Context(), claims.UserID, id, UpdateMeta{
		Label:  req.Label,
		Tags:   req.Tags,
		Pinned: req.Pinned,
	})
	if err != nil {
		switch err.Error() {
		case "not found":
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		case "forbidden":
			c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		}
		return
	}
	c.JSON(http.StatusOK, row)
}

func (h *Handler) Delete(c *gin.Context) {
	id := c.Param("id")
	if err := h.Manager.Close(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) List(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	uid := uint64(0)
	if claims != nil && !claims.Admin {
		uid = claims.UserID
	}
	rows, err := h.Repo.ListActive(c.Request.Context(), uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"port_forwards": rows})
}
