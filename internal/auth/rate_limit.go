package auth

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// LockoutPolicy enforces "N failed logins → lock the account for D" using
// Redis-side counters that auto-expire.
type LockoutPolicy struct {
	r         *redis.Client
	Threshold int
	Window    time.Duration
	Duration  time.Duration
}

const (
	failKeyPrefix = "login:fail:"
	lockKeyPrefix = "login:lock:"
)

func NewLockoutPolicy(r *redis.Client, threshold int, window, duration time.Duration) *LockoutPolicy {
	if threshold <= 0 {
		threshold = 5
	}
	if window <= 0 {
		window = 15 * time.Minute
	}
	if duration <= 0 {
		duration = 15 * time.Minute
	}
	return &LockoutPolicy{r: r, Threshold: threshold, Window: window, Duration: duration}
}

var ErrAccountLocked = errors.New("account is temporarily locked")

// Check returns ErrAccountLocked if the username is currently locked.
func (p *LockoutPolicy) Check(ctx context.Context, username string) error {
	if p == nil || p.r == nil || username == "" {
		return nil
	}
	username = strings.ToLower(username)
	n, err := p.r.Exists(ctx, lockKeyPrefix+username).Result()
	if err != nil {
		return nil // fail-open
	}
	if n > 0 {
		return ErrAccountLocked
	}
	return nil
}

// RecordFailure increments the per-username failure counter; if it crosses
// the threshold, the account is locked. Returns the current count and whether
// the lock was triggered by this call.
func (p *LockoutPolicy) RecordFailure(ctx context.Context, username string) (int, bool, error) {
	if p == nil || p.r == nil || username == "" {
		return 0, false, nil
	}
	username = strings.ToLower(username)
	key := failKeyPrefix + username
	cnt, err := p.r.Incr(ctx, key).Result()
	if err != nil {
		return 0, false, err
	}
	if cnt == 1 {
		_ = p.r.Expire(ctx, key, p.Window).Err()
	}
	if int(cnt) >= p.Threshold {
		_ = p.r.Set(ctx, lockKeyPrefix+username, 1, p.Duration).Err()
		_ = p.r.Del(ctx, key).Err()
		return int(cnt), true, nil
	}
	return int(cnt), false, nil
}

// ClearFailures resets the counter on successful login.
func (p *LockoutPolicy) ClearFailures(ctx context.Context, username string) {
	if p == nil || p.r == nil || username == "" {
		return
	}
	username = strings.ToLower(username)
	_ = p.r.Del(ctx, failKeyPrefix+username).Err()
	_ = p.r.Del(ctx, lockKeyPrefix+username).Err()
}

// Unlock is used by admins.
func (p *LockoutPolicy) Unlock(ctx context.Context, username string) error {
	if p == nil || p.r == nil {
		return nil
	}
	username = strings.ToLower(username)
	pipe := p.r.Pipeline()
	pipe.Del(ctx, failKeyPrefix+username)
	pipe.Del(ctx, lockKeyPrefix+username)
	_, err := pipe.Exec(ctx)
	return err
}
