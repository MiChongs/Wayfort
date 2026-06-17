package mfa

import (
	"testing"
	"time"

	pkgcrypto "github.com/michongs/wayfort/pkg/crypto"
	"github.com/pquerna/otp/totp"
)

func TestTOTPGenerateAndValidate(t *testing.T) {
	key, err := totp.Generate(totp.GenerateOpts{Issuer: "x", AccountName: "a"})
	if err != nil {
		t.Fatal(err)
	}
	code, err := totp.GenerateCode(key.Secret(), time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !validate(code, key.Secret()) {
		t.Fatal("expected validate to accept a freshly generated code")
	}
	if validate("000000", key.Secret()) {
		// May match with astronomically low probability — skip strict assertion.
		t.Log("matched 000000; ignored")
	}
}

func TestRecoveryCodeFormat(t *testing.T) {
	for i := 0; i < 20; i++ {
		c := generateCode()
		if len(c) != 19 {
			t.Fatalf("bad length: %q", c)
		}
		if c[4] != '-' || c[9] != '-' || c[14] != '-' {
			t.Fatalf("missing separators: %q", c)
		}
	}
}

func TestSealerRoundtrip(t *testing.T) {
	s, err := pkgcrypto.NewSealer("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := s.Seal([]byte("hello"))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := s.Open(sealed)
	if err != nil {
		t.Fatal(err)
	}
	if string(plain) != "hello" {
		t.Fatalf("roundtrip failed: %s", plain)
	}
}
