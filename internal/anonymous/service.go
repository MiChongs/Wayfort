package anonymous

import (
	"context"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/cache"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
	"go.uber.org/zap"
)

// Service implements webssh.AnonymousLauncher by allocating a fresh container
// per session and tracking it in Redis with a TTL the janitor uses.
type Service struct {
	launcher *DockerLauncher
	cache    *cache.Cache
	logger   *zap.Logger
}

func NewService(l *DockerLauncher, c *cache.Cache, logger *zap.Logger) *Service {
	return &Service{launcher: l, cache: c, logger: logger}
}

func (s *Service) Launch(ctx context.Context, sessionID string, cols, rows int) (webssh.Backend, string, error) {
	cid, err := s.launcher.Create(ctx, sessionID)
	if err != nil {
		return nil, "", err
	}
	hr, execID, err := s.launcher.Attach(ctx, cid, cols, rows)
	if err != nil {
		_ = s.launcher.Remove(context.Background(), cid)
		return nil, "", fmt.Errorf("attach: %w", err)
	}
	if s.cache != nil {
		_ = s.cache.TrackAnonymous(ctx, cid, s.launcher.Config().TTL)
	}
	return &dockerBackend{launcher: s.launcher, containerID: cid, execID: execID, resp: hr}, cid, nil
}
