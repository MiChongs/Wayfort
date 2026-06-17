package passkey

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/michongs/wayfort/internal/model"
)

// LoginBegin starts a Passkey assertion challenge. If username is empty, a
// discoverable (username-less) login is initiated so the browser can pick from
// any registered Passkey for this RP.
func (s *Service) LoginBegin(ctx context.Context, username string) (challengeID string, options *protocol.CredentialAssertion, err error) {
	chID := newChallengeID()
	if username == "" {
		if !s.cfg.Discoverable {
			return "", nil, errors.New("discoverable login disabled")
		}
		opts, session, err := s.wa.BeginDiscoverableLogin()
		if err != nil {
			return "", nil, err
		}
		if err := s.storeLoginSession(ctx, chID, session); err != nil {
			return "", nil, err
		}
		return chID, opts, nil
	}
	user, err := s.users.FindByUsername(ctx, username)
	if err != nil {
		return "", nil, err
	}
	if user == nil {
		return "", nil, errors.New("user not found")
	}
	wu, err := s.adaptUser(ctx, user)
	if err != nil {
		return "", nil, err
	}
	opts, session, err := s.wa.BeginLogin(wu)
	if err != nil {
		return "", nil, err
	}
	if err := s.storeLoginSession(ctx, chID, session); err != nil {
		return "", nil, err
	}
	return chID, opts, nil
}

// LoginFinish validates the browser's assertion and returns the user that
// owns the credential, updating its sign counter.
func (s *Service) LoginFinish(ctx context.Context, challengeID string, body []byte) (*model.User, error) {
	session, err := s.loadLoginSession(ctx, challengeID)
	if err != nil {
		return nil, err
	}
	parsed, err := protocol.ParseCredentialRequestResponseBody(jsonReader(body))
	if err != nil {
		return nil, err
	}
	// Look up the credential the browser asserted, find its owning user.
	credID := parsed.Response.AuthenticatorData.AttData.CredentialID
	if len(credID) == 0 {
		// Discoverable login: pull the credential id from the response directly.
		credID = parsed.RawID
	}
	row, err := s.creds.FindByCredentialID(ctx, credID)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, errors.New("credential not registered")
	}
	user, err := s.users.FindByID(ctx, row.UserID)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errors.New("owning user missing")
	}
	wu, err := s.adaptUser(ctx, user)
	if err != nil {
		return nil, err
	}
	var cred *struct{ /* placeholder */ }
	_ = cred
	if challengeID == "" {
		return nil, errors.New("missing challenge id")
	}
	// Branch: discoverable vs identified.
	var validated *struct {
		ID       []byte
		SignCount uint32
	}
	if session.UserID == nil || len(session.UserID) == 0 {
		c, err := s.wa.ValidateDiscoverableLogin(func(_, userHandle []byte) (webauthn.User, error) {
			if bytesToUint64(userHandle) != user.ID {
				return nil, errors.New("user handle mismatch")
			}
			return wu, nil
		}, *session, parsed)
		if err != nil {
			return nil, err
		}
		validated = &struct {
			ID        []byte
			SignCount uint32
		}{ID: c.ID, SignCount: c.Authenticator.SignCount}
	} else {
		c, err := s.wa.ValidateLogin(wu, *session, parsed)
		if err != nil {
			return nil, err
		}
		validated = &struct {
			ID        []byte
			SignCount uint32
		}{ID: c.ID, SignCount: c.Authenticator.SignCount}
	}
	// Persist new sign count.
	_ = s.creds.UpdateSignCount(ctx, row.ID, validated.SignCount)
	return user, nil
}

func newChallengeID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
