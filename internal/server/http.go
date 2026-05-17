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

// info is overridable at link time via -ldflags "-X .../server.buildVersion=..."
var (
	buildVersion = "dev"
	buildCommit  = ""
)

func NewEngine(cfg config.ServerConfig, logger *zap.Logger) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(requestID(), zapLog(logger), gin.Recovery())
	r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	// Root → small welcome JSON so the boot log doesn't fill up with 404s when
	// somebody browses to the bare host (curl / health probes / dashboard
	// banners all hit "/").
	r.GET("/", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"service":  "jumpserver-anonymous",
			"version":  buildVersion,
			"commit":   buildCommit,
			"docs":     "/api/v1",
			"login":    "/api/v1/auth/login",
			"healthz":  "/healthz",
		})
	})
	// Suppress noisy "no Route" 404 from favicon hits.
	r.GET("/favicon.ico", func(c *gin.Context) { c.Status(http.StatusNoContent) })
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
		// Demote probe-style traffic to Debug so cluster health probes don't
		// drown out signal in INFO.
		path := c.Request.URL.Path
		method := c.Request.Method
		status := c.Writer.Status()
		latency := time.Since(start)
		fields := []zap.Field{
			zap.String("method", method),
			zap.String("path", path),
			zap.Int("status", status),
			zap.Duration("latency", latency),
			zap.String("ip", c.ClientIP()),
		}
		switch {
		case path == "/healthz" || path == "/favicon.ico":
			logger.Debug("http", fields...)
		case status >= 500:
			logger.Error("http", fields...)
		case status >= 400:
			logger.Warn("http", fields...)
		default:
			logger.Info("http", fields...)
		}
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
