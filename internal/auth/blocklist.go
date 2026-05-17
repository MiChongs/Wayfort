package auth

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

// Blocklist tracks revoked JWT IDs so logout / force-logout actually invalidate
// outstanding tokens. Keys live in Redis with TTL equal to each token's
// remaining lifetime. A per-user set lets us batch-revoke all of a user's
// active tokens for "force logout".
type Blocklist struct {
	r *redis.Client
}

const (
	revKeyPrefix     = "jwt:revoked:"
	userJTIPrefix    = "jwt:user:"
	maxUserJTITrack  = 64
)

func NewBlocklist(r *redis.Client) *Blocklist { return &Blocklist{r: r} }

// Track records a newly issued JTI under its owner so it can later be revoked
// en masse. ttl should equal the access-token lifetime.
func (b *Blocklist) Track(ctx context.Context, userID uint64, jti string, ttl time.Duration) error {
	if b == nil || b.r == nil {
		return nil
	}
	key := userJTIPrefix + itoa(userID)
	pipe := b.r.Pipeline()
	pipe.ZAdd(ctx, key, redis.Z{Score: float64(time.Now().Add(ttl).Unix()), Member: jti})
	pipe.ZRemRangeByScore(ctx, key, "-inf", itoa(uint64(time.Now().Unix())))
	pipe.ZRemRangeByRank(ctx, key, 0, -int64(maxUserJTITrack)-1)
	pipe.Expire(ctx, key, ttl+time.Minute)
	_, err := pipe.Exec(ctx)
	return err
}

// Revoke marks a single jti as revoked until ttl elapses.
func (b *Blocklist) Revoke(ctx context.Context, jti string, ttl time.Duration) error {
	if b == nil || b.r == nil {
		return nil
	}
	if ttl <= 0 {
		ttl = time.Minute
	}
	return b.r.Set(ctx, revKeyPrefix+jti, 1, ttl).Err()
}

// RevokeAll revokes every tracked jti for the user (force-logout).
func (b *Blocklist) RevokeAll(ctx context.Context, userID uint64, ttl time.Duration) error {
	if b == nil || b.r == nil {
		return nil
	}
	key := userJTIPrefix + itoa(userID)
	res, err := b.r.ZRangeByScoreWithScores(ctx, key, &redis.ZRangeBy{Min: "-inf", Max: "+inf"}).Result()
	if err != nil {
		if errors.Is(err, redis.Nil) {
			return nil
		}
		return err
	}
	pipe := b.r.Pipeline()
	now := time.Now().Unix()
	for _, z := range res {
		jti, _ := z.Member.(string)
		if jti == "" {
			continue
		}
		remaining := time.Duration(int64(z.Score)-now) * time.Second
		if remaining <= 0 {
			remaining = time.Second
		}
		pipe.Set(ctx, revKeyPrefix+jti, 1, remaining)
	}
	pipe.Del(ctx, key)
	_, err = pipe.Exec(ctx)
	return err
}

// IsRevoked returns true iff the jti is on the blocklist.
func (b *Blocklist) IsRevoked(ctx context.Context, jti string) bool {
	if b == nil || b.r == nil || jti == "" {
		return false
	}
	n, err := b.r.Exists(ctx, revKeyPrefix+jti).Result()
	if err != nil {
		// fail-open: Redis hiccup must not lock everyone out
		return false
	}
	return n > 0
}
