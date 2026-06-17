package oss

import (
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/auth"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/office"
)

const officeAccessTTL = 12 * time.Hour

var officeEditableExt = map[string]bool{
	"docx": true, "xlsx": true, "pptx": true, "odt": true, "ods": true,
	"odp": true, "doc": true, "xls": true, "ppt": true, "rtf": true,
	"csv": true, "txt": true,
}

// OfficeConfig builds a signed OnlyOffice editor config for an object. Authed
// route: the caller must hold read access to the node; edit mode additionally
// requires an upload grant.
func (h *Handler) OfficeConfig(c *gin.Context) {
	nodeID, ok := parseNodeID(c)
	if !ok {
		return
	}
	if h.Office == nil || !h.Office.Enabled() {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "online office is not configured"})
		return
	}
	if !h.requireAccess(c, nodeID, "download") {
		return
	}
	bucket := c.Query("bucket")
	key := normKey(c.Query("key"))
	if bucket == "" || key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bucket and key required"})
		return
	}
	uid := h.uid(c)
	username := ""
	if claims := auth.FromContext(c.Request.Context()); claims != nil {
		username = claims.Username
	}

	ext := strings.ToLower(strings.TrimPrefix(path.Ext(key), "."))
	canEdit := officeEditableExt[ext] && h.assetAllows(c, nodeID, "upload")

	idStr := strconv.FormatUint(nodeID, 10)
	dlTok, err := h.Office.SignAccess(office.Access{NodeID: nodeID, Bucket: bucket, Key: key, UserID: uid}, officeAccessTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	cbTok, err := h.Office.SignAccess(office.Access{NodeID: nodeID, Bucket: bucket, Key: key, UserID: uid, Write: true}, officeAccessTTL)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	base := h.Office.CallbackBaseURL()
	cfg, err := h.Office.BuildConfig(office.EditorInput{
		Ext:         ext,
		Key:         office.DocumentKey(idStr+":"+bucket+":"+key, time.Now().UnixNano()),
		Title:       path.Base(key),
		DownloadURL: base + "/api/v1/office/nodes/" + idStr + "/oss/file?t=" + url.QueryEscape(dlTok),
		CallbackURL: base + "/api/v1/office/nodes/" + idStr + "/oss/callback?t=" + url.QueryEscape(cbTok),
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

func (h *Handler) assetAllows(c *gin.Context, nodeID uint64, action string) bool {
	if h.Asset == nil {
		return true
	}
	ok, err := h.Asset.Check(c.Request.Context(), h.uid(c), nodeID, action)
	return err == nil && ok
}

// OfficeFile streams an object to the Document Server, authorized by the signed
// access token (no user JWT — the Document Server pulls it directly).
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
	store, _, closer, err := h.Conn.Open(c.Request.Context(), acc.NodeID)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer closer()
	body, _, err := store.GetObject(c.Request.Context(), acc.Bucket, acc.Key)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer body.Close()
	c.Header("Content-Type", "application/octet-stream")
	_, _ = io.Copy(c.Writer, body)
}

// OfficeCallback writes the edited object back on save (status 2 / 6).
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
		if err := h.officeWriteBack(c, acc, body.URL); err != nil {
			c.JSON(http.StatusOK, gin.H{"error": 1})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"error": 0})
}

func (h *Handler) officeWriteBack(c *gin.Context, acc *office.Access, fileURL string) error {
	resp, err := http.Get(fileURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	store, _, closer, err := h.Conn.Open(c.Request.Context(), acc.NodeID)
	if err != nil {
		return err
	}
	defer closer()
	if err := store.PutObject(c.Request.Context(), acc.Bucket, acc.Key, resp.Body, resp.ContentLength, ctForKey(acc.Key)); err != nil {
		return err
	}
	h.logEvent(c, acc.NodeID, model.AuditFileUpload, acc.Key+" (office save)")
	return nil
}
