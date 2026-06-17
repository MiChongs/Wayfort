// Package passkey wraps go-webauthn to register and authenticate Passkeys
// (FIDO2 credentials). It implements webauthn.User against our internal User
// + WebauthnCredential models without leaking go-webauthn types upward.
package passkey

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	"github.com/redis/go-redis/v9"
)

type Config struct {
	RPID         string
	RPDisplay    string
	Origins      []string
	Discoverable bool
}

type Service struct {
	cfg    Config
	wa     *webauthn.WebAuthn
	users  *repo.UserRepo
	creds  *repo.WebauthnRepo
	cache  *redis.Client
}

func New(cfg Config, users *repo.UserRepo, creds *repo.WebauthnRepo, cache *redis.Client) (*Service, error) {
	if cfg.RPID == "" {
		return nil, errors.New("passkey: rp_id required")
	}
	if len(cfg.Origins) == 0 {
		return nil, errors.New("passkey: at least one origin required")
	}
	if cfg.RPDisplay == "" {
		cfg.RPDisplay = "Wayfort"
	}
	wa, err := webauthn.New(&webauthn.Config{
		RPID:          cfg.RPID,
		RPDisplayName: cfg.RPDisplay,
		RPOrigins:     cfg.Origins,
	})
	if err != nil {
		return nil, err
	}
	return &Service{cfg: cfg, wa: wa, users: users, creds: creds, cache: cache}, nil
}

func (s *Service) Discoverable() bool { return s.cfg.Discoverable }

// ListByUser returns the user's registered Passkey credentials.
func (s *Service) ListByUser(ctx context.Context, userID uint64) ([]model.WebauthnCredential, error) {
	return s.creds.ListByUser(ctx, userID)
}

// ----- session helpers -----

const (
	regSessionKey   = "webauthn:reg:%d"
	loginSessionKey = "webauthn:login:%s"
	sessionTTL      = 5 * time.Minute
)

func (s *Service) storeRegSession(ctx context.Context, userID uint64, data *webauthn.SessionData) error {
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	return s.cache.Set(ctx, fmt.Sprintf(regSessionKey, userID), b, sessionTTL).Err()
}

func (s *Service) loadRegSession(ctx context.Context, userID uint64) (*webauthn.SessionData, error) {
	raw, err := s.cache.Get(ctx, fmt.Sprintf(regSessionKey, userID)).Result()
	if err != nil {
		return nil, errors.New("registration session expired")
	}
	_ = s.cache.Del(ctx, fmt.Sprintf(regSessionKey, userID)).Err()
	var data webauthn.SessionData
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil, err
	}
	return &data, nil
}

func (s *Service) storeLoginSession(ctx context.Context, challengeID string, data *webauthn.SessionData) error {
	b, err := json.Marshal(data)
	if err != nil {
		return err
	}
	return s.cache.Set(ctx, fmt.Sprintf(loginSessionKey, challengeID), b, sessionTTL).Err()
}

func (s *Service) loadLoginSession(ctx context.Context, challengeID string) (*webauthn.SessionData, error) {
	raw, err := s.cache.Get(ctx, fmt.Sprintf(loginSessionKey, challengeID)).Result()
	if err != nil {
		return nil, errors.New("login challenge expired")
	}
	_ = s.cache.Del(ctx, fmt.Sprintf(loginSessionKey, challengeID)).Err()
	var data webauthn.SessionData
	if err := json.Unmarshal([]byte(raw), &data); err != nil {
		return nil, err
	}
	return &data, nil
}

// ----- webauthn.User adapter -----

// waUser adapts a *model.User + its registered credentials to the interface
// go-webauthn requires.
type waUser struct {
	user  *model.User
	creds []webauthn.Credential
}

func (u *waUser) WebAuthnID() []byte                       { return uint64ToBytes(u.user.ID) }
func (u *waUser) WebAuthnName() string                     { return u.user.Username }
func (u *waUser) WebAuthnDisplayName() string              { if u.user.DisplayName != "" { return u.user.DisplayName }; return u.user.Username }
func (u *waUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }
func (u *waUser) WebAuthnIcon() string                     { return u.user.AvatarURL }

func (s *Service) adaptUser(ctx context.Context, user *model.User) (*waUser, error) {
	dbCreds, err := s.creds.ListByUser(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	out := make([]webauthn.Credential, 0, len(dbCreds))
	for _, c := range dbCreds {
		out = append(out, webauthn.Credential{
			ID:              c.CredentialID,
			PublicKey:       c.PublicKey,
			AttestationType: c.AttestationType,
			Authenticator: webauthn.Authenticator{
				AAGUID:       c.AAGUID,
				SignCount:    c.SignCount,
				CloneWarning: c.CloneWarning,
			},
			Transport: parseTransports(c.Transports),
			Flags: webauthn.CredentialFlags{
				UserVerified:   c.UserVerified,
				BackupEligible: c.BackupEligible,
				BackupState:    c.BackupState,
			},
		})
	}
	return &waUser{user: user, creds: out}, nil
}

func parseTransports(s string) []protocol.AuthenticatorTransport {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]protocol.AuthenticatorTransport, 0, len(parts))
	for _, p := range parts {
		out = append(out, protocol.AuthenticatorTransport(strings.TrimSpace(p)))
	}
	return out
}

func uint64ToBytes(v uint64) []byte {
	b := make([]byte, 8)
	for i := 7; i >= 0; i-- {
		b[i] = byte(v & 0xff)
		v >>= 8
	}
	return b
}

func bytesToUint64(b []byte) uint64 {
	var v uint64
	for _, x := range b {
		v = (v << 8) | uint64(x)
	}
	return v
}
