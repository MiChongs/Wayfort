package runner

import (
	"github.com/michongs/jumpserver-anonymous/internal/asset"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
)

// ToolDepsView is a small shared box that the gate consults for auth + asset
// checks. main.go assigns Asset and RBAC during wiring; before then both are
// nil and the gate falls back to "allow" (which is fine — RegisterAll won't be
// called before the resolvers exist anyway).
var ToolDepsView struct {
	Asset *asset.Resolver
	RBAC  *auth.Resolver
}
