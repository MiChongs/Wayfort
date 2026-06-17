package mfa

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/michongs/wayfort/internal/notify"
	"github.com/redis/go-redis/v9"
)

// EmailOTPService delivers 6-digit codes via SMTP and stores them in Redis with
// a short TTL. Cooldown prevents the user from spamming the send endpoint.
type EmailOTPService struct {
	cache    *redis.Client
	mailer   *notify.Mailer
	ttl      time.Duration
	cooldown time.Duration
}

const (
	emailOTPKey      = "mfa:email:%d"
	emailOTPCooldown = "mfa:email:%d:cooldown"
)

func NewEmailOTPService(cache *redis.Client, m *notify.Mailer, ttl, cooldown time.Duration) *EmailOTPService {
	if ttl <= 0 {
		ttl = 5 * time.Minute
	}
	if cooldown <= 0 {
		cooldown = 60 * time.Second
	}
	return &EmailOTPService{cache: cache, mailer: m, ttl: ttl, cooldown: cooldown}
}

var ErrEmailOTPCooldown = errors.New("please wait before requesting another code")

// Send generates a fresh code, persists it, and queues the email. Honours cooldown.
func (s *EmailOTPService) Send(ctx context.Context, userID uint64, email string) error {
	if s.cache == nil || s.mailer == nil {
		return errors.New("email otp not configured")
	}
	if email == "" {
		return errors.New("user has no email")
	}
	ok, err := s.cache.SetNX(ctx, fmt.Sprintf(emailOTPCooldown, userID), 1, s.cooldown).Result()
	if err != nil {
		return err
	}
	if !ok {
		return ErrEmailOTPCooldown
	}
	code := newSixDigits()
	if err := s.cache.Set(ctx, fmt.Sprintf(emailOTPKey, userID), code, s.ttl).Err(); err != nil {
		return err
	}
	s.mailer.Send(notify.MFACodeMessage(email, code, int(s.ttl.Minutes())))
	return nil
}

// Verify checks the code and deletes it on success (single-use).
func (s *EmailOTPService) Verify(ctx context.Context, userID uint64, code string) error {
	if s.cache == nil {
		return errors.New("email otp not configured")
	}
	code = strings.TrimSpace(code)
	stored, err := s.cache.Get(ctx, fmt.Sprintf(emailOTPKey, userID)).Result()
	if err != nil {
		return errors.New("code expired or invalid")
	}
	if subtleEqual(stored, code) {
		_ = s.cache.Del(ctx, fmt.Sprintf(emailOTPKey, userID)).Err()
		return nil
	}
	return errors.New("incorrect code")
}

func newSixDigits() string {
	var b [3]byte
	_, _ = rand.Read(b[:])
	n := (uint32(b[0])<<16 | uint32(b[1])<<8 | uint32(b[2])) % 1_000_000
	return fmt.Sprintf("%06d", n)
}

// subtleEqual is a constant-time string compare to avoid timing leaks on short codes.
func subtleEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var d byte
	for i := 0; i < len(a); i++ {
		d |= a[i] ^ b[i]
	}
	return d == 0
}
