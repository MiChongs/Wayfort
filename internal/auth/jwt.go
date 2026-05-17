package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// AuthStep distinguishes ordinary access tokens from intermediate tokens used
// between the password step and a successful MFA challenge.
type AuthStep string

const (
	AuthStepActive       AuthStep = ""             // fully authenticated
	AuthStepMFARequired  AuthStep = "mfa_required" // password ok, awaiting second factor
	AuthStepRefresh      AuthStep = "refresh"      // refresh token
)

type Claims struct {
	UserID    uint64   `json:"uid"`
	Username  string   `json:"usr"`
	Anonymous bool     `json:"anon,omitempty"`
	Admin     bool     `json:"adm,omitempty"`
	Step      AuthStep `json:"step,omitempty"`
	Methods   []string `json:"mfa_methods,omitempty"` // populated on AuthStepMFARequired
	jwt.RegisteredClaims
}

type TokenPair struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token,omitempty"`
	ExpiresAt    time.Time `json:"expires_at"`
}

type Issuer struct {
	secret     []byte
	accessTTL  time.Duration
	refreshTTL time.Duration
}

func NewIssuer(secret string, accessTTL, refreshTTL time.Duration) *Issuer {
	return &Issuer{secret: []byte(secret), accessTTL: accessTTL, refreshTTL: refreshTTL}
}

func (i *Issuer) AccessTTL() time.Duration  { return i.accessTTL }
func (i *Issuer) RefreshTTL() time.Duration { return i.refreshTTL }

// Issue signs an ordinary access token (and a refresh token unless the claims
// belong to an anonymous user or an in-progress MFA challenge).
func (i *Issuer) Issue(c Claims) (TokenPair, error) {
	now := time.Now()
	exp := now.Add(i.accessTTL)
	c.RegisteredClaims = jwt.RegisteredClaims{
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(exp),
		Subject:   fmt.Sprintf("%d", c.UserID),
		ID:        newJTI(),
	}
	access, err := i.sign(c)
	if err != nil {
		return TokenPair{}, err
	}
	pair := TokenPair{AccessToken: access, ExpiresAt: exp}
	if c.Step == AuthStepActive && i.refreshTTL > 0 && !c.Anonymous {
		ref := Claims{
			UserID:   c.UserID,
			Username: c.Username,
			Admin:    c.Admin,
			Step:     AuthStepRefresh,
			RegisteredClaims: jwt.RegisteredClaims{
				IssuedAt:  jwt.NewNumericDate(now),
				ExpiresAt: jwt.NewNumericDate(now.Add(i.refreshTTL)),
				Subject:   fmt.Sprintf("%d", c.UserID),
				ID:        newJTI(),
			},
		}
		refresh, err := i.sign(ref)
		if err != nil {
			return TokenPair{}, err
		}
		pair.RefreshToken = refresh
	}
	return pair, nil
}

// IssueChallenge signs a short-lived intermediate token used between the
// password step and a successful MFA challenge.
func (i *Issuer) IssueChallenge(userID uint64, username string, methods []string, ttl time.Duration) (string, time.Time, error) {
	now := time.Now()
	exp := now.Add(ttl)
	c := Claims{
		UserID:   userID,
		Username: username,
		Step:     AuthStepMFARequired,
		Methods:  methods,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
			Subject:   fmt.Sprintf("%d", userID),
			ID:        newJTI(),
		},
	}
	tok, err := i.sign(c)
	return tok, exp, err
}

func (i *Issuer) sign(c Claims) (string, error) {
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	return t.SignedString(i.secret)
}

func (i *Issuer) Parse(token string) (*Claims, error) {
	c := &Claims{}
	t, err := jwt.ParseWithClaims(token, c, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return i.secret, nil
	})
	if err != nil {
		return nil, err
	}
	if !t.Valid {
		return nil, errors.New("invalid token")
	}
	return c, nil
}

func newJTI() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
