package oss

import (
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/approval"
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/office"
	"github.com/michongs/jumpserver-anonymous/internal/sesswin"
	"go.uber.org/zap"
)

// textPreviewLimit caps the inline preview/read size (2 MiB). Larger objects
// must be downloaded.
const textPreviewLimit int64 = 2 * 1024 * 1024

// statsScanCap bounds how many objects the stats endpoint will enumerate so a
// bucket with millions of keys can't hang the request.
const statsScanCap = 50000

// assetChecker is the slice of asset.Resolver the handler needs (kept narrow so
// tests can fake it). Mirrors internal/protocols/dbcli.
type assetChecker interface {
	Check(ctx context.Context, userID, nodeID uint64, action string) (bool, error)
}

// Handler serves the REST object-storage browser under /nodes/:id/oss/* plus
// the admin /oss/discover helper. Mirrors internal/sftp.Handler.
type Handler struct {
	Conn     *Connector
	Asset    assetChecker
	Audit    *audit.Writer
	Approval *approval.Service
	Office   *office.Service
	Logger   *zap.Logger
	// Sessions (optional) synthesises a per-(user,node) browsing-window Session
	// row so object operations link to a session. Nil → ops audited without it.
	Sessions *sesswin.Tracker
}

// ---- helpers -------------------------------------------------------------

func parseNodeID(c *gin.Context) (uint64, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad node id"})
		return 0, false
	}
	return id, true
}

func (h *Handler) uid(c *gin.Context) uint64 {
	if claims := auth.FromContext(c.Request.Context()); claims != nil {
		return claims.UserID
	}
	return 0
}

// requireAccess enforces the asset grant for `action` on the node. Writes 403
// and returns false on denial.
func (h *Handler) requireAccess(c *gin.Context, nodeID uint64, action string) bool {
	if h.Asset == nil {
		return true
	}
	ok, err := h.Asset.Check(c.Request.Context(), h.uid(c), nodeID, action)
	if err != nil {
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "access check failed"})
		return false
	}
	if !ok {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "无权对该 OSS 节点执行此操作"})
		return false
	}
	return true
}

// enforceWrite runs the optional approval gate for mutating operations.
func (h *Handler) enforceWrite(c *gin.Context, nodeID uint64, action string) bool {
	if h.Approval == nil {
		return true
	}
	res, err := h.Approval.CheckEnforced(c.Request.Context(), approval.EnforcementCheck{
		UserID:       h.uid(c),
		BusinessType: model.ApprovalBizFileTransfer,
		ResourceType: "node",
		ResourceID:   strconv.FormatUint(nodeID, 10),
		Action:       action,
	})
	if err != nil {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "approval check failed"})
		return false
	}
	if !res.Allowed {
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": res.Reason, "approval_required": true})
		return false
	}
	return true
}

func (h *Handler) logEvent(c *gin.Context, nodeID uint64, kind model.AuditEventKind, payload string) {
	if h.Audit == nil {
		return
	}
	claims := auth.FromContext(c.Request.Context())
	var username string
	var userID uint64
	if claims != nil {
		username = claims.Username
		userID = claims.UserID
	}
	nid := nodeID
	sessionID := h.Sessions.Touch(c.Request.Context(), userID, username, c.ClientIP(), nodeID, 0, 0)
	h.Audit.Log(model.AuditLog{
		Kind:      kind,
		UserID:    userID,
		Username:  username,
		SessionID: sessionID,
		NodeID:    &nid,
		ClientIP:  c.ClientIP(),
		Payload:   payload,
	})
}

// open resolves the node and opens an ObjectStore. On error it writes the
// response and returns ok=false.
func (h *Handler) open(c *gin.Context, nodeID uint64) (ObjectStore, Options, func(), bool) {
	store, opts, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return nil, Options{}, nil, false
	}
	return store, opts, closer, true
}

// normKey strips leading slashes (object keys are never rooted).
func normKey(k string) string { return strings.TrimLeft(k, "/") }

// bucketParam resolves the target bucket from the query, falling back to the
// node's default bucket.
func bucketParam(c *gin.Context, opts Options) string {
	if b := strings.TrimSpace(c.Query("bucket")); b != "" {
		return b
	}
	return opts.DefaultBucket
}

func ctForKey(key string) string {
	if ct := mime.TypeByExtension(path.Ext(key)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// ---- read endpoints ------------------------------------------------------

// Buckets GET /nodes/:id/oss/buckets — list every bucket + node metadata.
func (h *Handler) Buckets(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.requireAccess(c, nodeID, asset.ActionConnect) {
		return
	}
	store, opts, closer, ok := h.open(c, nodeID)
	if !ok {
		return
	}
	defer closer()
	buckets, err := store.ListBuckets(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.logEvent(c, nodeID, model.AuditOSSList, "buckets="+strconv.Itoa(len(buckets)))
	c.JSON(http.StatusOK, gin.H{
		"provider":       store.Provider(),
		"region":         opts.Region,
		"default_bucket": opts.DefaultBucket,
		"buckets":        buckets,
	})
}

// Objects GET /nodes/:id/oss/objects?bucket=&prefix=&token=&max= — one page.
func (h *Handler) Objects(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.requireAccess(c, nodeID, asset.ActionConnect) {
		return
	}
	store, opts, closer, ok := h.open(c, nodeID)
	if !ok {
		return
	}
	defer closer()
	bucket := bucketParam(c, opts)
	if bucket == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 bucket"})
		return
	}
	prefix := normKey(c.Query("prefix"))
	maxKeys := 200
	if m := c.Query("max"); m != "" {
		if n, err := strconv.Atoi(m); err == nil && n > 0 && n <= 1000 {
			maxKeys = n
		}
	}
	res, err := store.ListObjects(c.Request.Context(), bucket, prefix, "/", c.Query("token"), maxKeys)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

// Stat GET /nodes/:id/oss/stat?bucket=&key= — object metadata.
func (h *Handler) Stat(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.requireAccess(c, nodeID, asset.ActionConnect) {
		return
	}
	store, opts, closer, ok := h.open(c, nodeID)
	if !ok {
		return
	}
	defer closer()
	bucket := bucketParam(c, opts)
	key := normKey(c.Query("key"))
	if bucket == "" || key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 bucket 或 key"})
		return
	}
	meta, err := store.HeadObject(c.Request.Context(), bucket, key)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, meta)
}

// Download GET /nodes/:id/oss/download?bucket=&key= — stream the object.
func (h *Handler) Download(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.requireAccess(c, nodeID, asset.ActionFileDownload) {
		return
	}
	store, opts, closer, ok := h.open(c, nodeID)
	if !ok {
		return
	}
	defer closer()
	bucket := bucketParam(c, opts)
	key := normKey(c.Query("key"))
	if bucket == "" || key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 bucket 或 key"})
		return
	}
	body, meta, err := store.GetObject(c.Request.Context(), bucket, key)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer body.Close()
	filename := baseName(key)
	c.Header("Content-Disposition", "attachment; filename*=UTF-8''"+urlEncode(filename))
	if meta != nil && meta.ContentType != "" {
		c.Header("Content-Type", meta.ContentType)
	} else {
		c.Header("Content-Type", "application/octet-stream")
	}
	if meta != nil && meta.Size > 0 {
		c.Header("Content-Length", strconv.FormatInt(meta.Size, 10))
	}
	n, _ := io.Copy(c.Writer, body)
	h.logEvent(c, nodeID, model.AuditOSSDownload, fmt.Sprintf("%s/%s bytes=%d", bucket, key, n))
}

// Preview GET /nodes/:id/oss/preview?bucket=&key= — inline text (<=2MiB).
func (h *Handler) Preview(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.requireAccess(c, nodeID, asset.ActionFileDownload) {
		return
	}
	store, opts, closer, ok := h.open(c, nodeID)
	if !ok {
		return
	}
	defer closer()
	bucket := bucketParam(c, opts)
	key := normKey(c.Query("key"))
	if bucket == "" || key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 bucket 或 key"})
		return
	}
	meta, err := store.HeadObject(c.Request.Context(), bucket, key)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	end := meta.Size - 1
	truncated := false
	if meta.Size > textPreviewLimit {
		end = textPreviewLimit - 1
		truncated = true
	}
	if meta.Size == 0 {
		c.JSON(http.StatusOK, gin.H{"key": key, "size": 0, "content": "", "truncated": false})
		return
	}
	rc, err := store.GetObjectRange(c.Request.Context(), bucket, key, 0, end)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer rc.Close()
	data, err := io.ReadAll(io.LimitReader(rc, textPreviewLimit))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	// Binary sniff on the first 8 KiB.
	sniff := data
	if len(sniff) > 8192 {
		sniff = sniff[:8192]
	}
	for _, b := range sniff {
		if b == 0 {
			c.JSON(http.StatusUnsupportedMediaType, gin.H{"error": "二进制文件 — 请下载", "binary": true, "size": meta.Size})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"key":       key,
		"size":      meta.Size,
		"content":   string(data),
		"truncated": truncated,
	})
}

// Stats GET /nodes/:id/oss/stats?bucket=&prefix= — aggregate object stats.
func (h *Handler) Stats(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.requireAccess(c, nodeID, asset.ActionConnect) {
		return
	}
	store, opts, closer, ok := h.open(c, nodeID)
	if !ok {
		return
	}
	defer closer()
	bucket := bucketParam(c, opts)
	if bucket == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 bucket"})
		return
	}
	prefix := normKey(c.Query("prefix"))

	var totalCount int64
	var totalSize int64
	byClass := map[string]*classStat{}
	histogram := newSizeHistogram()
	type topItem struct {
		Key  string `json:"key"`
		Size int64  `json:"size"`
	}
	top := make([]topItem, 0, 8)
	scanned := 0
	truncated := false
	token := ""
	for {
		res, err := store.ListObjects(c.Request.Context(), bucket, prefix, "", token, 1000)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		for _, e := range res.Entries {
			if e.IsDir {
				continue
			}
			totalCount++
			totalSize += e.Size
			scanned++
			cls := e.StorageClass
			if cls == "" {
				cls = "STANDARD"
			}
			cs := byClass[cls]
			if cs == nil {
				cs = &classStat{}
				byClass[cls] = cs
			}
			cs.Count++
			cs.Size += e.Size
			histogram.add(e.Size)
			top = append(top, topItem{Key: e.Key, Size: e.Size})
			sort.Slice(top, func(i, j int) bool { return top[i].Size > top[j].Size })
			if len(top) > 5 {
				top = top[:5]
			}
		}
		if !res.Truncated || res.NextToken == "" {
			break
		}
		if scanned >= statsScanCap {
			truncated = true
			break
		}
		token = res.NextToken
	}

	classes := make([]gin.H, 0, len(byClass))
	for cls, cs := range byClass {
		classes = append(classes, gin.H{"class": cls, "count": cs.Count, "size": cs.Size})
	}
	sort.Slice(classes, func(i, j int) bool { return classes[i]["size"].(int64) > classes[j]["size"].(int64) })

	c.JSON(http.StatusOK, gin.H{
		"bucket":         bucket,
		"prefix":         prefix,
		"object_count":   totalCount,
		"total_size":     totalSize,
		"scanned":        scanned,
		"truncated":      truncated,
		"storage_class":  classes,
		"size_histogram": histogram.buckets(),
		"largest":        top,
	})
}

type classStat struct {
	Count int64
	Size  int64
}

// ---- write endpoints -----------------------------------------------------

// Upload POST /nodes/:id/oss/upload?bucket=&prefix=&name= (multipart "file").
func (h *Handler) Upload(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.requireAccess(c, nodeID, asset.ActionFileUpload) {
		return
	}
	if !h.enforceWrite(c, nodeID, "upload") {
		return
	}
	store, opts, closer, ok := h.open(c, nodeID)
	if !ok {
		return
	}
	defer closer()
	bucket := bucketParam(c, opts)
	if bucket == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 bucket"})
		return
	}
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少上传文件"})
		return
	}
	name := strings.TrimSpace(c.Query("name"))
	if name == "" {
		name = fileHeader.Filename
	}
	name = path.Base(name)
	prefix := normKey(c.Query("prefix"))
	if prefix != "" && !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	key := prefix + name
	f, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer f.Close()
	if err := store.PutObject(c.Request.Context(), bucket, key, f, fileHeader.Size, ctForKey(key)); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.logEvent(c, nodeID, model.AuditOSSUpload, fmt.Sprintf("%s/%s bytes=%d", bucket, key, fileHeader.Size))
	c.JSON(http.StatusOK, gin.H{"ok": true, "bucket": bucket, "key": key, "bytes": fileHeader.Size})
}

// Mkdir POST /nodes/:id/oss/mkdir {bucket, prefix} — zero-byte folder marker.
func (h *Handler) Mkdir(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.requireAccess(c, nodeID, asset.ActionFileUpload) {
		return
	}
	if !h.enforceWrite(c, nodeID, "upload") {
		return
	}
	var body struct {
		Bucket string `json:"bucket"`
		Prefix string `json:"prefix"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	store, opts, closer, ok := h.open(c, nodeID)
	if !ok {
		return
	}
	defer closer()
	bucket := body.Bucket
	if bucket == "" {
		bucket = opts.DefaultBucket
	}
	key := normKey(body.Prefix)
	if key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少文件夹路径"})
		return
	}
	if !strings.HasSuffix(key, "/") {
		key += "/"
	}
	if err := store.PutObject(c.Request.Context(), bucket, key, strings.NewReader(""), 0, ""); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.logEvent(c, nodeID, model.AuditOSSMkdir, bucket+"/"+key)
	c.JSON(http.StatusOK, gin.H{"ok": true, "bucket": bucket, "key": key})
}

// Delete DELETE /nodes/:id/oss/object?bucket=&key=&recursive= — object or folder.
func (h *Handler) Delete(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.requireAccess(c, nodeID, asset.ActionFileUpload) {
		return
	}
	if !h.enforceWrite(c, nodeID, "upload") {
		return
	}
	store, opts, closer, ok := h.open(c, nodeID)
	if !ok {
		return
	}
	defer closer()
	bucket := bucketParam(c, opts)
	key := normKey(c.Query("key"))
	if bucket == "" || key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 bucket 或 key"})
		return
	}
	recursive := c.Query("recursive") == "true" || strings.HasSuffix(key, "/")
	deleted := 0
	if recursive {
		n, err := h.deletePrefix(c.Request.Context(), store, bucket, key)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		deleted = n
	} else {
		if err := store.DeleteObject(c.Request.Context(), bucket, key); err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		deleted = 1
	}
	h.logEvent(c, nodeID, model.AuditOSSDelete, fmt.Sprintf("%s/%s count=%d", bucket, key, deleted))
	c.JSON(http.StatusOK, gin.H{"ok": true, "deleted": deleted})
}

// deletePrefix removes every object under a prefix (the folder marker included).
func (h *Handler) deletePrefix(ctx context.Context, store ObjectStore, bucket, prefix string) (int, error) {
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	count := 0
	token := ""
	for {
		res, err := store.ListObjects(ctx, bucket, prefix, "", token, 1000)
		if err != nil {
			return count, err
		}
		for _, e := range res.Entries {
			if e.IsDir {
				continue
			}
			if err := store.DeleteObject(ctx, bucket, e.Key); err != nil {
				return count, err
			}
			count++
		}
		if !res.Truncated || res.NextToken == "" {
			break
		}
		token = res.NextToken
	}
	// Best-effort remove the folder marker itself.
	_ = store.DeleteObject(ctx, bucket, prefix)
	return count, nil
}

// Copy POST /nodes/:id/oss/copy {bucket, src, dst, dst_bucket?, move} — copy or move/rename.
func (h *Handler) Copy(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.requireAccess(c, nodeID, asset.ActionFileUpload) {
		return
	}
	if !h.enforceWrite(c, nodeID, "upload") {
		return
	}
	var body struct {
		Bucket    string `json:"bucket"`
		DstBucket string `json:"dst_bucket"`
		Src       string `json:"src"`
		Dst       string `json:"dst"`
		Move      bool   `json:"move"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	store, opts, closer, ok := h.open(c, nodeID)
	if !ok {
		return
	}
	defer closer()
	srcBucket := body.Bucket
	if srcBucket == "" {
		srcBucket = opts.DefaultBucket
	}
	dstBucket := body.DstBucket
	if dstBucket == "" {
		dstBucket = srcBucket
	}
	src := normKey(body.Src)
	dst := normKey(body.Dst)
	if srcBucket == "" || src == "" || dst == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少源或目标"})
		return
	}
	ctx := c.Request.Context()
	copied := 0
	if strings.HasSuffix(src, "/") {
		// Folder: copy every object under src to dst + relative path.
		if !strings.HasSuffix(dst, "/") {
			dst += "/"
		}
		token := ""
		for {
			res, err := store.ListObjects(ctx, srcBucket, src, "", token, 1000)
			if err != nil {
				c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
				return
			}
			for _, e := range res.Entries {
				if e.IsDir {
					continue
				}
				rel := strings.TrimPrefix(e.Key, src)
				if err := store.CopyObject(ctx, srcBucket, e.Key, dstBucket, dst+rel); err != nil {
					c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
					return
				}
				copied++
			}
			if !res.Truncated || res.NextToken == "" {
				break
			}
			token = res.NextToken
		}
	} else {
		if err := store.CopyObject(ctx, srcBucket, src, dstBucket, dst); err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		copied = 1
	}
	h.logEvent(c, nodeID, model.AuditOSSCopy, fmt.Sprintf("%s/%s -> %s/%s count=%d move=%v", srcBucket, src, dstBucket, dst, copied, body.Move))
	if body.Move {
		if strings.HasSuffix(src, "/") {
			if _, err := h.deletePrefix(ctx, store, srcBucket, src); err != nil {
				c.JSON(http.StatusBadGateway, gin.H{"error": "copied but source cleanup failed: " + err.Error()})
				return
			}
		} else {
			_ = store.DeleteObject(ctx, srcBucket, src)
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "copied": copied, "move": body.Move})
}

// ---- admin discover ------------------------------------------------------

// Discover POST /oss/discover — admin helper for the node create flow: given a
// provider/endpoint/region + credential, list the visible buckets so the admin
// can visually pick a default bucket. Gated by node-create permission at the
// route level (no per-node grant — the node doesn't exist yet).
func (h *Handler) Discover(c *gin.Context) {
	var body struct {
		Provider     string `json:"provider"`
		Endpoint     string `json:"endpoint"`
		Region       string `json:"region"`
		CredentialID uint64 `json:"credential_id"`
		ProxyChain   string `json:"proxy_chain"`
		InsecureTLS  bool   `json:"insecure_tls"`
		PathStyle    bool   `json:"path_style"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.CredentialID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请选择访问密钥凭据"})
		return
	}
	opts := normalize(Options{
		Provider:    body.Provider,
		Endpoint:    body.Endpoint,
		Region:      body.Region,
		InsecureTLS: body.InsecureTLS,
		PathStyle:   body.PathStyle,
	})
	store, closer, err := h.Conn.OpenDiscover(c.Request.Context(), opts, body.CredentialID, body.ProxyChain)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	buckets, err := store.ListBuckets(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "连接成功但列举 Bucket 失败：" + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "provider": store.Provider(), "buckets": buckets})
}

// ---- size histogram ------------------------------------------------------

type sizeHistogram struct {
	counts []int64
}

var histEdges = []int64{
	1 << 10,        // 1 KiB
	1 << 20,        // 1 MiB
	100 * (1 << 20), // 100 MiB
	1 << 30,        // 1 GiB
}
var histLabels = []string{"<1KB", "1KB–1MB", "1MB–100MB", "100MB–1GB", ">1GB"}

func newSizeHistogram() *sizeHistogram { return &sizeHistogram{counts: make([]int64, len(histLabels))} }

func (s *sizeHistogram) add(size int64) {
	for i, edge := range histEdges {
		if size < edge {
			s.counts[i]++
			return
		}
	}
	s.counts[len(s.counts)-1]++
}

func (s *sizeHistogram) buckets() []gin.H {
	out := make([]gin.H, len(histLabels))
	for i, l := range histLabels {
		out[i] = gin.H{"label": l, "count": s.counts[i]}
	}
	return out
}

// urlEncode percent-encodes a filename for Content-Disposition (RFC 5987).
func urlEncode(s string) string {
	var b strings.Builder
	for _, r := range []byte(s) {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' || r == '~' {
			b.WriteByte(r)
		} else {
			b.WriteString(fmt.Sprintf("%%%02X", r))
		}
	}
	return b.String()
}
