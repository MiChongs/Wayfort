package auth

import (
	"context"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"golang.org/x/crypto/bcrypt"
)

type LocalProvider struct{ users *repo.UserRepo }

func NewLocalProvider(u *repo.UserRepo) *LocalProvider { return &LocalProvider{users: u} }

func (p *LocalProvider) Name() string { return "local" }

func (p *LocalProvider) Login(ctx context.Context, payload LoginPayload) (*model.User, error) {
	if payload.Username == "" || payload.Password == "" {
		return nil, ErrInvalidCredentials
	}
	u, err := p.users.FindByUsername(ctx, payload.Username)
	if err != nil {
		return nil, err
	}
	if u == nil || u.Disabled {
		return nil, ErrInvalidCredentials
	}
	if err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(payload.Password)); err != nil {
		return nil, ErrInvalidCredentials
	}
	return u, nil
}

func HashPassword(plain string) (string, error) {
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	return string(b), err
}
