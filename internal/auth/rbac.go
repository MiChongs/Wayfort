package auth

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/redis/go-redis/v9"
)

// Resolver aggregates a user's permissions (from all assigned roles) and
// caches the result both in-process and in Redis.
type Resolver struct {
	roles  *repo.RoleRepo
	users  *repo.UserRepo
	cache  *redis.Client
	ttl    time.Duration

	mu  sync.RWMutex
	mem map[uint64]cachedPerms
}

type cachedPerms struct {
	perms     map[string]struct{}
	expiresAt time.Time
}

const cacheKeyPerms = "rbac:perms:"

func NewResolver(users *repo.UserRepo, roles *repo.RoleRepo, cache *redis.Client) *Resolver {
	return &Resolver{
		roles: roles,
		users: users,
		cache: cache,
		ttl:   60 * time.Second,
		mem:   make(map[uint64]cachedPerms),
	}
}

// Permissions returns the merged permission set for a user. Result is cached.
func (r *Resolver) Permissions(ctx context.Context, userID uint64) (map[string]struct{}, error) {
	if userID == 0 {
		return nil, nil
	}
	// in-process cache
	r.mu.RLock()
	if cp, ok := r.mem[userID]; ok && time.Now().Before(cp.expiresAt) {
		r.mu.RUnlock()
		return cp.perms, nil
	}
	r.mu.RUnlock()

	// Redis cache
	if r.cache != nil {
		raw, err := r.cache.Get(ctx, cacheKeyPerms+itoa(userID)).Result()
		if err == nil && raw != "" {
			var arr []string
			if json.Unmarshal([]byte(raw), &arr) == nil {
				perms := toSet(arr)
				r.storeMem(userID, perms)
				return perms, nil
			}
		}
	}

	// DB
	user, err := r.users.FindByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errors.New("user not found")
	}
	perms := make(map[string]struct{})
	if user.IsAdmin {
		perms[PermSystemAdmin] = struct{}{}
	}
	list, err := r.roles.PermissionsForUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	for _, p := range list {
		perms[p] = struct{}{}
	}
	r.storeMem(userID, perms)
	if r.cache != nil {
		arr := make([]string, 0, len(perms))
		for k := range perms {
			arr = append(arr, k)
		}
		b, _ := json.Marshal(arr)
		_ = r.cache.Set(ctx, cacheKeyPerms+itoa(userID), b, r.ttl).Err()
	}
	return perms, nil
}

// Has is a convenience wrapper for single-permission checks.
func (r *Resolver) Has(ctx context.Context, userID uint64, perm string) (bool, error) {
	perms, err := r.Permissions(ctx, userID)
	if err != nil {
		return false, err
	}
	if HasSystem(perms) {
		return true, nil
	}
	_, ok := perms[perm]
	return ok, nil
}

// Invalidate drops cached permissions for one user (call after role changes).
func (r *Resolver) Invalidate(ctx context.Context, userID uint64) {
	r.mu.Lock()
	delete(r.mem, userID)
	r.mu.Unlock()
	if r.cache != nil {
		_ = r.cache.Del(ctx, cacheKeyPerms+itoa(userID)).Err()
	}
}

func (r *Resolver) storeMem(uid uint64, perms map[string]struct{}) {
	r.mu.Lock()
	r.mem[uid] = cachedPerms{perms: perms, expiresAt: time.Now().Add(r.ttl)}
	r.mu.Unlock()
}

func toSet(arr []string) map[string]struct{} {
	out := make(map[string]struct{}, len(arr))
	for _, s := range arr {
		out[s] = struct{}{}
	}
	return out
}

func itoa(v uint64) string {
	// Avoid pulling fmt for one call.
	const digits = "0123456789"
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = digits[v%10]
		v /= 10
	}
	return string(buf[i:])
}
