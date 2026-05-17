package api

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type AuthHandler struct {
	Registry *auth.Registry
	Issuer   *auth.Issuer
	Audit    *audit.Writer
	AnonEna  bool
}

func (h *AuthHandler) Login(c *gin.Context) {
	provider := c.DefaultQuery("provider", "local")
	p, ok := h.Registry.Get(provider)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "unknown provider"})
		return
	}
	var payload auth.LoginPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	user, err := p.Login(c.Request.Context(), payload)
	if err != nil {
		h.Audit.Log(model.AuditLog{
			Kind: model.AuditLoginFailed, Username: payload.Username, ClientIP: c.ClientIP(),
			Payload: err.Error(),
		})
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	pair, err := h.Issuer.Issue(auth.Claims{
		UserID: user.ID, Username: user.Username, Admin: user.IsAdmin,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.Audit.Log(model.AuditLog{
		Kind: model.AuditLogin, UserID: user.ID, Username: user.Username, ClientIP: c.ClientIP(),
	})
	c.JSON(http.StatusOK, pair)
}

type refreshReq struct {
	RefreshToken string `json:"refresh_token" binding:"required"`
}

func (h *AuthHandler) Refresh(c *gin.Context) {
	var req refreshReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	claims, err := h.Issuer.Parse(req.RefreshToken)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
		return
	}
	pair, err := h.Issuer.Issue(auth.Claims{
		UserID: claims.UserID, Username: claims.Username, Admin: claims.Admin,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, pair)
}

// Anonymous issues a short-lived JWT marked anonymous=true. The endpoint is
// public; callers should add per-IP rate limiting at the reverse proxy layer.
func (h *AuthHandler) Anonymous(c *gin.Context) {
	if !h.AnonEna {
		c.JSON(http.StatusForbidden, gin.H{"error": "anonymous disabled"})
		return
	}
	pair, err := h.Issuer.Issue(auth.Claims{
		UserID: 0, Username: "anonymous-" + c.ClientIP(), Anonymous: true,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, pair)
}
