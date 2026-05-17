package api

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
)

type CredentialHandler struct {
	Repo   *repo.CredentialRepo
	Sealer *pkgcrypto.Sealer
}

type credPayload struct {
	Name       string `json:"name" binding:"required"`
	Kind       string `json:"kind" binding:"required"`
	Username   string `json:"username"`
	Secret     string `json:"secret" binding:"required"`
	Passphrase string `json:"passphrase"`
}

func (h *CredentialHandler) List(c *gin.Context) {
	rows, err := h.Repo.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Strip raw bytes from response - response uses json:"-" tags already.
	c.JSON(http.StatusOK, gin.H{"credentials": rows})
}

func (h *CredentialHandler) Create(c *gin.Context) {
	var p credPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row, err := h.payloadToRow(p, nil)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": row.ID})
}

func (h *CredentialHandler) Update(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var p credPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row, err = h.payloadToRow(p, row)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	row.ID = id
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": id})
}

func (h *CredentialHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *CredentialHandler) payloadToRow(p credPayload, base *model.Credential) (*model.Credential, error) {
	row := base
	if row == nil {
		row = &model.Credential{}
	}
	row.Name = p.Name
	row.Kind = model.CredentialKind(p.Kind)
	row.Username = p.Username
	sealed, err := h.Sealer.Seal([]byte(p.Secret))
	if err != nil {
		return nil, err
	}
	row.Secret = sealed
	if p.Passphrase != "" {
		ppt, err := h.Sealer.Seal([]byte(p.Passphrase))
		if err != nil {
			return nil, err
		}
		row.Passphrase = ppt
	}
	return row, nil
}
