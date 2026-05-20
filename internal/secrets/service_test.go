package secrets

import (
	"bytes"
	"context"
	"path/filepath"
	"testing"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"github.com/michongs/jumpserver-anonymous/pkg/kms"
	"go.uber.org/zap"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// newTestDB spins up an in-memory SQLite handle with the Phase 14
// schema migrated. SQLite is fine for the envelope tests because they
// only exercise GORM's portable subset (no MySQL-isms, no Postgres-
// isms in the new tables).
//
// Note: the actual deployment is Postgres-only; this test uses SQLite
// purely as a hermetic in-memory store.
func newTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	if err := db.AutoMigrate(
		&model.KMSProvider{},
		&model.SecretEnvelope{},
		&model.SecretAudit{},
		&model.KMSSealMaterial{},
	); err != nil {
		t.Fatalf("automigrate: %v", err)
	}
	return db
}

// TestEnvelopeRoundTrip seals a plaintext, asserts the persistence
// shape, then unseals and asserts byte equality. The KMS layer is
// the file-free Local provider so the test stays self-contained.
func TestEnvelopeRoundTrip(t *testing.T) {
	db := newTestDB(t)
	providers := repo.NewKMSProviderRepo(db)
	envelopes := repo.NewSecretEnvelopeRepo(db)
	audits := repo.NewSecretAuditRepo(db)

	// Mint a 32-byte KEK directly. In production this comes out of
	// kms_providers.AuthCiphertext via the bootstrap unsealer; here
	// we feed the bytes in directly.
	kek := make([]byte, 32)
	for i := range kek {
		kek[i] = byte(i)
	}
	primary, err := kms.NewLocal("test-local", "primary", kek)
	if err != nil {
		t.Fatalf("new local: %v", err)
	}

	primaryRow := &model.KMSProvider{
		Name:      "test-local",
		Kind:      model.KMSKindLocal,
		KeyID:     "primary",
		IsPrimary: true,
		Enabled:   true,
	}
	if err := providers.Create(context.Background(), primaryRow); err != nil {
		t.Fatalf("create provider: %v", err)
	}

	svc := NewService(Deps{
		Envelopes:  envelopes,
		Providers:  providers,
		Audits:     audits,
		Primary:    primary,
		PrimaryRow: primaryRow,
	})

	plain := []byte("supersecret-credential-payload-42")
	res, err := svc.Encrypt(context.Background(), EncryptRequest{
		OwnerType: model.OwnerCredentialSecret,
		OwnerID:   1234,
		Plaintext: plain,
		Version:   1,
	})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	if res.Envelope.ID == 0 {
		t.Fatalf("envelope id not set")
	}
	if bytes.Contains(res.Envelope.Ciphertext, plain) {
		t.Fatalf("ciphertext contains plaintext — AEAD broken")
	}
	if bytes.Contains(res.Envelope.EncryptedDEK, kek) {
		t.Fatalf("encrypted DEK contains the KEK — wrap broken")
	}

	got, err := svc.Decrypt(context.Background(), DecryptRequest{
		EnvelopeID: res.Envelope.ID,
		OwnerType:  model.OwnerCredentialSecret,
		OwnerID:    1234,
	})
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("round-trip mismatch: got %q want %q", got, plain)
	}
}

// TestEnvelopeAADRejection ensures that opening an envelope with the
// wrong owner_id fails — the AAD verifies the binding before the KMS
// is ever called.
func TestEnvelopeAADRejection(t *testing.T) {
	db := newTestDB(t)
	providers := repo.NewKMSProviderRepo(db)
	envelopes := repo.NewSecretEnvelopeRepo(db)
	audits := repo.NewSecretAuditRepo(db)

	kek := make([]byte, 32)
	primary, _ := kms.NewLocal("aad", "primary", kek)
	row := &model.KMSProvider{Name: "aad", Kind: model.KMSKindLocal, KeyID: "primary", IsPrimary: true, Enabled: true}
	_ = providers.Create(context.Background(), row)
	svc := NewService(Deps{Envelopes: envelopes, Providers: providers, Audits: audits, Primary: primary, PrimaryRow: row})

	res, err := svc.Encrypt(context.Background(), EncryptRequest{
		OwnerType: model.OwnerCredentialSecret,
		OwnerID:   1,
		Plaintext: []byte("xx"),
	})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	_, err = svc.Decrypt(context.Background(), DecryptRequest{
		EnvelopeID: res.Envelope.ID,
		OwnerType:  model.OwnerCredentialSecret,
		OwnerID:    2, // wrong
	})
	if err == nil {
		t.Fatalf("expected owner-mismatch error, got nil")
	}
}

// TestEnvelopeVaultPointerFormat asserts the pkg/crypto.Vault adapter
// returns + accepts pointer-format byte slices, so callers can continue
// to store the result in their existing []byte column.
func TestEnvelopeVaultPointerFormat(t *testing.T) {
	db := newTestDB(t)
	providers := repo.NewKMSProviderRepo(db)
	envelopes := repo.NewSecretEnvelopeRepo(db)
	audits := repo.NewSecretAuditRepo(db)

	kek := make([]byte, 32)
	primary, _ := kms.NewLocal("v", "primary", kek)
	row := &model.KMSProvider{Name: "v", Kind: model.KMSKindLocal, KeyID: "primary", IsPrimary: true, Enabled: true}
	_ = providers.Create(context.Background(), row)
	svc := NewService(Deps{Envelopes: envelopes, Providers: providers, Audits: audits, Primary: primary, PrimaryRow: row})

	v := NewEnvelopeVault(svc, model.OwnerCredentialSecret)
	plain := []byte("token-abc-def")
	pointer, err := v.Seal(plain)
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if envID, ok := DecodePointer(pointer); !ok || envID == 0 {
		t.Fatalf("pointer not decodable: %x", pointer)
	}
	got, err := v.Open(pointer)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("round-trip via vault adapter: got %q want %q", got, plain)
	}
}

// TestEnvelopeVaultLegacyFallback verifies the EnvelopeVault still
// reads legacy pkgcrypto.Sealer ciphertexts when AttachLegacy is
// wired — the one-shot migration path.
func TestEnvelopeVaultLegacyFallback(t *testing.T) {
	db := newTestDB(t)
	providers := repo.NewKMSProviderRepo(db)
	envelopes := repo.NewSecretEnvelopeRepo(db)
	audits := repo.NewSecretAuditRepo(db)

	kek := make([]byte, 32)
	primary, _ := kms.NewLocal("v", "primary", kek)
	row := &model.KMSProvider{Name: "v", Kind: model.KMSKindLocal, KeyID: "primary", IsPrimary: true, Enabled: true}
	_ = providers.Create(context.Background(), row)
	svc := NewService(Deps{Envelopes: envelopes, Providers: providers, Audits: audits, Primary: primary, PrimaryRow: row})

	// Mint a legacy ciphertext with the old fixed-key Sealer.
	legacy, err := pkgcrypto.NewSealer("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	if err != nil {
		t.Fatalf("legacy sealer: %v", err)
	}
	plain := []byte("pre-phase14-row")
	legacyCT, _ := legacy.Seal(plain)

	// Without legacy attached, opening the legacy CT must error.
	v := NewEnvelopeVault(svc, model.OwnerCredentialSecret)
	if _, err := v.Open(legacyCT); err == nil {
		t.Fatalf("expected error opening legacy CT without legacy sealer attached")
	}

	// Attach the legacy reader; same CT now opens.
	v.AttachLegacy(legacy)
	got, err := v.Open(legacyCT)
	if err != nil {
		t.Fatalf("legacy open: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("legacy round-trip: got %q want %q", got, plain)
	}
}

// TestKMSLocalRoundTrip is a direct KMS-layer round-trip without the
// envelope service in between — verifies the Local KMS provider on
// its own.
func TestKMSLocalRoundTrip(t *testing.T) {
	kek := make([]byte, 32)
	for i := range kek {
		kek[i] = byte(i * 7)
	}
	local, err := kms.NewLocal("t", "primary", kek)
	if err != nil {
		t.Fatalf("new local: %v", err)
	}
	dek, _ := pkgcrypto.GenerateDEK()
	wrapped, err := local.EncryptDEK(context.Background(), dek, map[string]string{"x": "y"})
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	unwrapped, err := local.DecryptDEK(context.Background(), wrapped.Ciphertext, wrapped.KeyID, wrapped.KeyVersion, map[string]string{"x": "y"})
	if err != nil {
		t.Fatalf("decrypt: %v", err)
	}
	if !bytes.Equal(unwrapped, dek) {
		t.Fatalf("DEK round-trip mismatch")
	}
	// Wrong AAD must reject.
	_, err = local.DecryptDEK(context.Background(), wrapped.Ciphertext, wrapped.KeyID, wrapped.KeyVersion, map[string]string{"x": "z"})
	if err == nil {
		t.Fatalf("expected AAD mismatch to reject; got nil")
	}
}

// TestBootstrap_FreshInstall exercises the full bootstrap path on a
// brand-new install: passphrase file is minted, seal material is
// initialised, a Local primary provider is created, and the
// healthcheck passes.
func TestBootstrap_FreshInstall(t *testing.T) {
	db := newTestDB(t)
	dir := t.TempDir()
	unsealPath := filepath.Join(dir, "keystore.unseal")
	deps := BootstrapDeps{
		SealRepo:       repo.NewKMSSealRepo(db),
		ProviderRepo:   repo.NewKMSProviderRepo(db),
		EnvelopeRepo:   repo.NewSecretEnvelopeRepo(db),
		AuditRepo:      repo.NewSecretAuditRepo(db),
		Logger:         zap.NewNop(),
		UnsealFilePath: unsealPath,
	}
	res, err := Bootstrap(context.Background(), deps)
	if err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	if !res.FreshInstall {
		t.Fatalf("expected FreshInstall=true on first boot")
	}
	if res.PrimaryRow == nil || res.PrimaryRow.Kind != model.KMSKindLocal {
		t.Fatalf("expected default Local primary, got %+v", res.PrimaryRow)
	}

	// Round-trip through the bootstrapped service to confirm
	// nothing dangles.
	v := res.NewVaultFor(model.OwnerCredentialSecret)
	ct, err := v.Seal([]byte("hello"))
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	got, err := v.Open(ct)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if string(got) != "hello" {
		t.Fatalf("round-trip via bootstrapped vault: got %q", got)
	}

	// Boot again with the same passphrase file + DB — must not
	// re-mint the seal material.
	res2, err := Bootstrap(context.Background(), deps)
	if err != nil {
		t.Fatalf("rebootstrap: %v", err)
	}
	if res2.FreshInstall {
		t.Fatalf("expected FreshInstall=false on second boot")
	}
}
