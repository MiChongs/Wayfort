package sftp

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"io"
	"net/http"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	pkgsftp "github.com/pkg/sftp"
)

// This file adds the "stronger" SFTP operations the browser UI leans on but
// that a one-file-per-request model can't express well on the client:
// recursive search, server-side copy, and a streamed tar.gz of a directory or
// multi-selection. They reuse the same connector, approval gate, and audit
// trail as the core handlers in handler.go.

// ---- recursive search ----------------------------------------------------

// searchHit is a listEntry plus the directory it was found in, so the client
// can render "name — /etc/nginx" rows and jump straight to the parent.
type searchHit struct {
	listEntry
	Dir string `json:"dir"`
}

const (
	searchMaxResults = 500
	searchMaxScan    = 50000 // entries inspected before bailing out
	searchTimeout    = 20 * time.Second
)

// Search walks the tree under ?path= (breadth-first) and returns entries whose
// name contains ?q= (case-insensitive). Bounded by result count, total nodes
// scanned, and a wall-clock deadline so a search at "/" can't hang a worker.
func (h *Handler) Search(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	root := cleanPath(c.DefaultQuery("path", "/"))
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "搜索关键词不能为空"})
		return
	}
	needle := strings.ToLower(q)
	limit := searchMaxResults
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= searchMaxResults {
			limit = n
		}
	}

	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()

	ctx, cancel := context.WithTimeout(c.Request.Context(), searchTimeout)
	defer cancel()

	hits := make([]searchHit, 0, 64)
	scanned := 0
	truncated := false

	queue := []string{root}
	for len(queue) > 0 {
		if ctx.Err() != nil {
			truncated = true
			break
		}
		dir := queue[0]
		queue = queue[1:]
		entries, err := client.ReadDir(dir)
		if err != nil {
			continue // unreadable (permission, vanished) — skip silently
		}
		for _, e := range entries {
			scanned++
			if scanned > searchMaxScan {
				truncated = true
				break
			}
			full := path.Join(dir, e.Name())
			if strings.Contains(strings.ToLower(e.Name()), needle) {
				hits = append(hits, searchHit{listEntry: toEntry(full, e, ""), Dir: dir})
				if len(hits) >= limit {
					truncated = true
					break
				}
			}
			// Descend into real subdirectories only; never follow symlinks so a
			// self-referential link can't trap the walk.
			if e.IsDir() && e.Mode()&os.ModeSymlink == 0 {
				queue = append(queue, full)
			}
		}
		if truncated {
			break
		}
	}

	sort.Slice(hits, func(i, j int) bool {
		if hits[i].IsDir != hits[j].IsDir {
			return hits[i].IsDir
		}
		return strings.ToLower(hits[i].Name) < strings.ToLower(hits[j].Name)
	})

	c.JSON(http.StatusOK, gin.H{
		"root":      root,
		"query":     q,
		"entries":   hits,
		"truncated": truncated,
		"scanned":   scanned,
	})
}

// ---- server-side copy ----------------------------------------------------

type copyReq struct {
	From string `json:"from" binding:"required"`
	To   string `json:"to" binding:"required"`
}

// Copy duplicates a file or directory tree entirely on the remote host, so a
// "duplicate" never has to round-trip the bytes through the browser.
func (h *Handler) Copy(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.enforceFileXfer(c, nodeID, currentUID(c), "sftp_write") {
		return
	}
	var req copyReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	from := cleanPath(req.From)
	to := cleanPath(req.To)
	if from == to {
		c.JSON(http.StatusBadRequest, gin.H{"error": "源路径与目标路径相同"})
		return
	}
	// A directory copied into itself or a descendant would recurse forever.
	if strings.HasPrefix(to+"/", from+"/") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "不能把目录复制到自身或其子目录"})
		return
	}

	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()

	info, err := client.Lstat(from)
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	var copied int64
	if info.IsDir() {
		copied, err = copyDirRecursive(client, from, to)
	} else {
		copied, err = copyFile(client, from, to, info.Mode().Perm())
	}
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	h.recordFile(c, nodeID, model.AuditFileWrite, from+" => "+to+" (copy)", copied)
	c.JSON(http.StatusOK, gin.H{"ok": true, "from": from, "to": to, "bytes": copied})
}

func copyFile(client *pkgsftp.Client, src, dst string, mode os.FileMode) (int64, error) {
	in, err := client.Open(src)
	if err != nil {
		return 0, err
	}
	defer in.Close()
	out, err := client.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return 0, err
	}
	defer out.Close()
	n, err := io.Copy(out, in)
	if err != nil {
		return n, err
	}
	_ = client.Chmod(dst, mode) // best-effort; remote umask decides otherwise
	return n, nil
}

func copyDirRecursive(client *pkgsftp.Client, src, dst string) (int64, error) {
	if err := client.MkdirAll(dst); err != nil {
		return 0, err
	}
	entries, err := client.ReadDir(src)
	if err != nil {
		return 0, err
	}
	var total int64
	for _, e := range entries {
		s := path.Join(src, e.Name())
		d := path.Join(dst, e.Name())
		if e.IsDir() {
			n, err := copyDirRecursive(client, s, d)
			total += n
			if err != nil {
				return total, err
			}
		} else if e.Mode().IsRegular() {
			n, err := copyFile(client, s, d, e.Mode().Perm())
			total += n
			if err != nil {
				return total, err
			}
		}
	}
	return total, nil
}

// ---- streamed tar.gz archive --------------------------------------------

// Archive streams a gzip-compressed tarball of one directory (?path=) or a
// multi-selection (?paths=a&paths=b). Entries are stored relative to the
// selection's parent so the archive unpacks into a sensible folder layout.
func (h *Handler) Archive(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if !h.enforceFileXfer(c, nodeID, currentUID(c), "sftp_read") {
		return
	}

	var targets []string
	if ps := c.QueryArray("paths"); len(ps) > 0 {
		for _, p := range ps {
			targets = append(targets, cleanPath(p))
		}
	} else if p := c.Query("path"); p != "" {
		targets = append(targets, cleanPath(p))
	}
	if len(targets) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 path 或 paths"})
		return
	}

	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()

	archiveName := "archive"
	if len(targets) == 1 {
		if b := path.Base(targets[0]); b != "/" && b != "." {
			archiveName = b
		}
	}
	c.Header("Content-Disposition", "attachment; filename=\""+archiveName+".tar.gz\"")
	c.Header("Content-Type", "application/gzip")

	gz := gzip.NewWriter(c.Writer)
	defer gz.Close()
	tw := tar.NewWriter(gz)
	defer tw.Close()

	var total int64
	for _, t := range targets {
		info, err := client.Lstat(t)
		if err != nil {
			continue
		}
		base := path.Dir(t)
		// Headers are already flushed, so a mid-stream failure can only stop —
		// the client sees a truncated archive, which is the best we can do.
		if err := addToTar(client, tw, t, base, info, &total); err != nil {
			return
		}
	}
	h.recordFile(c, nodeID, model.AuditFileDownload, strings.Join(targets, ",")+" (archive)", total)
}

func addToTar(client *pkgsftp.Client, tw *tar.Writer, target, base string, info os.FileInfo, total *int64) error {
	rel := strings.TrimPrefix(target, base+"/")
	if base == "/" {
		rel = strings.TrimPrefix(target, "/")
	}
	if rel == "" {
		rel = info.Name()
	}

	if info.IsDir() {
		if err := tw.WriteHeader(&tar.Header{
			Name:     rel + "/",
			Mode:     int64(info.Mode().Perm()),
			ModTime:  info.ModTime(),
			Typeflag: tar.TypeDir,
		}); err != nil {
			return err
		}
		entries, err := client.ReadDir(target)
		if err != nil {
			return nil // unreadable subtree — skip rather than abort the whole archive
		}
		for _, e := range entries {
			if err := addToTar(client, tw, path.Join(target, e.Name()), base, e, total); err != nil {
				return err
			}
		}
		return nil
	}

	// Regular files only; skip symlinks/devices/sockets to keep archives safe.
	if !info.Mode().IsRegular() {
		return nil
	}
	if err := tw.WriteHeader(&tar.Header{
		Name:     rel,
		Mode:     int64(info.Mode().Perm()),
		Size:     info.Size(),
		ModTime:  info.ModTime(),
		Typeflag: tar.TypeReg,
	}); err != nil {
		return err
	}
	f, err := client.Open(target)
	if err != nil {
		return err
	}
	defer f.Close()
	n, err := io.Copy(tw, f)
	*total += n
	return err
}
