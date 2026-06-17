package auth

import (
	"context"
	"errors"

	"github.com/michongs/wayfort/internal/model"
)

var ErrInvalidCredentials = errors.New("invalid credentials")
var ErrProviderNotSupported = errors.New("provider not supported")

// LoginPayload is the generic input every provider accepts; only Username and
// Password are used by the local provider, Code is reserved for OIDC.
type LoginPayload struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Code     string `json:"code,omitempty"`
}

type Provider interface {
	Name() string
	Login(ctx context.Context, p LoginPayload) (*model.User, error)
}

type Registry struct{ providers map[string]Provider }

func NewRegistry() *Registry { return &Registry{providers: map[string]Provider{}} }

func (r *Registry) Register(p Provider) { r.providers[p.Name()] = p }

func (r *Registry) Get(name string) (Provider, bool) {
	p, ok := r.providers[name]
	return p, ok
}
