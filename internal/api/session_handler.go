package api

import (
	"net/http"
	"os"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

type SessionHandler struct{ Repo *repo.SessionRepo }

func (h *SessionHandler) List(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
	offset, _ := strconv.Atoi(c.DefaultQuery("offset", "0"))
	filter := repo.ListSessionFilter{
		Status: c.Query("status"), Limit: limit, Offset: offset,
	}
	if raw := c.Query("node_id"); raw != "" {
		if nid, err := strconv.ParseUint(raw, 10, 64); err == nil {
			filter.NodeID = &nid
		}
	}
	out, err := h.Repo.List(c.Request.Context(), filter)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"sessions": out})
}

func (h *SessionHandler) Recording(c *gin.Context) {
	id := c.Param("id")
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if row.RecordingPath == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "no recording"})
		return
	}
	f, err := os.Open(row.RecordingPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	defer f.Close()
	ext := ".cast"
	contentType := "application/x-asciicast"
	if row.RecordingType == "guac" {
		ext = ".guac"
		contentType = "application/octet-stream"
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", "attachment; filename=\""+id+ext+"\"")
	http.ServeContent(c.Writer, c.Request, id+ext, row.StartedAt, f)
}
