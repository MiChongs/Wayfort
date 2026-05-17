package sftp

import (
	"io"
	"net/http"
	"path"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"go.uber.org/zap"
)

type Handler struct {
	Conn   *Connector
	Audit  *audit.Writer
	Logger *zap.Logger
}

type listEntry struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	Size    int64     `json:"size"`
	Mode    string    `json:"mode"`
	IsDir   bool      `json:"is_dir"`
	ModTime time.Time `json:"mod_time"`
}

func (h *Handler) List(c *gin.Context) {
	nodeID, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad node id"})
		return
	}
	target := c.DefaultQuery("path", ".")
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	entries, err := client.ReadDir(target)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	out := make([]listEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, listEntry{
			Name: e.Name(), Path: path.Join(target, e.Name()),
			Size: e.Size(), Mode: e.Mode().String(),
			IsDir: e.IsDir(), ModTime: e.ModTime(),
		})
	}
	c.JSON(http.StatusOK, gin.H{"path": target, "entries": out})
}

type mkdirReq struct {
	Path string `json:"path" binding:"required"`
}

func (h *Handler) Mkdir(c *gin.Context) {
	nodeID, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var req mkdirReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	if err := client.MkdirAll(req.Path); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) Remove(c *gin.Context) {
	nodeID, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	target := c.Query("path")
	if target == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	info, statErr := client.Stat(target)
	var rmErr error
	if statErr == nil && info.IsDir() {
		rmErr = client.RemoveDirectory(target)
	} else {
		rmErr = client.Remove(target)
	}
	if rmErr != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": rmErr.Error()})
		return
	}
	h.recordFile(c, nodeID, model.AuditFileDelete, target, 0)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) Upload(c *gin.Context) {
	nodeID, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	target := c.Query("path")
	if target == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	file, fh, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "file field required"})
		return
	}
	defer file.Close()
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	dest := path.Join(target, fh.Filename)
	f, err := client.OpenFile(dest, 0o600)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer f.Close()
	n, err := io.Copy(f, file)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	h.recordFile(c, nodeID, model.AuditFileUpload, dest, n)
	c.JSON(http.StatusOK, gin.H{"ok": true, "bytes": n, "path": dest})
}

func (h *Handler) Download(c *gin.Context) {
	nodeID, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	target := c.Query("path")
	if target == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	f, err := client.Open(target)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer f.Close()
	info, _ := f.Stat()
	c.Header("Content-Disposition", "attachment; filename=\""+path.Base(target)+"\"")
	c.Header("Content-Type", "application/octet-stream")
	if info != nil {
		c.Header("Content-Length", strconv.FormatInt(info.Size(), 10))
	}
	n, _ := io.Copy(c.Writer, f)
	h.recordFile(c, nodeID, model.AuditFileDownload, target, n)
}

func (h *Handler) recordFile(c *gin.Context, nodeID uint64, kind model.AuditEventKind, target string, bytes int64) {
	claims := auth.FromContext(c.Request.Context())
	uid := uint64(0)
	username := ""
	if claims != nil {
		uid = claims.UserID
		username = claims.Username
	}
	nid := nodeID
	h.Audit.Log(model.AuditLog{
		Kind: kind, UserID: uid, Username: username,
		NodeID: &nid, ClientIP: c.ClientIP(),
		Payload: target + " bytes=" + strconv.FormatInt(bytes, 10),
	})
}
