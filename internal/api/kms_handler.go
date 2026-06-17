package api

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	"github.com/michongs/wayfort/internal/secrets"
	"github.com/michongs/wayfort/pkg/kms"
)

// KMSHandler exposes the Phase 14 setup endpoints for registering,
// testing, promoting and deleting KMS providers.
//
// Auth model
// ----------
// All endpoints require an authenticated admin (gated at the route
// definition with `auth.RequireAdmin()` middleware). The KMS auth
// material we ingest here (Vault SecretID, AWS static keys, etc.) is
// the high-water mark of the entire credential pool — anyone with
// the ability to register a new primary KMS has root over every
// credential the gateway holds.
//
// What this handler does NOT do
// -----------------------------
//   - It does not initialise the seal material. That happens once
//     during `secrets.Bootstrap` at process start, sourcing the
//     unseal passphrase from a 0600 file under
//     `cfg.Crypto.UnsealPassphraseFile`. Operators who want to
//     rotate the passphrase use a separate (out-of-scope-here)
//     re-seal CLI to keep the surface attack-minimal.
//   - It does not surface plaintext KEK material. Every endpoint
//     that ingests auth_ciphertext seals it through the
//     bootstrap unsealer before persistence; nothing reads it back.
//
// Response shape
// --------------
// Every endpoint returns:
//
//   { "ok": true,  "data":  {...} }   on success
//   { "ok": false, "error": "..." }   on error
//
// Matching the convention used elsewhere under /api/v1.
type KMSHandler struct {
	Providers *repo.KMSProviderRepo
	Envelopes *repo.SecretEnvelopeRepo
	Audits    *repo.SecretAuditRepo
	Service   *secrets.Service

	// Unsealer is the bootstrap-derived key that wraps the AuthCiphertext
	// we persist for cloud-KMS providers. Nil only in the (impossible
	// for production) case the gateway booted in sealed mode.
	Unsealer *kms.Unsealer
}

type kmsProviderPayload struct {
	Name        string `json:"name"`
	Kind        string `json:"kind"`
	DisplayName string `json:"display_name"`
	Description string `json:"description"`
	Endpoint    string `json:"endpoint"`
	KeyID       string `json:"key_id"`
	Namespace   string `json:"namespace"`
	AuthMethod  string `json:"auth_method"`
	AuthRoleID  string `json:"auth_role_id"`
	// AuthPlaintext is the raw secret credential (Vault SecretID, AWS
	// JSON-encoded static keys, Azure client secret, GCP SA JSON, …).
	// Sent over TLS only and never persisted in this form — the handler
	// seals it via the bootstrap unsealer before writing the row.
	AuthPlaintext string `json:"auth_secret"`
	ExtraJSON     string `json:"extra"`
	Enabled       bool   `json:"enabled"`
	Promote       bool   `json:"promote"`
}

// List returns every provider row + envelope counts. Used by the
// setup UI to render the "configured KMS" tab.
func (h *KMSHandler) List(c *gin.Context) {
	rows, err := h.Providers.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, r := range rows {
		active, rotated, _ := h.Envelopes.CountByProvider(c.Request.Context(), r.ID)
		out = append(out, gin.H{
			"id":           r.ID,
			"name":         r.Name,
			"kind":         r.Kind,
			"display_name": r.DisplayName,
			"description":  r.Description,
			"endpoint":     r.Endpoint,
			"key_id":       r.KeyID,
			"namespace":    r.Namespace,
			"auth_method":  r.AuthMethod,
			"auth_role_id": r.AuthRoleID,
			"is_primary":   r.IsPrimary,
			"enabled":      r.Enabled,
			"envelopes_active":  active,
			"envelopes_rotated": rotated,
			"created_at":   r.CreatedAt,
			"updated_at":   r.UpdatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "providers": out})
}

// Status surfaces the current primary KMS + seal state. Used by the
// setup banner to nudge operators off the Local provider.
func (h *KMSHandler) Status(c *gin.Context) {
	primary, err := h.Providers.Primary(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	resp := gin.H{
		"ok":        true,
		"sealed":    h.Service.PrimaryProvider() == nil,
		"primary":   nil,
	}
	if primary != nil {
		resp["primary"] = gin.H{
			"id":          primary.ID,
			"name":        primary.Name,
			"kind":        primary.Kind,
			"display":     primary.DisplayName,
			"is_default":  primary.Kind == model.KMSKindLocal && primary.Name == "default-local",
		}
	}
	c.JSON(http.StatusOK, resp)
}

// Create persists a new KMSProvider row. The supplied AuthPlaintext is
// sealed via the bootstrap unsealer before storage. If `promote` is
// true the new provider is set primary in the same transaction — but
// only after a healthcheck succeeds.
func (h *KMSHandler) Create(c *gin.Context) {
	if h.Unsealer == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "error": "gateway sealed — unseal first"})
		return
	}
	var p kmsProviderPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": err.Error()})
		return
	}
	if p.Name == "" || p.Kind == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "name and kind required"})
		return
	}
	if !validateExtraJSON(p.ExtraJSON) {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "extra must be a valid JSON object"})
		return
	}

	row := &model.KMSProvider{
		Name:        p.Name,
		Kind:        model.KMSProviderKind(p.Kind),
		DisplayName: p.DisplayName,
		Description: p.Description,
		Endpoint:    p.Endpoint,
		KeyID:       p.KeyID,
		Namespace:   p.Namespace,
		AuthMethod:  p.AuthMethod,
		AuthRoleID:  p.AuthRoleID,
		ExtraJSON:   p.ExtraJSON,
		Enabled:     p.Enabled,
		CreatedAt:   time.Now().UTC(),
		UpdatedAt:   time.Now().UTC(),
	}
	if p.AuthPlaintext != "" {
		sealed, err := h.Unsealer.Seal([]byte(p.AuthPlaintext))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "seal auth: " + err.Error()})
			return
		}
		row.AuthCiphertext = sealed
	}

	// Healthcheck the configuration before persisting. If the
	// operator wants to promote this provider, the check is
	// mandatory; otherwise we still run it but treat failures as
	// warnings — sometimes a provider is registered weeks before
	// it's reachable.
	authPlain := []byte(p.AuthPlaintext)
	healthErr := healthcheckProvider(c.Request.Context(), row, authPlain)
	if p.Promote && healthErr != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "healthcheck failed; refusing to promote: " + healthErr.Error()})
		return
	}

	if p.Promote {
		row.IsPrimary = true
	}
	if err := h.Providers.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}

	// If we promoted, swap the live primary on the Service.
	if p.Promote {
		newPrimary, err := kms.New(c.Request.Context(), kms.ProviderRow{
			ID:            row.ID,
			Name:          row.Name,
			Kind:          kms.Kind(row.Kind),
			Endpoint:      row.Endpoint,
			KeyID:         row.KeyID,
			Namespace:     row.Namespace,
			AuthMethod:    row.AuthMethod,
			AuthRoleID:    row.AuthRoleID,
			AuthPlaintext: authPlain,
			ExtraJSON:     row.ExtraJSON,
		})
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "construct primary: " + err.Error()})
			return
		}
		h.Service.SetPrimary(newPrimary, row)
	}

	c.JSON(http.StatusCreated, gin.H{
		"ok":             true,
		"id":             row.ID,
		"is_primary":     row.IsPrimary,
		"healthcheck":    healthErr == nil,
		"healthcheck_err": errString(healthErr),
	})
}

// Test runs a healthcheck on a stored provider without changing
// state. Used by the setup UI's "test connection" button.
func (h *KMSHandler) Test(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Providers.FindByID(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	if row == nil {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "provider not found"})
		return
	}
	authPlain, err := h.Unsealer.Open(row.AuthCiphertext)
	if err != nil && len(row.AuthCiphertext) > 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "unseal auth: " + err.Error()})
		return
	}
	if err := healthcheckProvider(c.Request.Context(), row, authPlain); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Promote sets the provider as primary. After this returns, fresh
// envelopes wrap under the new KEK; existing envelopes stay readable
// via their persisted ProviderID. Use POST /:id/rewrap to migrate the
// payload.
func (h *KMSHandler) Promote(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Providers.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "error": "provider not found"})
		return
	}
	authPlain, err := h.Unsealer.Open(row.AuthCiphertext)
	if err != nil && len(row.AuthCiphertext) > 0 {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": "unseal auth: " + err.Error()})
		return
	}
	pr, err := kms.New(c.Request.Context(), kms.ProviderRow{
		ID:            row.ID,
		Name:          row.Name,
		Kind:          kms.Kind(row.Kind),
		Endpoint:      row.Endpoint,
		KeyID:         row.KeyID,
		Namespace:     row.Namespace,
		AuthMethod:    row.AuthMethod,
		AuthRoleID:    row.AuthRoleID,
		AuthPlaintext: authPlain,
		ExtraJSON:     row.ExtraJSON,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	if err := pr.Healthcheck(c.Request.Context()); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"ok": false, "error": "healthcheck failed: " + err.Error()})
		return
	}
	if err := h.Providers.SetPrimary(c.Request.Context(), row.ID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	row.IsPrimary = true
	h.Service.SetPrimary(pr, row)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Delete removes a provider. Refuses if any active envelope still
// points at it — operator must rewrap those first.
func (h *KMSHandler) Delete(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	active, _, err := h.Envelopes.CountByProvider(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	if active > 0 {
		c.JSON(http.StatusConflict, gin.H{"ok": false, "error": "active envelopes still reference this provider; rewrap them first", "active_envelopes": active})
		return
	}
	if err := h.Providers.Delete(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Rewrap re-wraps every envelope currently pointing at a non-primary
// provider under the new primary. Streams progress back as JSON
// lines; caller can issue with -N HTTP/1.1 to read incrementally.
//
// Synchronous because rewrap is rate-limited by the KMS network
// round-trip — even 100k envelopes finish in minutes.
func (h *KMSHandler) Rewrap(c *gin.Context) {
	srcID, _ := strconv.ParseUint(c.Query("from"), 10, 64)
	if srcID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "error": "from=<provider_id> query param required"})
		return
	}

	c.Writer.Header().Set("Content-Type", "application/json")
	c.Writer.WriteHeader(http.StatusOK)

	total, rotated := 0, 0
	var afterID uint64
	for {
		batch, err := h.Envelopes.ListByProvider(c.Request.Context(), srcID, model.EnvelopeActive, 64, afterID)
		if err != nil {
			writeJSONLine(c, gin.H{"event": "error", "error": err.Error()})
			return
		}
		if len(batch) == 0 {
			break
		}
		for _, env := range batch {
			total++
			if err := h.Service.Rewrap(c.Request.Context(), env.ID, secrets.AuditContext{}); err != nil {
				writeJSONLine(c, gin.H{"event": "envelope_failed", "id": env.ID, "error": err.Error()})
				continue
			}
			rotated++
			afterID = env.ID
		}
		writeJSONLine(c, gin.H{"event": "progress", "total": total, "rotated": rotated})
	}
	writeJSONLine(c, gin.H{"event": "done", "total": total, "rotated": rotated})
}

func writeJSONLine(c *gin.Context, body gin.H) {
	b, _ := json.Marshal(body)
	c.Writer.Write(b) //nolint:errcheck
	c.Writer.Write([]byte("\n")) //nolint:errcheck
	c.Writer.Flush()
}

func validateExtraJSON(s string) bool {
	if s == "" {
		return true
	}
	var m map[string]any
	return json.Unmarshal([]byte(s), &m) == nil
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// healthcheckProvider constructs a KMS instance from the row + plain
// auth material (taken straight from the caller's payload, not from
// the sealed column) and runs a round-trip wrap/unwrap.
func healthcheckProvider(ctx context.Context, row *model.KMSProvider, authPlain []byte) error {
	pr, err := kms.New(ctx, kms.ProviderRow{
		Name:          row.Name,
		Kind:          kms.Kind(row.Kind),
		Endpoint:      row.Endpoint,
		KeyID:         row.KeyID,
		Namespace:     row.Namespace,
		AuthMethod:    row.AuthMethod,
		AuthRoleID:    row.AuthRoleID,
		AuthPlaintext: authPlain,
		ExtraJSON:     row.ExtraJSON,
	})
	if err != nil {
		return err
	}
	return pr.Healthcheck(ctx)
}
