package anonymous

import (
	"context"
	"time"

	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/cache"
	"github.com/michongs/wayfort/internal/model"
	"go.uber.org/zap"
)

// Janitor periodically reconciles Docker's view of managed containers with
// Redis TTL keys: anything in Docker but not in Redis is reaped, anything in
// Redis but not in Docker is purged from the index.
type Janitor struct {
	launcher *DockerLauncher
	cache    *cache.Cache
	audit    *audit.Writer // optional; reaps are audit-logged when wired
	logger   *zap.Logger
	interval time.Duration
	failures int
}

func NewJanitor(l *DockerLauncher, c *cache.Cache, audw *audit.Writer, logger *zap.Logger, interval time.Duration) *Janitor {
	if interval <= 0 {
		interval = 30 * time.Second
	}
	return &Janitor{launcher: l, cache: c, audit: audw, logger: logger, interval: interval}
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
		// Rate-limit: an unreachable / incompatible Docker daemon would
		// otherwise log this every interval. Warn on the first failure and
		// then only periodically so the signal survives without the spam.
		j.failures++
		if j.failures == 1 || j.failures%20 == 0 {
			j.logger.Warn("anonymous janitor list failed", zap.Error(err), zap.Int("consecutive", j.failures))
		}
		return
	}
	if j.failures > 0 {
		j.logger.Info("anonymous janitor recovered", zap.Int("after_failures", j.failures))
		j.failures = 0
	}
	live, _ := j.cache.ListAnonymous(ctx)
	liveSet := make(map[string]struct{}, len(live))
	for _, id := range live {
		liveSet[id] = struct{}{}
	}
	for _, mc := range cl {
		if _, ok := liveSet[mc.ID]; ok {
			continue
		}
		if err := j.launcher.Remove(ctx, mc.ID); err != nil {
			j.logger.Warn("reap container failed", zap.String("id", mc.ID), zap.Error(err))
			continue
		}
		j.logger.Info("reaped anonymous container", zap.String("id", mc.ID), zap.String("session", mc.SessionID))
		_ = j.cache.UntrackAnonymous(ctx, mc.ID)
		// Close the audit story: the TTL guarantee is only credible if its
		// enforcement is observable. A reap here is the sandbox's auto-destroy
		// firing — surface it on the session's audit timeline.
		if j.audit != nil {
			j.audit.Log(model.AuditLog{
				Kind:      model.AuditAnonymousReap,
				Username:  "anonymous",
				SessionID: mc.SessionID,
				Payload:   mc.ID,
			})
		}
	}
}
