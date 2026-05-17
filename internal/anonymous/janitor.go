package anonymous

import (
	"context"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/cache"
	"go.uber.org/zap"
)

// Janitor periodically reconciles Docker's view of managed containers with
// Redis TTL keys: anything in Docker but not in Redis is reaped, anything in
// Redis but not in Docker is purged from the index.
type Janitor struct {
	launcher *DockerLauncher
	cache    *cache.Cache
	logger   *zap.Logger
	interval time.Duration
}

func NewJanitor(l *DockerLauncher, c *cache.Cache, logger *zap.Logger, interval time.Duration) *Janitor {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	return &Janitor{launcher: l, cache: c, logger: logger, interval: interval}
}

func (j *Janitor) Run(ctx context.Context) error {
	t := time.NewTicker(j.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			j.sweep(ctx)
		}
	}
}

func (j *Janitor) sweep(ctx context.Context) {
	cl, err := j.launcher.ListManaged(ctx)
	if err != nil {
		j.logger.Warn("anonymous janitor list failed", zap.Error(err))
		return
	}
	live, _ := j.cache.ListAnonymous(ctx)
	liveSet := make(map[string]struct{}, len(live))
	for _, id := range live {
		liveSet[id] = struct{}{}
	}
	for _, cid := range cl {
		if _, ok := liveSet[cid]; ok {
			continue
		}
		if err := j.launcher.Remove(ctx, cid); err != nil {
			j.logger.Warn("reap container failed", zap.String("id", cid), zap.Error(err))
			continue
		}
		j.logger.Info("reaped anonymous container", zap.String("id", cid))
		_ = j.cache.UntrackAnonymous(ctx, cid)
	}
}
