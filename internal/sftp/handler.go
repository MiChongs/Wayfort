package sftp

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"os"
	"os/user"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/audit"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	pkgsftp "github.com/pkg/sftp"
	"go.uber.org/zap"
)

// Max size for the text read/write endpoints. Anything larger should use the
// download/upload streaming path. 2 MiB is generous enough for log/config/
// script editing and small enough to keep the request synchronous.
const textIOLimit int64 = 2 * 1024 * 1024

type Handler struct {
	Conn   *Connector
	Audit  *audit.Writer
	Logger *zap.Logger
}

type listEntry struct {
	Name       string    `json:"name"`
	Path       string    `json:"path"`
	Size       int64     `json:"size"`
	Mode       string    `json:"mode"`
	ModeOctal  string    `json:"mode_octal"`
	IsDir      bool      `json:"is_dir"`
	IsLink     bool      `json:"is_link"`
	LinkTarget string    `json:"link_target,omitempty"`
	UID        uint32    `json:"uid,omitempty"`
	GID        uint32    `json:"gid,omitempty"`
	Owner      string    `json:"owner,omitempty"`
	Group      string    `json:"group,omitempty"`
	ModTime    time.Time `json:"mod_time"`
}

// ---- helpers -------------------------------------------------------------

func cleanPath(p string) string {
	if p == "" {
		return "/"
	}
	c := path.Clean(p)
	if c == "." {
		return "/"
	}
	return c
}

// httpStatusForSftpErr maps pkg/sftp StatusError codes (and a few stdlib
// equivalents) onto sensible HTTP status codes. Falls back to 502 because
// most failures here are upstream (remote sshd / network), not request bugs.
func httpStatusForSftpErr(err error) int {
	if err == nil {
		return http.StatusOK
	}
	var se *pkgsftp.StatusError
	if errors.As(err, &se) {
		switch se.FxCode() {
		case pkgsftp.ErrSSHFxNoSuchFile:
			return http.StatusNotFound
		case pkgsftp.ErrSSHFxPermissionDenied:
			return http.StatusForbidden
		case pkgsftp.ErrSSHFxOpUnsupported:
			return http.StatusNotImplemented
		}
	}
	if errors.Is(err, os.ErrNotExist) {
		return http.StatusNotFound
	}
	if errors.Is(err, os.ErrPermission) {
		return http.StatusForbidden
	}
	return http.StatusBadGateway
}

func respondSftpErr(c *gin.Context, err error) {
	c.JSON(httpStatusForSftpErr(err), gin.H{"error": err.Error()})
}

func parseNodeID(c *gin.Context) (uint64, bool) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad node id"})
		return 0, false
	}
	return id, true
}

func toEntry(target string, info os.FileInfo, link string) listEntry {
	e := listEntry{
		Name:    info.Name(),
		Path:    target,
		Size:    info.Size(),
		Mode:    info.Mode().String(),
		IsDir:   info.IsDir(),
		IsLink:  info.Mode()&os.ModeSymlink != 0,
		ModTime: info.ModTime(),
	}
	// Octal permission bits (lowest 12, including setuid/setgid/sticky).
	perm := uint32(info.Mode().Perm())
	if info.Mode()&os.ModeSetuid != 0 {
		perm |= 0o4000
	}
	if info.Mode()&os.ModeSetgid != 0 {
		perm |= 0o2000
	}
	if info.Mode()&os.ModeSticky != 0 {
		perm |= 0o1000
	}
	e.ModeOctal = "0" + strconv.FormatUint(uint64(perm), 8)
	// pkg/sftp returns *sftp.FileStat from Sys(); when present we get raw uid/gid.
	if fs, ok := info.Sys().(*pkgsftp.FileStat); ok && fs != nil {
		e.UID = fs.UID
		e.GID = fs.GID
		if u, err := user.LookupId(strconv.FormatUint(uint64(fs.UID), 10)); err == nil {
			e.Owner = u.Username
		}
		if g, err := user.LookupGroupId(strconv.FormatUint(uint64(fs.GID), 10)); err == nil {
			e.Group = g.Name
		}
	}
	if link != "" {
		e.LinkTarget = link
	}
	return e
}

// ---- handlers ------------------------------------------------------------

func (h *Handler) List(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	target := cleanPath(c.DefaultQuery("path", "/"))
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	entries, err := client.ReadDir(target)
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	out := make([]listEntry, 0, len(entries))
	for _, e := range entries {
		full := path.Join(target, e.Name())
		link := ""
		if e.Mode()&os.ModeSymlink != 0 {
			if t, err := client.ReadLink(full); err == nil {
				link = t
			}
		}
		out = append(out, toEntry(full, e, link))
	}
	c.JSON(http.StatusOK, gin.H{"path": target, "entries": out})
}

func (h *Handler) Stat(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	target := c.Query("path")
	if target == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	target = cleanPath(target)
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	info, err := client.Lstat(target)
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	link := ""
	if info.Mode()&os.ModeSymlink != 0 {
		if t, err := client.ReadLink(target); err == nil {
			link = t
		}
	}
	c.JSON(http.StatusOK, toEntry(target, info, link))
}

type mkdirReq struct {
	Path string `json:"path" binding:"required"`
}

func (h *Handler) Mkdir(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	var req mkdirReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	target := cleanPath(req.Path)
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	if err := client.MkdirAll(target); err != nil {
		respondSftpErr(c, err)
		return
	}
	h.recordFile(c, nodeID, model.AuditFileMkdir, target, 0)
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": target})
}

func (h *Handler) Remove(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	target := c.Query("path")
	if target == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	target = cleanPath(target)
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	info, statErr := client.Lstat(target)
	var rmErr error
	switch {
	case statErr == nil && info.IsDir():
		rmErr = removeDirRecursive(client, target)
	default:
		rmErr = client.Remove(target)
	}
	if rmErr != nil {
		respondSftpErr(c, rmErr)
		return
	}
	h.recordFile(c, nodeID, model.AuditFileDelete, target, 0)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// removeDirRecursive deletes a directory and its contents. The plain
// RemoveDirectory call fails on non-empty directories; for a "human" UI we
// want a single Delete action to just work.
func removeDirRecursive(client *pkgsftp.Client, dir string) error {
	entries, err := client.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		full := path.Join(dir, e.Name())
		if e.IsDir() {
			if err := removeDirRecursive(client, full); err != nil {
				return err
			}
		} else {
			if err := client.Remove(full); err != nil {
				return err
			}
		}
	}
	return client.RemoveDirectory(dir)
}

func (h *Handler) Upload(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	target := c.Query("path")
	if target == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	target = cleanPath(target)
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
	// Honour an explicit filename query (`?name=...`) so multi-file uploads
	// can sanitize on the client side; otherwise use the multipart filename.
	name := c.Query("name")
	if name == "" {
		name = fh.Filename
	}
	name = path.Base(name)
	dest := path.Join(target, name)
	// FIX: OpenFile's second arg is *flags*, not mode (the original code passed
	// 0o600, which happened to set O_TRUNC|O_CREAT but in a confusing way). The
	// remote sshd's umask determines the final mode for newly created files.
	f, err := client.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	defer f.Close()
	n, err := io.Copy(f, file)
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	h.recordFile(c, nodeID, model.AuditFileUpload, dest, n)
	c.JSON(http.StatusOK, gin.H{"ok": true, "bytes": n, "path": dest})
}

func (h *Handler) Download(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	target := c.Query("path")
	if target == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	target = cleanPath(target)
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	f, err := client.Open(target)
	if err != nil {
		respondSftpErr(c, err)
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

type renameReq struct {
	From string `json:"from" binding:"required"`
	To   string `json:"to" binding:"required"`
}

func (h *Handler) Rename(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	var req renameReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	from := cleanPath(req.From)
	to := cleanPath(req.To)
	if from == to {
		c.JSON(http.StatusBadRequest, gin.H{"error": "source and target are the same"})
		return
	}
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	// Prefer the OpenSSH posix-rename extension when available so existing
	// target paths get replaced atomically instead of failing — that matches
	// what end users expect from a "rename / move" UI.
	if err := client.PosixRename(from, to); err != nil {
		if err := client.Rename(from, to); err != nil {
			respondSftpErr(c, err)
			return
		}
	}
	h.recordFile(c, nodeID, model.AuditFileRename, from+" -> "+to, 0)
	c.JSON(http.StatusOK, gin.H{"ok": true, "from": from, "to": to})
}

type chmodReq struct {
	Path string `json:"path" binding:"required"`
	// Mode is the numeric file mode (e.g. 0o644 = 420). Accepted as int so the
	// frontend can post an octal-derived number directly.
	Mode uint32 `json:"mode" binding:"required"`
}

func (h *Handler) Chmod(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	var req chmodReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Mode > 0o7777 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mode out of range (max 07777)"})
		return
	}
	target := cleanPath(req.Path)
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	if err := client.Chmod(target, os.FileMode(req.Mode)); err != nil {
		respondSftpErr(c, err)
		return
	}
	h.recordFile(c, nodeID, model.AuditFileChmod, target+" mode="+strconv.FormatUint(uint64(req.Mode), 8), 0)
	c.JSON(http.StatusOK, gin.H{"ok": true, "path": target, "mode": req.Mode})
}

func (h *Handler) ReadText(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	target := c.Query("path")
	if target == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	target = cleanPath(target)
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	info, err := client.Stat(target)
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	if info.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path is a directory"})
		return
	}
	f, err := client.Open(target)
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	defer f.Close()
	limited := io.LimitReader(f, textIOLimit+1)
	buf, err := io.ReadAll(limited)
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	truncated := false
	if int64(len(buf)) > textIOLimit {
		buf = buf[:textIOLimit]
		truncated = true
	}
	// Heuristic: refuse anything with NUL bytes in the first 8 KiB — almost
	// certainly binary, and stuffing it into JSON would just corrupt the
	// editor view.
	head := buf
	if len(head) > 8192 {
		head = head[:8192]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		c.JSON(http.StatusUnsupportedMediaType, gin.H{
			"error":  "binary file — use download instead",
			"size":   info.Size(),
			"binary": true,
		})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"path":      target,
		"size":      info.Size(),
		"content":   string(buf),
		"truncated": truncated,
		"mode":      strconv.FormatUint(uint64(info.Mode().Perm()), 8),
	})
}

type writeReq struct {
	Path    string  `json:"path" binding:"required"`
	Content string  `json:"content"`
	Mode    *uint32 `json:"mode,omitempty"`
}

func (h *Handler) WriteText(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	var req writeReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if int64(len(req.Content)) > textIOLimit {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{
			"error": "content exceeds 2 MiB limit; use upload instead",
			"limit": textIOLimit,
		})
		return
	}
	target := cleanPath(req.Path)
	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	// Preserve the existing file's mode where possible; otherwise the
	// O_CREATE | umask behaviour decides. If an explicit mode was sent (e.g.
	// for a brand-new file) honour it.
	var preserveMode os.FileMode
	preserve := false
	if info, err := client.Stat(target); err == nil && !info.IsDir() {
		preserveMode = info.Mode().Perm()
		preserve = true
	}
	f, err := client.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	defer f.Close()
	n, err := io.Copy(f, strings.NewReader(req.Content))
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	if req.Mode != nil && *req.Mode <= 0o7777 {
		_ = client.Chmod(target, os.FileMode(*req.Mode))
	} else if preserve {
		_ = client.Chmod(target, preserveMode)
	}
	h.recordFile(c, nodeID, model.AuditFileWrite, target, n)
	c.JSON(http.StatusOK, gin.H{"ok": true, "bytes": n, "path": target})
}

func (h *Handler) recordFile(c *gin.Context, nodeID uint64, kind model.AuditEventKind, target string, bytes int64) {
	if h.Audit == nil {
		return
	}
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
