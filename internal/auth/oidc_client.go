package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"github.com/redis/go-redis/v9"
	"golang.org/x/oauth2"
)

// OIDCManager resolves IdP configurations stored in the DB into ready-to-use
// oidc.Provider + oauth2.Config pairs, caching them in memory so issuer
// discovery isn't repeated on every login.
type OIDCManager struct {
	repo   *repo.OIDCClientRepo
	cache  *redis.Client
	sealer *pkgcrypto.Sealer

	mu      sync.RWMutex
	clients map[string]*OIDCInstance
}

type OIDCInstance struct {
	Row      *model.OIDCClient
	Provider *oidc.Provider
	OAuth    *oauth2.Config
	Verifier *oidc.IDTokenVerifier
}

const oidcStateKey = "oidc:state:%s"

type oidcState struct {
	Provider   string `json:"p"`
	Verifier   string `json:"v"` // PKCE code_verifier
	Nonce      string `json:"n"`
	ReturnURL  string `json:"r,omitempty"`
}

func NewOIDCManager(r *repo.OIDCClientRepo, cache *redis.Client, sealer *pkgcrypto.Sealer) *OIDCManager {
	return &OIDCManager{repo: r, cache: cache, sealer: sealer, clients: map[string]*OIDCInstance{}}
}

// Get retrieves (and lazily initialises) the instance for a provider name.
func (m *OIDCManager) Get(ctx context.Context, name string) (*OIDCInstance, error) {
	m.mu.RLock()
	if inst, ok := m.clients[name]; ok {
		m.mu.RUnlock()
		return inst, nil
	}
	m.mu.RUnlock()
	row, err := m.repo.FindByName(ctx, name)
	if err != nil {
		return nil, err
	}
	if row == nil || !row.Enabled {
		return nil, errors.New("oidc provider not configured")
	}
	prov, err := oidc.NewProvider(ctx, row.Issuer)
	if err != nil {
		return nil, fmt.Errorf("oidc discovery: %w", err)
	}
	secret, err := m.sealer.Open(row.ClientSecretEncrypted)
	if err != nil {
		return nil, fmt.Errorf("decrypt client secret: %w", err)
	}
	scopes := []string{oidc.ScopeOpenID}
	if row.Scopes != "" {
		scopes = strings.Fields(row.Scopes)
	}
	cfg := &oauth2.Config{
		ClientID:     row.ClientID,
		ClientSecret: string(secret),
		RedirectURL:  row.RedirectURI,
		Endpoint:     prov.Endpoint(),
		Scopes:       scopes,
	}
	inst := &OIDCInstance{
		Row:      row,
		Provider: prov,
		OAuth:    cfg,
		Verifier: prov.Verifier(&oidc.Config{ClientID: row.ClientID}),
	}
	m.mu.Lock()
	m.clients[name] = inst
	m.mu.Unlock()
	return inst, nil
}

// Invalidate drops a cached instance (call after admin updates the row).
func (m *OIDCManager) Invalidate(name string) {
	m.mu.Lock()
	delete(m.clients, name)
	m.mu.Unlock()
}

// AuthorizeURL builds the initial redirect URL and persists the state/nonce so
// the callback can verify them.
func (m *OIDCManager) AuthorizeURL(ctx context.Context, name string) (string, error) {
	inst, err := m.Get(ctx, name)
	if err != nil {
		return "", err
	}
	state := newJTI()
	nonce := newJTI()
	verifier := oauth2.GenerateVerifier()
	st := oidcState{Provider: name, Verifier: verifier, Nonce: nonce}
	b, _ := json.Marshal(st)
	if err := m.cache.Set(ctx, fmt.Sprintf(oidcStateKey, state), b, 10*time.Minute).Err(); err != nil {
		return "", err
	}
	return inst.OAuth.AuthCodeURL(
		state,
		oidc.Nonce(nonce),
		oauth2.S256ChallengeOption(verifier),
		oauth2.AccessTypeOnline,
	), nil
}

// HandleCallback exchanges the code and returns claims and the matching local
// user (creating one when auto_create_user is enabled).
func (m *OIDCManager) HandleCallback(ctx context.Context, state, code string, users *repo.UserRepo) (*model.User, *model.OIDCClient, error) {
	raw, err := m.cache.Get(ctx, fmt.Sprintf(oidcStateKey, state)).Result()
	if err != nil {
		return nil, nil, errors.New("state expired or invalid")
	}
	_ = m.cache.Del(ctx, fmt.Sprintf(oidcStateKey, state)).Err()
	var st oidcState
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		return nil, nil, err
	}
	inst, err := m.Get(ctx, st.Provider)
	if err != nil {
		return nil, nil, err
	}
	tok, err := inst.OAuth.Exchange(ctx, code, oauth2.VerifierOption(st.Verifier))
	if err != nil {
		return nil, nil, fmt.Errorf("oauth exchange: %w", err)
	}
	rawID, ok := tok.Extra("id_token").(string)
	if !ok || rawID == "" {
		return nil, nil, errors.New("no id_token in oidc response")
	}
	idTok, err := inst.Verifier.Verify(ctx, rawID)
	if err != nil {
		return nil, nil, fmt.Errorf("verify id_token: %w", err)
	}
	if idTok.Nonce != st.Nonce {
		return nil, nil, errors.New("nonce mismatch")
	}
	var claims map[string]any
	if err := idTok.Claims(&claims); err != nil {
		return nil, nil, err
	}
	usernameClaim := orDefault(inst.Row.UsernameClaim, "preferred_username")
	emailClaim := orDefault(inst.Row.EmailClaim, "email")
	username, _ := claims[usernameClaim].(string)
	email, _ := claims[emailClaim].(string)
	displayName, _ := claims["name"].(string)
	if username == "" {
		username = email
	}
	if username == "" {
		return nil, nil, errors.New("oidc claim missing username")
	}
	// Find or create local user.
	user, err := users.FindByUsername(ctx, username)
	if err != nil {
		return nil, nil, err
	}
	if user == nil && inst.Row.AutoCreateUser {
		user = &model.User{
			Username:    username,
			Email:       email,
			DisplayName: displayName,
			IsAdmin:     false,
		}
		if err := users.Create(ctx, user); err != nil {
			return nil, nil, err
		}
	}
	if user == nil {
		return nil, nil, errors.New("local user not provisioned for this OIDC identity")
	}
	return user, inst.Row, nil
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
