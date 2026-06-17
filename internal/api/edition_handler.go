package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/pkg/edition"
)

// EditionHandler exposes the current edition/entitlements and the super-admin
// license install/remove surface.
//
// Two payload shapes, deliberately different in how much they reveal:
//   - /me/edition (every user): a SLIM payload — only what the UI needs to gate
//     nav + show a banner (edition tier, state, the unlocked-feature map). It
//     does NOT leak the licensing internals (no key status, no full paid catalog,
//     no customer/serial/dates).
//   - /admin/edition (super-admin): the richer view for the license manager.
type EditionHandler struct {
	Provider edition.Provider
}

// meDTO is the minimal payload regular users get.
type meEditionDTO struct {
	Edition  string          `json:"edition"`
	State    string          `json:"state"`
	Features map[string]bool `json:"features"`
	Message  string          `json:"message,omitempty"`
}

// adminEditionDTO is the richer payload for the super-admin license page. It
// still avoids teaching the licensing mechanism (no crypto/format/catalog) —
// just the installed license's own status.
type adminEditionDTO struct {
	Edition    string          `json:"edition"`
	State      string          `json:"state"`
	Licensed   bool            `json:"licensed"`
	Supported  bool            `json:"supported"` // build can run a paid edition at all
	Features   map[string]bool `json:"features"`
	Limits     map[string]int  `json:"limits,omitempty"`
	Customer   string          `json:"customer,omitempty"`
	LicenseID  string          `json:"license_id,omitempty"`
	IssuedAt   *time.Time      `json:"issued_at,omitempty"`
	ExpiresAt  *time.Time      `json:"expires_at,omitempty"`
	GraceUntil *time.Time      `json:"grace_until,omitempty"`
	Message    string          `json:"message,omitempty"`
}

func (h *EditionHandler) current() *edition.Entitlements {
	if h.Provider == nil {
		return &edition.Entitlements{Edition: edition.TierCommunity, State: edition.StateCommunity, Features: map[string]bool{}}
	}
	return h.Provider.Current()
}

func feats(e *edition.Entitlements) map[string]bool {
	if e.Features == nil {
		return map[string]bool{}
	}
	return e.Features
}

// Get — GET /me/edition (any authenticated user). Slim payload.
func (h *EditionHandler) Get(c *gin.Context) {
	e := h.current()
	c.JSON(http.StatusOK, meEditionDTO{Edition: e.Edition, State: e.State, Features: feats(e), Message: e.Message})
}

// AdminGet — GET /admin/edition (super-admin). Richer status.
func (h *EditionHandler) AdminGet(c *gin.Context) {
	c.JSON(http.StatusOK, h.adminDTO(h.current()))
}

func (h *EditionHandler) adminDTO(e *edition.Entitlements) adminEditionDTO {
	return adminEditionDTO{
		Edition: e.Edition, State: e.State, Licensed: e.Licensed,
		Supported: h.Provider != nil && h.Provider.Supported(),
		Features:  feats(e), Limits: e.Limits,
		Customer: e.Customer, LicenseID: e.LicenseID,
		IssuedAt: e.IssuedAt, ExpiresAt: e.ExpiresAt, GraceUntil: e.GraceUntil,
		Message: e.Message,
	}
}

// Install — POST /admin/edition/license {license}.
func (h *EditionHandler) Install(c *gin.Context) {
	if h.Provider == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "授权子系统未启用"})
		return
	}
	var body struct {
		License string `json:"license"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求格式错误"})
		return
	}
	var actorID uint64
	if claims := auth.FromContext(c.Request.Context()); claims != nil {
		actorID = claims.UserID
	}
	ent, err := h.Provider.Install(c.Request.Context(), body.License, actorID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, h.adminDTO(ent))
}

// Remove — DELETE /admin/edition/license.
func (h *EditionHandler) Remove(c *gin.Context) {
	if h.Provider == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "授权子系统未启用"})
		return
	}
	var actorID uint64
	if claims := auth.FromContext(c.Request.Context()); claims != nil {
		actorID = claims.UserID
	}
	ent, err := h.Provider.Remove(c.Request.Context(), actorID)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, h.adminDTO(ent))
}
