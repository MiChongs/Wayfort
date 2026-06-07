package sftp

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/approval"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/office"
)

const officeAccessTTL = 12 * time.Hour

var officeEditableExt = map[string]bool{
	"docx": true, "xlsx": true, "pptx": true, "odt": true, "ods": true,
	"odp": true, "doc": true, "xls": true, "ppt": true, "rtf": true,
	"csv": true, "txt": true,
}

// OfficeConfig builds a signed OnlyOffice editor config for a document on this
// node. Mounted in the authed group: the caller is the logged-in user, and
// edit mode additionally requires an active file-transfer write grant.
func (h *Handler) OfficeConfig(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if h.Office == nil || !h.Office.Enabled() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "online office is not configured"})
		return
	}
	target := cleanPath(c.Query("path"))
	if target == "" || target == "/" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "path required"})
		return
	}
	uid := currentUID(c)
	username := ""
	if claims := auth.FromContext(c.Request.Context()); claims != nil {
		username = claims.Username
	}

	client, closer, err := h.Conn.Open(c.Request.Context(), nodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	info, statErr := client.Stat(target)
	closer()
	if statErr != nil {
		respondSftpErr(c, statErr)
		return
	}

	ext := strings.ToLower(strings.TrimPrefix(path.Ext(target), "."))
	canEdit := officeEditableExt[ext] && h.officeWriteAllowed(c.Request.Context(), nodeID, uid)

	idStr := strconv.FormatUint(nodeID, 10)
	dlTok, err := h.Office.SignAccess(office.Access{NodeID: nodeID, Path: target, UserID: uid}, officeAccessTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	cbTok, err := h.Office.SignAccess(office.Access{NodeID: nodeID, Path: target, UserID: uid, Write: true}, officeAccessTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	base := h.Office.CallbackBaseURL()
	cfg, err := h.Office.BuildConfig(office.EditorInput{
		Ext:         ext,
		Key:         office.DocumentKey(idStr+":"+target, info.ModTime().UnixNano()),
		Title:       path.Base(target),
		DownloadURL: base + "/api/v1/office/nodes/" + idStr + "/sftp/file?t=" + url.QueryEscape(dlTok),
		CallbackURL: base + "/api/v1/office/nodes/" + idStr + "/sftp/callback?t=" + url.QueryEscape(cbTok),
		CanEdit:     canEdit,
		UserID:      uid,
		UserName:    username,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"document_server_url": h.Office.DocumentServerURL() + "/", "config": cfg})
}

func (h *Handler) officeWriteAllowed(ctx context.Context, nodeID, uid uint64) bool {
	if h.Approval == nil {
		return true
	}
	res, err := h.Approval.CheckEnforced(ctx, approval.EnforcementCheck{
		UserID:       uid,
		BusinessType: model.ApprovalBizFileTransfer,
		ResourceType: "node",
		ResourceID:   strconv.FormatUint(nodeID, 10),
		Action:       "sftp_write",
	})
	return err == nil && res.Allowed
}

// OfficeFile streams the document to the Document Server. Public route,
// authorized purely by the signed access token (the Document Server carries no
// user JWT).
func (h *Handler) OfficeFile(c *gin.Context) {
	if h.Office == nil {
		c.Status(http.StatusServiceUnavailable)
		return
	}
	acc, err := h.Office.VerifyAccess(c.Query("t"))
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid token"})
		return
	}
	client, closer, err := h.Conn.Open(c.Request.Context(), acc.NodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	f, err := client.Open(acc.Path)
	if err != nil {
		respondSftpErr(c, err)
		return
	}
	defer f.Close()
	c.Header("Content-Type", "application/octet-stream")
	_, _ = io.Copy(c.Writer, f)
}

// OfficeCallback receives the Document Server's save notification. On status 2
// (everyone closed) or 6 (force save) it pulls the edited file and writes it
// back to the node. Always answers {"error":0} on success per the OnlyOffice
// contract, or {"error":1} so the Document Server retries.
func (h *Handler) OfficeCallback(c *gin.Context) {
	if h.Office == nil {
		c.JSON(http.StatusOK, gin.H{"error": 1})
		return
	}
	acc, err := h.Office.VerifyAccess(c.Query("t"))
	if err != nil || !acc.Write {
		c.JSON(http.StatusOK, gin.H{"error": 1})
		return
	}
	var body struct {
		Status int    `json:"status"`
		URL    string `json:"url"`
		Token  string `json:"token"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusOK, gin.H{"error": 1})
		return
	}
	if _, err := h.Office.VerifyDocServerJWT(body.Token); err != nil {
		c.JSON(http.StatusOK, gin.H{"error": 1})
		return
	}
	if body.Status == 2 || body.Status == 6 {
		if err := h.officeWriteBack(c.Request.Context(), c, acc, body.URL); err != nil {
			c.JSON(http.StatusOK, gin.H{"error": 1})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"error": 0})
}

func (h *Handler) officeWriteBack(ctx context.Context, c *gin.Context, acc *office.Access, fileURL string) error {
	resp, err := http.Get(fileURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	client, closer, err := h.Conn.Open(ctx, acc.NodeID)
	if err != nil {
		return err
	}
	defer closer()
	f, err := client.OpenFile(acc.Path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return err
	}
	defer f.Close()
	n, err := io.Copy(f, resp.Body)
	if err != nil {
		return err
	}
	h.recordFile(c, acc.NodeID, model.AuditFileWrite, acc.Path+" (office save)", n)
	return nil
}
