package runner

import (
	"context"
	"sync"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// ToolDepsView is a small shared box that the gate consults for auth + asset
// checks, and that makeToolCtx consults to resolve the caller's username for
// audit attribution. main.go assigns these during wiring; before then they are
// nil and the gate falls back to "allow" (which is fine — RegisterAll won't be
// called before the resolvers exist anyway).
var ToolDepsView struct {
	Asset *asset.Resolver
	RBAC  *auth.Resolver
	Users *repo.UserRepo
}

// usernameCache memoises userID → username so we don't hit the DB on every tool
// call within a turn. Usernames are effectively immutable for the life of a
// process, so a process-wide cache is safe.
var usernameCache sync.Map // uint64 -> string

// resolveUsername returns the username for a user id, falling back to "" when
// the repo isn't wired or the lookup fails (audit rows then carry just the id).
func resolveUsername(ctx context.Context, userID uint64) string {
	if userID == 0 {
		return ""
	}
	if v, ok := usernameCache.Load(userID); ok {
		return v.(string)
	}
	if ToolDepsView.Users == nil {
		return ""
	}
	u, err := ToolDepsView.Users.FindByID(ctx, userID)
	if err != nil || u == nil {
		return ""
	}
	usernameCache.Store(userID, u.Username)
	return u.Username
}
