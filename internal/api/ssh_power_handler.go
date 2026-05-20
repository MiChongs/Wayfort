package api

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/dialer"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgssh "github.com/michongs/jumpserver-anonymous/internal/ssh"
	"github.com/michongs/jumpserver-anonymous/internal/sshrun"
	xssh "golang.org/x/crypto/ssh"
)

// ----- SSH Keys -------------------------------------------------------------

// SSHKeysHandler — Phase 12 user-owned keypair CRUD + generate.
type SSHKeysHandler struct {
	Repo   *repo.SSHKeyRepo
	// Phase 14 — was *pkgcrypto.Sealer pre-envelope; now the Vault
	// interface so private-key + passphrase sealing rides through the
	// per-row DEK + KMS-wrapped KEK path like every other credential.
	Sealer pkgcrypto.Vault
}

type sshKeyRequest struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Public     string `json:"public,omitempty"`
	Private    string `json:"private,omitempty"`
	Passphrase string `json:"passphrase,omitempty"`
}

func (h *SSHKeysHandler) List(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	keys, err := h.Repo.List(c.Request.Context(), uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"keys": keys})
}

// Create — either imports an existing PEM private key or generates a new
// one. When `Private` is empty the handler generates a fresh ED25519 / RSA
// key per `Type`. Public is computed from Private in both flows.
func (h *SSHKeysHandler) Create(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var req sshKeyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name required"})
		return
	}
	if req.Type == "" {
		req.Type = "ed25519"
	}
	privPEM, pubLine, fpr, err := obtainKey(req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	encPriv, err := h.Sealer.Seal([]byte(privPEM))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "seal: " + err.Error()})
		return
	}
	var encPass []byte
	if req.Passphrase != "" {
		encPass, err = h.Sealer.Seal([]byte(req.Passphrase))
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "seal passphrase: " + err.Error()})
			return
		}
	}
	k := &model.SSHKey{
		UserID: uid, Name: strings.TrimSpace(req.Name), Type: req.Type,
		Public: pubLine, Private: encPriv, Passphrase: encPass,
		Fingerprint: fpr,
	}
	if err := h.Repo.Create(c.Request.Context(), k); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Surface the freshly generated PEM exactly once so the user can save
	// it locally; subsequent reads only return metadata + public.
	resp := gin.H{"key": k}
	if req.Private == "" {
		// Only echo the freshly-minted PEM. Imported keys are returned to
		// sender — they already have it.
		resp["private_pem_one_time"] = privPEM
	}
	c.JSON(http.StatusCreated, resp)
}

func (h *SSHKeysHandler) Update(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	k, err := h.Repo.FindByID(c.Request.Context(), uid, id)
	if err != nil || k == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if v := strings.TrimSpace(req.Name); v != "" {
		k.Name = v
	}
	if err := h.Repo.Update(c.Request.Context(), k); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, k)
}

func (h *SSHKeysHandler) Delete(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), uid, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- Known Hosts ----------------------------------------------------------

// KnownHostsHandler — accepted SSH server fingerprint catalog.
type KnownHostsHandler struct {
	Repo *repo.KnownHostRepo
}

func (h *KnownHostsHandler) List(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	rows, err := h.Repo.List(c.Request.Context(), uid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"hosts": rows})
}

type knownHostRequest struct {
	NodeID      *uint64 `json:"node_id"`
	HostAddr    string  `json:"host_addr"`
	HostKeyType string  `json:"host_key_type"`
	Fingerprint string  `json:"fingerprint"`
	Status      string  `json:"status"`
	Notes       string  `json:"notes"`
}

func (h *KnownHostsHandler) Create(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var req knownHostRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.HostAddr == "" || req.Fingerprint == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "host_addr and fingerprint required"})
		return
	}
	if req.Status == "" {
		req.Status = "trusted"
	}
	row := &model.KnownHost{
		UserID: uid, NodeID: req.NodeID, HostAddr: req.HostAddr,
		HostKeyType: req.HostKeyType, Fingerprint: req.Fingerprint,
		Status: req.Status, Notes: req.Notes, AcceptedAt: time.Now(),
	}
	if err := h.Repo.Create(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, row)
}

func (h *KnownHostsHandler) Update(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	row, err := h.Repo.FindByID(c.Request.Context(), uid, id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	var req knownHostRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Status != "" {
		row.Status = req.Status
	}
	row.Notes = req.Notes
	if err := h.Repo.Update(c.Request.Context(), row); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, row)
}

func (h *KnownHostsHandler) Delete(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), uid, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- Bulk Run -------------------------------------------------------------

// BulkRunHandler — execute one command on N nodes in parallel.
type BulkRunHandler struct {
	Repo     *repo.BulkRunRepo
	Nodes    *repo.NodeRepo
	Creds    *repo.CredentialRepo
	Proxies  *repo.ProxyRepo
	Chain    *dialer.ChainBuilder
	Resolver *pkgssh.Resolver
	HostKey  xssh.HostKeyCallback
}

type bulkRunRequest struct {
	Title       string   `json:"title"`
	Command     string   `json:"command"`
	NodeIDs     []uint64 `json:"node_ids"`
	Parallel    int      `json:"parallel"`
	TimeoutSecs int      `json:"timeout_seconds"`
}

const (
	bulkRunMaxNodes    = 100
	bulkRunMaxParallel = 16
)

func (h *BulkRunHandler) Run(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	var req bulkRunRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if strings.TrimSpace(req.Command) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "command required"})
		return
	}
	if len(req.NodeIDs) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "at least one node required"})
		return
	}
	if len(req.NodeIDs) > bulkRunMaxNodes {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("max %d nodes per run", bulkRunMaxNodes)})
		return
	}
	parallel := req.Parallel
	if parallel <= 0 {
		parallel = 4
	}
	if parallel > bulkRunMaxParallel {
		parallel = bulkRunMaxParallel
	}
	timeout := time.Duration(req.TimeoutSecs) * time.Second
	if timeout <= 0 || timeout > 5*time.Minute {
		timeout = 60 * time.Second
	}
	if req.Title == "" {
		req.Title = truncate(req.Command, 64)
	}

	idsJSON, _ := json.Marshal(req.NodeIDs)
	run := &model.BulkRun{
		UserID: uid, Title: req.Title, Command: req.Command,
		NodeIDs: string(idsJSON), NodeCount: len(req.NodeIDs),
	}
	if err := h.Repo.Create(c.Request.Context(), run); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	start := time.Now()
	results := make([]model.BulkRunResult, 0, len(req.NodeIDs))
	var mu sync.Mutex
	sem := make(chan struct{}, parallel)
	var wg sync.WaitGroup

	deps := sshrun.Deps{
		Chain: h.Chain, Resolver: h.Resolver,
		HostKey: h.HostKey, Proxies: h.Proxies,
	}

	for _, id := range req.NodeIDs {
		wg.Add(1)
		go func(nodeID uint64) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			result := model.BulkRunResult{
				RunID: run.ID, NodeID: nodeID, CreatedAt: time.Now(),
			}
			nodeStart := time.Now()
			defer func() {
				result.DurationMs = time.Since(nodeStart).Milliseconds()
				mu.Lock()
				results = append(results, result)
				mu.Unlock()
				_ = h.Repo.AppendResult(c.Request.Context(), &result)
			}()

			node, err := h.Nodes.FindByID(c.Request.Context(), nodeID)
			if err != nil || node == nil {
				result.Error = "node not found"
				return
			}
			result.NodeName = node.Name
			cred, err := h.Creds.FindByID(c.Request.Context(), node.CredentialID)
			if err != nil || cred == nil {
				result.Error = "credential not found"
				return
			}

			ctx, cancel := context.WithTimeout(c.Request.Context(), timeout)
			defer cancel()
			res, err := sshrun.Run(ctx, deps, node, cred, req.Command, 15*time.Second)
			result.Stdout = truncate(res.Stdout, 64*1024)
			result.Stderr = truncate(res.Stderr, 64*1024)
			if err != nil {
				var exitErr *xssh.ExitError
				if errors.As(err, &exitErr) {
					result.ExitCode = exitErr.ExitStatus()
				} else {
					result.Error = err.Error()
					result.ExitCode = -1
				}
			}
		}(id)
	}
	wg.Wait()

	// Aggregate stats + persist.
	okCount, failCount := 0, 0
	var summaryBits []string
	for _, r := range results {
		if r.Error == "" && r.ExitCode == 0 {
			okCount++
		} else {
			failCount++
			if len(summaryBits) < 3 && r.Error != "" {
				summaryBits = append(summaryBits, r.NodeName+": "+truncate(r.Error, 80))
			}
		}
	}
	run.OKCount = okCount
	run.FailCount = failCount
	run.DurationMs = time.Since(start).Milliseconds()
	run.Summary = strings.Join(summaryBits, " · ")
	_ = h.Repo.Update(c.Request.Context(), run)

	c.JSON(http.StatusOK, gin.H{"run": run, "results": results})
}

func (h *BulkRunHandler) List(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "50"))
	rows, err := h.Repo.List(c.Request.Context(), uid, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"runs": rows})
}

func (h *BulkRunHandler) Get(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	run, err := h.Repo.FindByID(c.Request.Context(), uid, id)
	if err != nil || run == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	results, err := h.Repo.ResultsFor(c.Request.Context(), run.ID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"run": run, "results": results})
}

func (h *BulkRunHandler) Delete(c *gin.Context) {
	uid, ok := requireUser(c)
	if !ok {
		return
	}
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	if err := h.Repo.Delete(c.Request.Context(), uid, id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- helpers --------------------------------------------------------------
// `truncate` and `requireUser` live in db_handler.go / terminal_handler.go
// respectively; both files predate Phase 12 in the merged history and the
// implementations are identical, so we reuse them here rather than
// re-declaring (Go errors with "redeclared in this block").

// obtainKey either imports the supplied PEM private key or generates a
// fresh one of the requested type. Returns (PEM private, OpenSSH-format
// public one-liner, SHA-256 fingerprint).
func obtainKey(req sshKeyRequest) (string, string, string, error) {
	if req.Private != "" {
		// import path
		signer, err := xssh.ParsePrivateKey([]byte(req.Private))
		if err != nil && req.Passphrase != "" {
			signer, err = xssh.ParsePrivateKeyWithPassphrase([]byte(req.Private), []byte(req.Passphrase))
		}
		if err != nil {
			return "", "", "", fmt.Errorf("parse private key: %w", err)
		}
		pub := signer.PublicKey()
		return req.Private, formatPublic(pub, req.Name), fingerprintOf(pub), nil
	}
	switch strings.ToLower(req.Type) {
	case "ed25519", "":
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return "", "", "", err
		}
		pemBytes, err := marshalED25519(priv)
		if err != nil {
			return "", "", "", err
		}
		sshPub, err := xssh.NewPublicKey(pub)
		if err != nil {
			return "", "", "", err
		}
		return string(pemBytes), formatPublic(sshPub, req.Name), fingerprintOf(sshPub), nil
	case "rsa-2048", "rsa-3072", "rsa-4096":
		bits := 2048
		if req.Type == "rsa-3072" {
			bits = 3072
		}
		if req.Type == "rsa-4096" {
			bits = 4096
		}
		priv, err := rsa.GenerateKey(rand.Reader, bits)
		if err != nil {
			return "", "", "", err
		}
		pemBytes := pem.EncodeToMemory(&pem.Block{
			Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv),
		})
		sshPub, err := xssh.NewPublicKey(&priv.PublicKey)
		if err != nil {
			return "", "", "", err
		}
		return string(pemBytes), formatPublic(sshPub, req.Name), fingerprintOf(sshPub), nil
	default:
		return "", "", "", fmt.Errorf("unsupported key type: %s", req.Type)
	}
}

// marshalED25519 returns a PKCS#8-PEM encoded ED25519 private key, which
// OpenSSH happily reads. (We avoid OpenSSH's native binary format here
// because the stdlib doesn't expose a marshaler for it.)
func marshalED25519(priv ed25519.PrivateKey) ([]byte, error) {
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	return pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), nil
}

func formatPublic(pub xssh.PublicKey, comment string) string {
	line := strings.TrimSpace(string(xssh.MarshalAuthorizedKey(pub)))
	if comment != "" {
		return line + " " + comment
	}
	return line
}

func fingerprintOf(pub xssh.PublicKey) string {
	sum := sha256.Sum256(pub.Marshal())
	return "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "=")
}
