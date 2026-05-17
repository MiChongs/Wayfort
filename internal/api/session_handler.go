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
	out, err := h.Repo.List(c.Request.Context(), repo.ListSessionFilter{
		Status: c.Query("status"), Limit: limit, Offset: offset,
	})
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"sessions": out})
}

func (h *SessionHandler) Cast(c *gin.Context) {
	id := c.Param("id")
	row, err := h.Repo.FindByID(c.Request.Context(), id)
	if err != nil || row == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
		return
	}
	if row.CastPath == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "no cast"})
		return
	}
	f, err := os.Open(row.CastPath)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	defer f.Close()
	c.Header("Content-Type", "application/x-asciicast")
	c.Header("Content-Disposition", "attachment; filename=\""+id+".cast\"")
	http.ServeContent(c.Writer, c.Request, id+".cast", row.StartedAt, f)
}
