package api

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/pki"
	"github.com/michongs/wayfort/internal/repo"
)

// PKIHandler is the admin view of the internal certificate authority
// (security-architecture.md §6): CA metadata and the issued-certificate ledger
// with revocation. Requires the pki:manage permission.
type PKIHandler struct {
	Repo *repo.PKIRepo
	PKI  *pki.Service
}

// CA returns the active CA's subject/validity/bundle/mode.
func (h *PKIHandler) CA(c *gin.Context) {
	if h.PKI == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "pki not available"})
		return
	}
	c.JSON(http.StatusOK, h.PKI.Info())
}

// Certificates lists the issued-certificate ledger, optionally filtered by
// subject kind. Each row carries a derived live status (active/expired/revoked).
func (h *PKIHandler) Certificates(c *gin.Context) {
	subjectKind := c.Query("subject_kind")
	rows, err := h.Repo.ListCerts(c.Request.Context(), subjectKind, 0)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	now := time.Now()
	type certView struct {
		Serial      string  `json:"serial"`
		SubjectKind string  `json:"subject_kind"`
		SubjectID   uint64  `json:"subject_id"`
		Fingerprint string  `json:"fingerprint"`
		NotBefore   string  `json:"not_before"`
		NotAfter    string  `json:"not_after"`
		Status      string  `json:"status"`
		RevokeReason string `json:"revoke_reason,omitempty"`
	}
	out := make([]certView, 0, len(rows))
	for _, r := range rows {
		status := "active"
		switch {
		case r.Revoked():
			status = "revoked"
		case now.After(r.NotAfter):
			status = "expired"
		}
		out = append(out, certView{
			Serial: r.Serial, SubjectKind: r.SubjectKind, SubjectID: r.SubjectID,
			Fingerprint: r.Fingerprint,
			NotBefore:   r.NotBefore.Format(time.RFC3339),
			NotAfter:    r.NotAfter.Format(time.RFC3339),
			Status:      status, RevokeReason: r.RevokeReason,
		})
	}
	c.JSON(http.StatusOK, gin.H{"certificates": out})
}

// Revoke revokes a certificate by serial.
func (h *PKIHandler) Revoke(c *gin.Context) {
	serial := c.Param("serial")
	if serial == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "serial required"})
		return
	}
	if h.PKI == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "pki not available"})
		return
	}
	if err := h.PKI.Revoke(c.Request.Context(), serial, "revoked by admin"); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
