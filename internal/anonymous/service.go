package anonymous

import (
	"context"
	"fmt"
	"time"

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

// TTL is the lifetime a freshly launched sandbox is granted. The gateway uses
// it to arm a server-side cutoff so the "auto-destroy after TTL" promise holds
// even for a session that stays connected and idle past the window.
func (s *Service) TTL() time.Duration { return s.launcher.Config().TTL }

// Destroy tears a sandbox down immediately and drops its Redis index entry.
// The gateway calls this the moment a session ends (clean disconnect or TTL
// cutoff) so the container is reclaimed promptly rather than lingering until
// the janitor's next sweep; the janitor remains the safety net for orphans
// left behind by a gateway crash.
func (s *Service) Destroy(ctx context.Context, containerID string) {
	if containerID == "" {
		return
	}
	if err := s.launcher.Remove(ctx, containerID); err != nil {
		s.logger.Warn("anonymous destroy failed", zap.String("id", containerID), zap.Error(err))
	}
	if s.cache != nil {
		_ = s.cache.UntrackAnonymous(ctx, containerID)
	}
}
