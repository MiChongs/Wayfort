package desktop

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/config"
	"github.com/michongs/wayfort/internal/model"
	"go.uber.org/zap"
)

// DriveHandler is the browser-facing file API for the per-user drive that gets
// redirected into RDP sessions. Everything it touches lives under
// <cfg.Dir>/user-<id>, so a user only ever sees their own files, and the same
// folder is the one mounted in the remote desktop — an upload here shows up in
// the remote "This PC" immediately, and a file the remote drops in the drive
// can be downloaded here.
type DriveHandler struct {
	cfg    config.DesktopDriveConfig
	audit  *audit.Writer
	logger *zap.Logger
}

func NewDriveHandler(cfg config.DesktopDriveConfig, aud *audit.Writer, logger *zap.Logger) *DriveHandler {
	return &DriveHandler{cfg: cfg, audit: aud, logger: logger}
}

type driveEntry struct {
	Name    string    `json:"name"`
	IsDir   bool      `json:"is_dir"`
	Size    int64     `json:"size"`
	ModTime time.Time `json:"mod_time"`
}

func (h *DriveHandler) enabled() bool { return h.cfg.Enabled && h.cfg.Dir != "" }

// userRoot resolves and lazily creates the caller's drive folder.
func (h *DriveHandler) userRoot(userID uint64) (string, error) {
	root := filepath.Join(h.cfg.Dir, fmt.Sprintf("user-%d", userID))
	if err := os.MkdirAll(root, 0o750); err != nil {
		return "", err
	}
	return root, nil
}

// safeJoin resolves a user-supplied relative path against root and guarantees
// the result stays inside root (no traversal via .. or absolute paths).
func safeJoin(root, rel string) (string, bool) {
	rel = strings.ReplaceAll(rel, "\\", "/")
	clean := filepath.Clean("/" + strings.TrimPrefix(rel, "/"))
	full := filepath.Join(root, clean)
	rp, err := filepath.Abs(root)
	if err != nil {
		return "", false
	}
	fp, err := filepath.Abs(full)
	if err != nil {
		return "", false
	}
	if fp != rp && !strings.HasPrefix(fp, rp+string(os.PathSeparator)) {
		return "", false
	}
	return fp, true
}

func dirSize(root string) int64 {
	var total int64
	_ = filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err == nil && info != nil && !info.IsDir() {
			total += info.Size()
		}
		return nil
	})
	return total
}

func (h *DriveHandler) claims(c *gin.Context) *auth.Claims {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		return nil
	}
	return claims
}

func (h *DriveHandler) log(claims *auth.Claims, c *gin.Context, kind model.AuditEventKind, payload string) {
	if h.audit == nil || claims == nil {
		return
	}
	h.audit.Log(model.AuditLog{
		Kind: kind, UserID: claims.UserID, Username: claims.Username,
		ClientIP: c.ClientIP(), Payload: payload,
	})
}

// Info — GET /desktop/drive — feature flags + current usage.
func (h *DriveHandler) Info(c *gin.Context) {
	claims := h.claims(c)
	if claims == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	var used int64
	if h.enabled() {
		if root, err := h.userRoot(claims.UserID); err == nil {
			used = dirSize(root)
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"enabled":        h.enabled(),
		"name":           h.cfg.Name,
		"allow_upload":   h.cfg.AllowUpload,
		"allow_download": h.cfg.AllowDownload,
		"max_file_mb":    h.cfg.MaxFileMB,
		"max_total_mb":   h.cfg.MaxTotalMB,
		"used_bytes":     used,
	})
}

// List — GET /desktop/drive/list?path= — directory listing.
func (h *DriveHandler) List(c *gin.Context) {
	claims := h.claims(c)
	if claims == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	if !h.enabled() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "文件盘未启用"})
		return
	}
	root, err := h.userRoot(claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	dir, ok := safeJoin(root, c.Query("path"))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "非法路径"})
		return
	}
	items, err := os.ReadDir(dir)
	if err != nil {
		c.JSON(http.StatusOK, gin.H{"entries": []driveEntry{}})
		return
	}
	out := make([]driveEntry, 0, len(items))
	for _, it := range items {
		info, ierr := it.Info()
		if ierr != nil {
			continue
		}
		out = append(out, driveEntry{
			Name:    it.Name(),
			IsDir:   it.IsDir(),
			Size:    info.Size(),
			ModTime: info.ModTime(),
		})
	}
	c.JSON(http.StatusOK, gin.H{"entries": out})
}

// Upload — POST /desktop/drive/upload?path= — multipart file upload.
func (h *DriveHandler) Upload(c *gin.Context) {
	claims := h.claims(c)
	if claims == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	if !h.enabled() || !h.cfg.AllowUpload {
		c.JSON(http.StatusForbidden, gin.H{"error": "上传已被管理员关闭"})
		return
	}
	root, err := h.userRoot(claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	dir, ok := safeJoin(root, c.Query("path"))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "非法路径"})
		return
	}
	form, err := c.MultipartForm()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	files := form.File["file"]
	if len(files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "没有文件"})
		return
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	maxFile := int64(h.cfg.MaxFileMB) * 1024 * 1024
	maxTotal := int64(h.cfg.MaxTotalMB) * 1024 * 1024
	used := dirSize(root)
	saved := 0
	for _, fh := range files {
		if maxFile > 0 && fh.Size > maxFile {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": fmt.Sprintf("%s 超过单文件上限 %d MB", fh.Filename, h.cfg.MaxFileMB)})
			return
		}
		if maxTotal > 0 && used+fh.Size > maxTotal {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": fmt.Sprintf("超过个人盘总容量 %d MB", h.cfg.MaxTotalMB)})
			return
		}
		// Guard the destination name against traversal embedded in the filename.
		dst, ok := safeJoin(dir, filepath.Base(fh.Filename))
		if !ok {
			continue
		}
		if err := c.SaveUploadedFile(fh, dst); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		used += fh.Size
		saved++
		rel, _ := filepath.Rel(root, dst)
		h.log(claims, c, model.AuditFileUpload, fmt.Sprintf("drive:%s bytes=%d", filepath.ToSlash(rel), fh.Size))
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "saved": saved})
}

// Download — GET /desktop/drive/download?path= — stream one file.
func (h *DriveHandler) Download(c *gin.Context) {
	claims := h.claims(c)
	if claims == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	if !h.enabled() || !h.cfg.AllowDownload {
		c.JSON(http.StatusForbidden, gin.H{"error": "下载已被管理员关闭"})
		return
	}
	root, err := h.userRoot(claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	target, ok := safeJoin(root, c.Query("path"))
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "非法路径"})
		return
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() {
		c.JSON(http.StatusNotFound, gin.H{"error": "文件不存在"})
		return
	}
	f, err := os.Open(target)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer f.Close()
	rel, _ := filepath.Rel(root, target)
	h.log(claims, c, model.AuditFileDownload, fmt.Sprintf("drive:%s bytes=%d", filepath.ToSlash(rel), info.Size()))
	c.Header("Content-Disposition", "attachment; filename=\""+filepath.Base(target)+"\"")
	http.ServeContent(c.Writer, c.Request, filepath.Base(target), info.ModTime(), f)
}

// Delete — DELETE /desktop/drive?path= — remove a file or empty/non-empty dir.
func (h *DriveHandler) Delete(c *gin.Context) {
	claims := h.claims(c)
	if claims == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	if !h.enabled() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "文件盘未启用"})
		return
	}
	root, err := h.userRoot(claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	target, ok := safeJoin(root, c.Query("path"))
	if !ok || target == root {
		c.JSON(http.StatusBadRequest, gin.H{"error": "非法路径"})
		return
	}
	if err := os.RemoveAll(target); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	rel, _ := filepath.Rel(root, target)
	h.log(claims, c, model.AuditFileDelete, "drive:"+filepath.ToSlash(rel))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Rename — POST /desktop/drive/rename {from,to} — rename or move within the
// drive. `to` is the full destination path (parent dir + final name), so the
// same endpoint covers an in-place rename and a move into another folder.
func (h *DriveHandler) Rename(c *gin.Context) {
	claims := h.claims(c)
	if claims == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	if !h.enabled() || !h.cfg.AllowUpload {
		c.JSON(http.StatusForbidden, gin.H{"error": "上传已被管理员关闭"})
		return
	}
	var body struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.From) == "" || strings.TrimSpace(body.To) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少源或目标路径"})
		return
	}
	root, err := h.userRoot(claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	src, ok := safeJoin(root, body.From)
	if !ok || src == root {
		c.JSON(http.StatusBadRequest, gin.H{"error": "非法源路径"})
		return
	}
	dst, ok := safeJoin(root, body.To)
	if !ok || dst == root {
		c.JSON(http.StatusBadRequest, gin.H{"error": "非法目标路径"})
		return
	}
	if src == dst {
		c.JSON(http.StatusOK, gin.H{"ok": true})
		return
	}
	// Block moving a directory into its own subtree (would orphan it).
	if strings.HasPrefix(dst, src+string(os.PathSeparator)) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "不能移动到自身的子目录"})
		return
	}
	if _, err := os.Stat(src); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "源文件不存在"})
		return
	}
	if _, err := os.Stat(dst); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "目标已存在同名项"})
		return
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := os.Rename(src, dst); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	relFrom, _ := filepath.Rel(root, src)
	relTo, _ := filepath.Rel(root, dst)
	h.log(claims, c, model.AuditFileRename, fmt.Sprintf("drive:%s -> %s", filepath.ToSlash(relFrom), filepath.ToSlash(relTo)))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Mkdir — POST /desktop/drive/mkdir {path} — create a folder.
func (h *DriveHandler) Mkdir(c *gin.Context) {
	claims := h.claims(c)
	if claims == nil {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	if !h.enabled() || !h.cfg.AllowUpload {
		c.JSON(http.StatusForbidden, gin.H{"error": "上传已被管理员关闭"})
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || strings.TrimSpace(body.Path) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少目录名"})
		return
	}
	root, err := h.userRoot(claims.UserID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	target, ok := safeJoin(root, body.Path)
	if !ok || target == root {
		c.JSON(http.StatusBadRequest, gin.H{"error": "非法路径"})
		return
	}
	if err := os.MkdirAll(target, 0o750); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	rel, _ := filepath.Rel(root, target)
	h.log(claims, c, model.AuditFileMkdir, "drive:"+filepath.ToSlash(rel))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
