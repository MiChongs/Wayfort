package passkey

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/michongs/wayfort/internal/model"
)

// BeginRegistration starts a new Passkey enrolment for an authenticated user.
// The returned `protocol.CredentialCreation` is JSON-serialised and handed to
// the browser as input for navigator.credentials.create().
func (s *Service) BeginRegistration(ctx context.Context, user *model.User, displayName string) (*protocol.CredentialCreation, error) {
	wu, err := s.adaptUser(ctx, user)
	if err != nil {
		return nil, err
	}
	// Force resident key creation so the credential is discoverable later
	// (used for username-less login).
	authSel := protocol.AuthenticatorSelection{
		ResidentKey:      protocol.ResidentKeyRequirementPreferred,
		UserVerification: protocol.VerificationPreferred,
	}
	opts, session, err := s.wa.BeginRegistration(
		wu,
		webauthn.WithAuthenticatorSelection(authSel),
	)
	if err != nil {
		return nil, err
	}
	if err := s.storeRegSession(ctx, user.ID, session); err != nil {
		return nil, err
	}
	_ = displayName
	return opts, nil
}

// FinishRegistration validates the browser's response and stores the credential.
// `parsedBody` is the JSON body received from navigator.credentials.create
// (`attestation`).
func (s *Service) FinishRegistration(ctx context.Context, user *model.User, displayName string, parsedBody []byte) (*model.WebauthnCredential, error) {
	session, err := s.loadRegSession(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	wu, err := s.adaptUser(ctx, user)
	if err != nil {
		return nil, err
	}
	parsedResp, err := protocol.ParseCredentialCreationResponseBody(jsonReader(parsedBody))
	if err != nil {
		return nil, err
	}
	cred, err := s.wa.CreateCredential(wu, *session, parsedResp)
	if err != nil {
		return nil, err
	}
	// Stash to DB.
	row := &model.WebauthnCredential{
		UserID:          user.ID,
		CredentialID:    cred.ID,
		PublicKey:       cred.PublicKey,
		AAGUID:          cred.Authenticator.AAGUID,
		SignCount:       cred.Authenticator.SignCount,
		Transports:      transportStr(cred.Transport),
		AttestationType: cred.AttestationType,
		DisplayName:     fallback(displayName, "Passkey"),
		UserVerified:    cred.Flags.UserVerified,
		BackupEligible:  cred.Flags.BackupEligible,
		BackupState:     cred.Flags.BackupState,
		CreatedAt:       time.Now(),
	}
	if err := s.creds.Create(ctx, row); err != nil {
		return nil, err
	}
	return row, nil
}

func (s *Service) DeleteCredential(ctx context.Context, userID, credID uint64) error {
	return s.creds.Delete(ctx, credID, userID)
}

func transportStr(ts []protocol.AuthenticatorTransport) string {
	if len(ts) == 0 {
		return ""
	}
	parts := make([]string, 0, len(ts))
	for _, t := range ts {
		parts = append(parts, string(t))
	}
	return strings.Join(parts, ",")
}

func fallback(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// jsonReader avoids importing strings.NewReader at every callsite.
func jsonReader(b []byte) interface {
	Read(p []byte) (int, error)
} {
	return &byteReader{b: b}
}

type byteReader struct {
	b []byte
	i int
}

func (r *byteReader) Read(p []byte) (int, error) {
	if r.i >= len(r.b) {
		return 0, errReaderEOF
	}
	n := copy(p, r.b[r.i:])
	r.i += n
	return n, nil
}

var errReaderEOF = errors.New("EOF")
