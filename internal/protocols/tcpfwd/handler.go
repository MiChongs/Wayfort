package tcpfwd

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/approval"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// Handler exposes REST endpoints for managing TCP forwarders. The Manager is
// expected to be running already (Run was called inside the main errgroup).
type Handler struct {
	Manager *Manager
	Nodes   *repo.NodeRepo
	Repo    *repo.PortForwardRepo
	// Approval gates Create against the target node's
	// RequiresApprovalForConnect flag. nil = no gating.
	Approval *approval.Service
}

type createReq struct {
	NodeID uint64 `json:"node_id" binding:"required"`
	TTL    string `json:"ttl"`
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

	// Phase 16 — port forwards inherit the same asset_access gate as
	// interactive sessions: a forwarder is a TCP pipe to a privileged
	// network endpoint, so the same RequiresApprovalForConnect flag on
	// the node controls it.
	if h.Approval != nil {
		res, err := h.Approval.CheckEnforced(c.Request.Context(), approval.EnforcementCheck{
			UserID:       claims.UserID,
			BusinessType: model.ApprovalBizAssetAccess,
			ResourceType: "node",
			ResourceID:   strconv.FormatUint(req.NodeID, 10),
			Action:       "port_forward",
		})
		if err != nil {
			c.JSON(http.StatusForbidden, gin.H{"error": "approval check failed"})
			return
		}
		if !res.Allowed {
			c.JSON(http.StatusForbidden, gin.H{"error": res.Reason, "approval_required": true})
			return
		}
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
	row, err := h.Manager.Create(c.Request.Context(), claims.UserID, claims.Username, node, ttl)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, row)
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
