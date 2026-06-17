package mfa

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"strings"

	"github.com/michongs/wayfort/internal/model"
	"github.com/michongs/wayfort/internal/repo"
	"golang.org/x/crypto/bcrypt"
)

// RecoveryService generates and validates one-time recovery codes used when
// a user has lost their authenticator. Codes are returned in plaintext exactly
// once; we only persist their bcrypt hashes.
type RecoveryService struct {
	repo  *repo.RecoveryCodeRepo
	count int
}

func NewRecoveryService(r *repo.RecoveryCodeRepo, count int) *RecoveryService {
	if count <= 0 {
		count = 10
	}
	return &RecoveryService{repo: r, count: count}
}

// Generate produces N fresh codes and replaces any existing ones for the user.
func (s *RecoveryService) Generate(ctx context.Context, userID uint64) ([]string, error) {
	plain := make([]string, 0, s.count)
	rows := make([]model.UserRecoveryCode, 0, s.count)
	for i := 0; i < s.count; i++ {
		code := generateCode()
		hashed, err := bcrypt.GenerateFromPassword([]byte(code), bcrypt.DefaultCost)
		if err != nil {
			return nil, err
		}
		plain = append(plain, code)
		rows = append(rows, model.UserRecoveryCode{UserID: userID, CodeHash: string(hashed)})
	}
	if err := s.repo.ReplaceAll(ctx, userID, rows); err != nil {
		return nil, err
	}
	return plain, nil
}

// Verify consumes one unused recovery code if the supplied input matches any.
// Returns the matched row ID. Compare is constant-time at the bcrypt layer.
func (s *RecoveryService) Verify(ctx context.Context, userID uint64, code string) (uint64, error) {
	code = strings.TrimSpace(strings.ToUpper(code))
	if code == "" {
		return 0, errors.New("empty code")
	}
	rows, err := s.repo.UnusedByUser(ctx, userID)
	if err != nil {
		return 0, err
	}
	for _, row := range rows {
		if bcrypt.CompareHashAndPassword([]byte(row.CodeHash), []byte(code)) == nil {
			if err := s.repo.MarkUsed(ctx, row.ID); err != nil {
				return 0, err
			}
			return row.ID, nil
		}
	}
	return 0, errors.New("invalid recovery code")
}

// generateCode returns a human-friendly code like "ABCD-EFGH-IJKL" (15 chars + dashes).
func generateCode() string {
	var raw [10]byte
	_, _ = rand.Read(raw[:])
	encoded := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw[:])
	// 16 chars total — break into 4-char groups for readability.
	encoded = strings.ToUpper(encoded[:16])
	return encoded[:4] + "-" + encoded[4:8] + "-" + encoded[8:12] + "-" + encoded[12:16]
}
