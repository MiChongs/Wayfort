package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/michongs/jumpserver-anonymous/internal/config"
	"go.uber.org/zap"
)

func NewEngine(cfg config.ServerConfig, logger *zap.Logger) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(requestID(), zapLog(logger), gin.Recovery())
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	return r
}

func requestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader("X-Request-ID")
		if id == "" {
			id = uuid.NewString()
		}
		c.Writer.Header().Set("X-Request-ID", id)
		c.Set("request_id", id)
		c.Next()
	}
}

func zapLog(logger *zap.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		logger.Info("http",
			zap.String("method", c.Request.Method),
			zap.String("path", c.Request.URL.Path),
			zap.Int("status", c.Writer.Status()),
			zap.Duration("latency", time.Since(start)),
			zap.String("ip", c.ClientIP()),
		)
	}
}

func Serve(ctx context.Context, addr string, handler http.Handler, cfg config.ServerConfig, logger *zap.Logger) error {
	srv := &http.Server{
		Addr:         addr,
		Handler:      handler,
		ReadTimeout:  cfg.ReadTimeout,
		WriteTimeout: 0, // disabled so WS long-polls don't get killed
		IdleTimeout:  120 * time.Second,
	}
	errc := make(chan error, 1)
	go func() {
		logger.Info("http listening", zap.String("addr", addr))
		errc <- srv.ListenAndServe()
	}()
	select {
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		return srv.Shutdown(shutdownCtx)
	}
}
