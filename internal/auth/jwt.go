package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID    uint64 `json:"uid"`
	Username  string `json:"usr"`
	Anonymous bool   `json:"anon,omitempty"`
	Admin     bool   `json:"adm,omitempty"`
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

func (i *Issuer) Issue(c Claims) (TokenPair, error) {
	now := time.Now()
	exp := now.Add(i.accessTTL)
	c.RegisteredClaims = jwt.RegisteredClaims{
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(exp),
		Subject:   fmt.Sprintf("%d", c.UserID),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	access, err := tok.SignedString(i.secret)
	if err != nil {
		return TokenPair{}, err
	}
	pair := TokenPair{AccessToken: access, ExpiresAt: exp}
	if i.refreshTTL > 0 && !c.Anonymous {
		refresh := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
			UserID:   c.UserID,
			Username: c.Username,
			Admin:    c.Admin,
			RegisteredClaims: jwt.RegisteredClaims{
				IssuedAt:  jwt.NewNumericDate(now),
				ExpiresAt: jwt.NewNumericDate(now.Add(i.refreshTTL)),
				Subject:   fmt.Sprintf("%d", c.UserID),
				ID:        "refresh",
			},
		})
		pair.RefreshToken, err = refresh.SignedString(i.secret)
		if err != nil {
			return TokenPair{}, err
		}
	}
	return pair, nil
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
