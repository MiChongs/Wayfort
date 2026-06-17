package auth

// The OIDC Provider type intentionally remains a no-op here. The real OIDC
// flow goes through internal/auth/oidc_client.go and a dedicated handler that
// can perform the browser redirect dance — exposing it through the existing
// password-style Provider interface is awkward, so we keep this name reserved
// for future use (e.g. machine-to-machine flows) but it always fails today.

import (
	"context"
	"errors"

	"github.com/michongs/wayfort/internal/model"
)

type OIDCProvider struct{}

func NewOIDCProvider() *OIDCProvider { return &OIDCProvider{} }

func (OIDCProvider) Name() string { return "oidc" }

func (OIDCProvider) Login(_ context.Context, _ LoginPayload) (*model.User, error) {
	return nil, errors.New("use /api/v1/auth/oidc/:provider/login for interactive OIDC")
}
