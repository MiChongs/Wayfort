package auth

import (
	"context"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// OIDCProvider is a placeholder so callers can wire a name now and replace the
// implementation later without touching the registry plumbing.
type OIDCProvider struct{}

func NewOIDCProvider() *OIDCProvider { return &OIDCProvider{} }

func (OIDCProvider) Name() string { return "oidc" }

func (OIDCProvider) Login(_ context.Context, _ LoginPayload) (*model.User, error) {
	return nil, ErrProviderNotSupported
}
