package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/ai/knowledge"
	aimodel "github.com/michongs/wayfort/internal/ai/model"
	"github.com/michongs/wayfort/internal/ai/provider"
	airepo "github.com/michongs/wayfort/internal/ai/repo"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/sse"
)

// KnowledgeHandler serves knowledge-base + document CRUD, uploads/ingest, the
// embedding-provider designation, and a manual semantic-search probe.
type KnowledgeHandler struct {
	Repo  *airepo.KnowledgeRepo
	Svc   *knowledge.Service
	Embed *provider.EmbeddingResolver
}

// ----- knowledge bases -----

func (h *KnowledgeHandler) List(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	rows, err := h.Repo.ListKBs(c.Request.Context(), claims.UserID, claims.Admin)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"knowledge_bases": rows})
}

type kbPayload struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Scope       string `json:"scope"`
	Enabled     *bool  `json:"enabled"`
}

func (h *KnowledgeHandler) Create(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	var p kbPayload
	if err := c.ShouldBindJSON(&p); err != nil || p.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name required"})
		return
	}
	kb := &aimodel.KnowledgeBase{
		Name: p.Name, Description: p.Description, Enabled: true,
		Backend: h.Svc.Backend(),
	}
	if p.Scope == "global" && claims.Admin {
		kb.Scope = aimodel.AgentScopeGlobal
	} else {
		kb.Scope = aimodel.AgentScopePersonal
		uid := claims.UserID
		kb.OwnerID = &uid
	}
	// Freeze the embedding model now so the UI can show it and ingest stays
	// consistent. A failure here is non-fatal — it resolves again at first ingest.
	if model, err := h.Svc.EmbeddingModel(c.Request.Context()); err == nil {
		kb.EmbeddingModel = model
	}
	if err := h.Repo.CreateKB(c.Request.Context(), kb); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, gin.H{"id": kb.ID, "embedding_model": kb.EmbeddingModel})
}

func (h *KnowledgeHandler) Update(c *gin.Context) {
	kbID := parseU64(c.Param("kb_id"))
	var p kbPayload
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	fields := map[string]any{}
	if p.Name != "" {
		fields["name"] = p.Name
	}
	fields["description"] = p.Description
	if p.Enabled != nil {
		fields["enabled"] = *p.Enabled
	}
	if err := h.Repo.UpdateKB(c.Request.Context(), kbID, fields); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": kbID})
}

func (h *KnowledgeHandler) Delete(c *gin.Context) {
	kbID := parseU64(c.Param("kb_id"))
	if err := h.Repo.DeleteKB(c.Request.Context(), kbID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ----- documents -----

func (h *KnowledgeHandler) ListDocs(c *gin.Context) {
	kbID := parseU64(c.Param("kb_id"))
	docs, err := h.Repo.ListDocs(c.Request.Context(), kbID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"documents": docs})
}

// UploadDoc accepts a multipart file, extracts text, and kicks off async ingest.
func (h *KnowledgeHandler) UploadDoc(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	kbID := parseU64(c.Param("kb_id"))
	fh, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file required"})
		return
	}
	f, err := fh.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 32<<20)) // 32 MiB cap
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	name := fh.Filename
	if q := c.Query("name"); q != "" {
		name = q
	}
	mime := fh.Header.Get("Content-Type")
	text, err := knowledge.Extract(name, mime, data)
	if err != nil {
		c.JSON(http.StatusUnsupportedMediaType, gin.H{"error": err.Error()})
		return
	}
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])
	if dup, _ := h.Repo.FindDocBySHA(c.Request.Context(), kbID, sha); dup != nil {
		c.JSON(http.StatusOK, gin.H{"id": dup.ID, "status": dup.Status, "duplicate": true})
		return
	}
	docID, err := h.Svc.IngestText(c.Request.Context(), kbID, claims.UserID, name, name, mime, text, sha)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	go func() { _ = h.Svc.IngestDocument(context.Background(), docID) }()
	c.JSON(http.StatusAccepted, gin.H{"id": docID, "status": aimodel.DocPending})
}

func (h *KnowledgeHandler) DocStatus(c *gin.Context) {
	docID := parseU64(c.Param("doc_id"))
	doc, err := h.Repo.GetDoc(c.Request.Context(), docID)
	if err != nil || doc == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	c.JSON(http.StatusOK, doc)
}

func (h *KnowledgeHandler) DeleteDoc(c *gin.Context) {
	kbID := parseU64(c.Param("kb_id"))
	docID := parseU64(c.Param("doc_id"))
	if err := h.Repo.DeleteDoc(c.Request.Context(), docID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	_ = h.Repo.RecountKB(c.Request.Context(), kbID)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ImportURL fetches a web page / document by URL (admin-only via route perm),
// extracts text (HTML/PDF/text), and ingests it like an upload. The fetch is
// size- and time-capped; only http(s) schemes are allowed.
func (h *KnowledgeHandler) ImportURL(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	kbID := parseU64(c.Param("kb_id"))
	var p struct {
		URL   string `json:"url"`
		Title string `json:"title"`
	}
	if err := c.ShouldBindJSON(&p); err != nil || strings.TrimSpace(p.URL) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "url required"})
		return
	}
	u, err := url.Parse(strings.TrimSpace(p.URL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "仅支持 http/https URL"})
		return
	}

	ctx, cancel := context.WithTimeout(c.Request.Context(), 25*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	req.Header.Set("User-Agent", "Wayfort-Knowledge-Importer/1.0")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "抓取失败: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("抓取失败: HTTP %d", resp.StatusCode)})
		return
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20)) // 16 MiB cap
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "读取响应失败: " + err.Error()})
		return
	}

	// Derive a display name: explicit title > last path segment > host.
	name := strings.TrimSpace(p.Title)
	if name == "" {
		if seg := path.Base(u.Path); seg != "" && seg != "/" && seg != "." {
			name = seg
		} else {
			name = u.Host
		}
	}
	mime := resp.Header.Get("Content-Type")
	if i := strings.IndexByte(mime, ';'); i >= 0 {
		mime = mime[:i]
	}
	// Give the extractor an extension hint for URLs ending in .pdf etc.
	text, err := knowledge.Extract(path.Base(u.Path), mime, data)
	if err != nil {
		c.JSON(http.StatusUnsupportedMediaType, gin.H{"error": err.Error()})
		return
	}
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])
	if dup, _ := h.Repo.FindDocBySHA(c.Request.Context(), kbID, sha); dup != nil {
		c.JSON(http.StatusOK, gin.H{"id": dup.ID, "status": dup.Status, "duplicate": true})
		return
	}
	docID, err := h.Svc.IngestText(c.Request.Context(), kbID, claims.UserID, name, u.String(), mime, text, sha)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	go func() { _ = h.Svc.IngestDocument(context.Background(), docID) }()
	c.JSON(http.StatusAccepted, gin.H{"id": docID, "status": aimodel.DocPending})
}

func (h *KnowledgeHandler) ReingestDoc(c *gin.Context) {
	docID := parseU64(c.Param("doc_id"))
	doc, err := h.Repo.GetDoc(c.Request.Context(), docID)
	if err != nil || doc == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	go func() { _ = h.Svc.IngestDocument(context.Background(), docID) }()
	c.JSON(http.StatusAccepted, gin.H{"id": docID, "status": aimodel.DocPending})
}

// IngestStream streams the KB's document list every 2s so the UI tracks ingest
// progress live.
func (h *KnowledgeHandler) IngestStream(c *gin.Context) {
	kbID := parseU64(c.Param("kb_id"))
	produce := func(ctx context.Context) (any, error) {
		docs, err := h.Repo.ListDocs(ctx, kbID)
		if err != nil {
			return nil, err
		}
		return gin.H{"documents": docs}, nil
	}
	first, err := produce(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	sse.Snapshots(c, 2*time.Second, first, produce)
}

// ----- manual semantic search probe -----

func (h *KnowledgeHandler) Search(c *gin.Context) {
	var p struct {
		KnowledgeBaseID uint64 `json:"knowledge_base_id"`
		Query           string `json:"query"`
		TopK            int    `json:"top_k"`
	}
	if err := c.ShouldBindJSON(&p); err != nil || p.Query == "" || p.KnowledgeBaseID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "knowledge_base_id and query required"})
		return
	}
	hits, err := h.Svc.SearchAcross(c.Request.Context(), []uint64{p.KnowledgeBaseID}, p.Query, p.TopK)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"hits": hits})
}

// ----- embedding-provider designation -----

func (h *KnowledgeHandler) GetEmbeddingSetting(c *gin.Context) {
	pid, model, dims := h.Embed.Setting()
	c.JSON(http.StatusOK, gin.H{"provider_id": pid, "model": model, "dimensions": dims})
}

func (h *KnowledgeHandler) SetEmbeddingSetting(c *gin.Context) {
	var p struct {
		ProviderID uint64 `json:"provider_id"`
		Model      string `json:"model"`
		Dimensions int    `json:"dimensions"`
	}
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	h.Embed.SetEmbedding(p.ProviderID, p.Model, p.Dimensions)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func parseU64(s string) uint64 {
	v, _ := strconv.ParseUint(s, 10, 64)
	return v
}
