// Package mfa implements multi-factor authentication: TOTP, email OTP, and
// recovery codes. All long-term secrets are AES-GCM-sealed before persistence.
package mfa

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image/png"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"github.com/pquerna/otp"
	"github.com/pquerna/otp/totp"
)

// TOTPService is the only thing that touches pquerna/otp directly.
type TOTPService struct {
	issuer string
	repo   *repo.UserMFARepo
	sealer pkgcrypto.Vault
}

func NewTOTPService(issuer string, r *repo.UserMFARepo, s pkgcrypto.Vault) *TOTPService {
	if issuer == "" {
		issuer = "JumpServer"
	}
	return &TOTPService{issuer: issuer, repo: r, sealer: s}
}

// EnrolmentResult is what the client needs to render a QR + ask the user for a
// confirmation code.
type EnrolmentResult struct {
	MFAID     uint64 `json:"mfa_id"`
	Secret    string `json:"secret"`
	OTPAuth   string `json:"otpauth_uri"`
	QRBase64  string `json:"qr_base64"`
}

// BeginEnrolment creates an unconfirmed UserMFA row and returns the seed.
// Until the user submits a valid code via FinishEnrolment the row stays
// disabled and isn't honored at login time.
func (s *TOTPService) BeginEnrolment(ctx context.Context, user *model.User, displayName string) (*EnrolmentResult, error) {
	if user == nil {
		return nil, errors.New("nil user")
	}
	if displayName == "" {
		displayName = "Authenticator"
	}
	account := user.Email
	if account == "" {
		account = user.Username
	}
	key, err := totp.Generate(totp.GenerateOpts{
		Issuer:      s.issuer,
		AccountName: account,
		Period:      30,
		Digits:      otp.DigitsSix,
		Algorithm:   otp.AlgorithmSHA1,
	})
	if err != nil {
		return nil, err
	}
	sealed, err := s.sealer.Seal([]byte(key.Secret()))
	if err != nil {
		return nil, err
	}
	row := &model.UserMFA{
		UserID:          user.ID,
		Type:            model.MFATypeTOTP,
		DisplayName:     displayName,
		SecretEncrypted: sealed,
		Enabled:         false,
		CreatedAt:       time.Now(),
	}
	if err := s.repo.Create(ctx, row); err != nil {
		return nil, err
	}
	img, err := key.Image(200, 200)
	if err != nil {
		return nil, err
	}
	buf := new(bytes.Buffer)
	if err := png.Encode(buf, img); err != nil {
		return nil, err
	}
	return &EnrolmentResult{
		MFAID:    row.ID,
		Secret:   key.Secret(),
		OTPAuth:  key.URL(),
		QRBase64: base64.StdEncoding.EncodeToString(buf.Bytes()),
	}, nil
}

// FinishEnrolment validates the one-time code and flips Enabled=true.
func (s *TOTPService) FinishEnrolment(ctx context.Context, userID, mfaID uint64, code string) error {
	row, err := s.repo.FindByID(ctx, mfaID)
	if err != nil {
		return err
	}
	if row == nil || row.UserID != userID || row.Type != model.MFATypeTOTP {
		return errors.New("mfa row not found")
	}
	if row.Enabled {
		return errors.New("already enabled")
	}
	secret, err := s.sealer.Open(row.SecretEncrypted)
	if err != nil {
		return err
	}
	if !validate(code, string(secret)) {
		return errors.New("invalid code")
	}
	row.Enabled = true
	now := time.Now()
	row.LastUsedAt = &now
	return s.repo.Update(ctx, row)
}

// Verify checks the supplied code against every enabled TOTP factor on the
// user. Returns the matching MFA ID on success.
func (s *TOTPService) Verify(ctx context.Context, userID uint64, code string) (uint64, error) {
	rows, err := s.repo.ListEnabled(ctx, userID)
	if err != nil {
		return 0, err
	}
	for _, row := range rows {
		if row.Type != model.MFATypeTOTP {
			continue
		}
		secret, err := s.sealer.Open(row.SecretEncrypted)
		if err != nil {
			continue
		}
		if validate(code, string(secret)) {
			now := time.Now()
			row.LastUsedAt = &now
			_ = s.repo.Update(ctx, &row)
			return row.ID, nil
		}
	}
	return 0, errors.New("no matching TOTP code")
}

// Disable removes a TOTP factor (e.g. user lost the device).
func (s *TOTPService) Disable(ctx context.Context, userID, mfaID uint64) error {
	return s.repo.Delete(ctx, mfaID, userID)
}

func validate(code, secret string) bool {
	valid, err := totp.ValidateCustom(code, secret, time.Now(), totp.ValidateOpts{
		Period:    30,
		Skew:      1, // tolerate +/- 1 step (90 s total window)
		Digits:    otp.DigitsSix,
		Algorithm: otp.AlgorithmSHA1,
	})
	if err != nil {
		return false
	}
	return valid
}

// HumanLabel returns "GA - iPhone (last used 2m ago)" for UI display.
func HumanLabel(m model.UserMFA) string {
	suffix := "never used"
	if m.LastUsedAt != nil {
		suffix = fmt.Sprintf("last used %s", time.Since(*m.LastUsedAt).Round(time.Second))
	}
	return fmt.Sprintf("%s — %s — %s", m.Type, m.DisplayName, suffix)
}
