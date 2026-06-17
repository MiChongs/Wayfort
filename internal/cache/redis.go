package cache

import (
	"context"
	"errors"
	"time"

	"github.com/michongs/wayfort/internal/config"
	"github.com/redis/go-redis/v9"
)

const (
	keyActiveSessions = "webssh:sessions:active"
	keyAnonContainer  = "webssh:anon:"
	keyPortForward    = "webssh:portfwd:"
)

type Cache struct{ r *redis.Client }

func New(cfg config.RedisConfig) (*Cache, error) {
	c := redis.NewClient(&redis.Options{
		Addr:     cfg.Addr,
		Password: cfg.Password,
		DB:       cfg.DB,
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.Ping(ctx).Err(); err != nil {
		return nil, err
	}
	return &Cache{r: c}, nil
}

func (c *Cache) Client() *redis.Client { return c.r }

func (c *Cache) Close() error { return c.r.Close() }

// RegisterSession adds the session id to the active set with a TTL hash entry.
func (c *Cache) RegisterSession(ctx context.Context, sessionID, owner string) error {
	if err := c.r.SAdd(ctx, keyActiveSessions, sessionID).Err(); err != nil {
		return err
	}
	return c.r.HSet(ctx, "webssh:sessions:owner", sessionID, owner).Err()
}

func (c *Cache) UnregisterSession(ctx context.Context, sessionID string) error {
	pipe := c.r.TxPipeline()
	pipe.SRem(ctx, keyActiveSessions, sessionID)
	pipe.HDel(ctx, "webssh:sessions:owner", sessionID)
	_, err := pipe.Exec(ctx)
	if err != nil && !errors.Is(err, redis.Nil) {
		return err
	}
	return nil
}

func (c *Cache) ActiveSessions(ctx context.Context) ([]string, error) {
	return c.r.SMembers(ctx, keyActiveSessions).Result()
}

func (c *Cache) TrackAnonymous(ctx context.Context, containerID string, ttl time.Duration) error {
	return c.r.Set(ctx, keyAnonContainer+containerID, time.Now().Unix(), ttl).Err()
}

func (c *Cache) UntrackAnonymous(ctx context.Context, containerID string) error {
	return c.r.Del(ctx, keyAnonContainer+containerID).Err()
}

func (c *Cache) TrackPortForward(ctx context.Context, id string, ttl time.Duration) error {
	return c.r.Set(ctx, keyPortForward+id, time.Now().Unix(), ttl).Err()
}

func (c *Cache) UntrackPortForward(ctx context.Context, id string) error {
	return c.r.Del(ctx, keyPortForward+id).Err()
}

// ListAnonymous returns container IDs that still have an active TTL key.
func (c *Cache) ListAnonymous(ctx context.Context) ([]string, error) {
	var out []string
	iter := c.r.Scan(ctx, 0, keyAnonContainer+"*", 100).Iterator()
	for iter.Next(ctx) {
		key := iter.Val()
		if len(key) > len(keyAnonContainer) {
			out = append(out, key[len(keyAnonContainer):])
		}
	}
	return out, iter.Err()
}
