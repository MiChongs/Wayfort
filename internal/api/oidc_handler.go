package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	pkgcrypto "github.com/michongs/wayfort/pkg/crypto"
)

// OIDCClientHandler manages registered upstream IdPs.
type OIDCClientHandler struct {
	Repo    *repo.OIDCClientRepo
	Sealer  pkgcrypto.Vault
	Manager *auth.OIDCManager
}

type oidcPayload struct {
	Name           string `json:"name"`
	DisplayName    string `json:"display_name"`
	Issuer         string `json:"issuer"`
	ClientID       string `json:"client_id"`
	ClientSecret   string `json:"client_secret"`
	RedirectURI    string `json:"redirect_uri"`
	Scopes         string `json:"scopes"`
	UsernameClaim  string `json:"username_claim"`
	EmailClaim     string `json:"email_claim"`
	AutoCreateUser bool   `json:"auto_create_user"`
	DefaultRole    string `json:"default_role"`
	Enabled        bool   `json:"enabled"`
}

func (h *OIDCClientHandler) List(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		// Never echo decrypted secrets; show a hint instead.
		hint := ""
		if len(r.ClientSecretEncrypted) > 0 {
			hint = "<set>"
		}
		out = append(out, gin.H{
			"id": r.ID, "name": r.Name, "display_name": r.DisplayName,
			"issuer": r.Issuer, "client_id": r.ClientID,
			"client_secret": hint, "redirect_uri": r.RedirectURI,
			"scopes": r.Scopes, "username_claim": r.UsernameClaim,
			"email_claim": r.EmailClaim, "auto_create_user": r.AutoCreateUser,
			"default_role": r.DefaultRole, "enabled": r.Enabled,
		})
	}
	c.JSON(http.StatusOK, gin.H{"oidc_clients": out})
}

func (h *OIDCClientHandler) Create(c *gin.Context) {
	var p oidcPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row, err := h.payload(&p, nil)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.Manager != nil {
		h.Manager.Invalidate(row.Name)
	}
	c.JSON(http.StatusCreated, gin.H{"id": row.ID})
}

func (h *OIDCClientHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p oidcPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row, err = h.payload(&p, row)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if h.Manager != nil {
		h.Manager.Invalidate(row.Name)
	}
	c.JSON(http.StatusOK, gin.H{"id": row.ID})
}

func (h *OIDCClientHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, _ := h.Repo.FindByID(c.Request.Context(), id)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if row != nil && h.Manager != nil {
		h.Manager.Invalidate(row.Name)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *OIDCClientHandler) payload(p *oidcPayload, base *model.OIDCClient) (*model.OIDCClient, error) {
	row := base
	if row == nil {
		row = &model.OIDCClient{}
	}
	if p.Name != "" {
		row.Name = p.Name
	}
	row.DisplayName = p.DisplayName
	if p.Issuer != "" {
		row.Issuer = p.Issuer
	}
	if p.ClientID != "" {
		row.ClientID = p.ClientID
	}
	row.RedirectURI = p.RedirectURI
	row.Scopes = p.Scopes
	row.UsernameClaim = p.UsernameClaim
	row.EmailClaim = p.EmailClaim
	row.AutoCreateUser = p.AutoCreateUser
	row.DefaultRole = p.DefaultRole
	row.Enabled = p.Enabled
	if p.ClientSecret != "" {
		sealed, err := h.Sealer.Seal([]byte(p.ClientSecret))
		if err != nil {
			return nil, err
		}
		row.ClientSecretEncrypted = sealed
	}
	return row, nil
}
