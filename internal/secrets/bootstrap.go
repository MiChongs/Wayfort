package secrets

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	"github.com/michongs/jumpserver-anonymous/pkg/kms"
	"go.uber.org/zap"
)

// Bootstrap wires the envelope-encryption layer at gateway start-up.
//
// On the first call ever (clean install) the flow is:
//
//   1. Read the unseal passphrase from `cfg.UnsealPassphraseFile`.
//      If the file is missing, mint a fresh one with a random 32-byte
//      passphrase and write it 0600 next to the DB. Log a one-line
//      banner so the operator can grab the passphrase from the file
//      and move it to wherever they keep their bootstrap secrets.
//   2. Argon2id-derive an unsealer key from passphrase + a fresh
//      salt; persist (salt, verifier) to kms_seal_material.
//   3. Mint a fresh 32-byte KEK, seal it with the unsealer, and
//      persist a Local KMSProvider row marked primary with the
//      sealed KEK in AuthCiphertext.
//   4. Hand back a Service whose primary is that Local KMS, plus an
//      EnvelopeVault per OwnerType the rest of the gateway needs.
//
// On every subsequent boot the flow is the same minus step 1's
// passphrase generation and step 2's row creation: we read the
// passphrase, verify against the stored verifier, re-derive the
// unsealer, and look up the existing primary KMSProvider.
//
// Sealed mode
// -----------
// If the unseal passphrase file is missing AND the operator
// explicitly asks for it (CLI flag, future), the gateway enters
// "sealed mode" where credential operations refuse to talk to the
// KMS until /api/v1/setup/seal supplies the passphrase. This Bootstrap
// function does NOT enter sealed mode on its own — operators who
// want it set `--sealed` and a different code path runs.
func Bootstrap(ctx context.Context, deps BootstrapDeps) (*BootstrapResult, error) {
	if deps.SealRepo == nil || deps.ProviderRepo == nil || deps.EnvelopeRepo == nil || deps.AuditRepo == nil {
		return nil, errors.New("secrets.Bootstrap: nil repos in deps")
	}
	if deps.Logger == nil {
		return nil, errors.New("secrets.Bootstrap: nil logger")
	}
	if deps.UnsealFilePath == "" {
		deps.UnsealFilePath = "./var/keystore.unseal"
	}

	// Step 1: passphrase.
	passphrase, freshlyMinted, err := readOrMintPassphrase(deps.UnsealFilePath, deps.Logger)
	if err != nil {
		return nil, fmt.Errorf("bootstrap: passphrase: %w", err)
	}

	// Step 2: seal material.
	sealRow, err := deps.SealRepo.Get(ctx)
	if err != nil {
		return nil, fmt.Errorf("bootstrap: load seal material: %w", err)
	}
	var unsealer *kms.Unsealer
	if sealRow == nil {
		// First boot — mint salt + verifier.
		salt, verifier, err := kms.NewSeal(passphrase)
		if err != nil {
			return nil, fmt.Errorf("bootstrap: mint seal: %w", err)
		}
		if err := deps.SealRepo.Initialise(ctx, salt, verifier); err != nil {
			return nil, fmt.Errorf("bootstrap: persist seal: %w", err)
		}
		unsealer = kms.DeriveUnsealer(passphrase, salt)
		deps.Logger.Info("secrets bootstrap: minted fresh seal material",
			zap.Bool("fresh_passphrase", freshlyMinted),
			zap.String("unseal_file", deps.UnsealFilePath))
	} else {
		// Subsequent boot — verify + re-derive.
		if err := kms.Verify(passphrase, sealRow.Salt, sealRow.Verifier); err != nil {
			return nil, fmt.Errorf("bootstrap: %w (check %s)", err, deps.UnsealFilePath)
		}
		unsealer = kms.DeriveUnsealer(passphrase, sealRow.Salt)
		_ = deps.SealRepo.TouchUnseal(ctx)
	}

	// Step 3: primary KMS provider.
	providerRow, primary, err := ensurePrimary(ctx, deps, unsealer)
	if err != nil {
		return nil, err
	}

	// Step 4: assemble the service + per-owner adapters.
	svc := NewService(Deps{
		Envelopes:  deps.EnvelopeRepo,
		Providers:  deps.ProviderRepo,
		Audits:     deps.AuditRepo,
		Unsealer:   unsealer,
		Primary:    primary,
		PrimaryRow: providerRow,
	})

	return &BootstrapResult{
		Service:        svc,
		Unsealer:       unsealer,
		PrimaryKMS:     primary,
		PrimaryRow:     providerRow,
		PassphraseFile: deps.UnsealFilePath,
		FreshInstall:   freshlyMinted,
	}, nil
}

// BootstrapDeps groups what Bootstrap needs from the wire-up code.
type BootstrapDeps struct {
	SealRepo       *repo.KMSSealRepo
	ProviderRepo   *repo.KMSProviderRepo
	EnvelopeRepo   *repo.SecretEnvelopeRepo
	AuditRepo      *repo.SecretAuditRepo
	Logger         *zap.Logger
	UnsealFilePath string
}

// BootstrapResult is the wire-up output.
type BootstrapResult struct {
	Service        *Service
	Unsealer       *kms.Unsealer
	PrimaryKMS     kms.KMS
	PrimaryRow     *model.KMSProvider
	PassphraseFile string
	FreshInstall   bool
}

// NewVaultFor returns a pkg/crypto.Vault for the given owner type,
// backed by the bootstrapped Service. Each call site (credential,
// MFA, OIDC, AI) makes one of these.
func (br *BootstrapResult) NewVaultFor(ownerType model.SecretEnvelopeOwnerType) pkgcrypto.Vault {
	return NewEnvelopeVault(br.Service, ownerType)
}

// readOrMintPassphrase reads `path` (which holds a single line) or
// creates it on first run with a 32-byte hex passphrase. The file is
// always written with mode 0600.
func readOrMintPassphrase(path string, logger *zap.Logger) ([]byte, bool, error) {
	clean := filepath.Clean(path)
	if b, err := os.ReadFile(clean); err == nil {
		pp := []byte(strings.TrimSpace(string(b)))
		if len(pp) < 16 {
			return nil, false, fmt.Errorf("passphrase file %s has fewer than 16 bytes after trimming whitespace", clean)
		}
		return pp, false, nil
	} else if !os.IsNotExist(err) {
		return nil, false, fmt.Errorf("read passphrase file %s: %w", clean, err)
	}

	// Generate a fresh passphrase. 32 random bytes → 64 hex chars.
	raw, err := pkgcrypto.RandomBytes(32)
	if err != nil {
		return nil, false, fmt.Errorf("generate passphrase: %w", err)
	}
	hexPp := []byte(hexEncode(raw))
	if err := os.MkdirAll(filepath.Dir(clean), 0o700); err != nil {
		return nil, false, fmt.Errorf("mkdir for passphrase: %w", err)
	}
	if err := writeFile0600(clean, append(hexPp, '\n')); err != nil {
		return nil, false, fmt.Errorf("write passphrase file %s: %w", clean, err)
	}
	logger.Warn("secrets bootstrap: minted fresh unseal passphrase",
		zap.String("file", clean),
		zap.String("guidance", "treat this file like an SSH private key; back it up out-of-band before the next reboot"))
	return hexPp, true, nil
}

// ensurePrimary loads the primary KMSProvider, or creates a default
// Local provider on first boot. Returns the row + the resolved KMS
// instance.
func ensurePrimary(ctx context.Context, deps BootstrapDeps, unsealer *kms.Unsealer) (*model.KMSProvider, kms.KMS, error) {
	row, err := deps.ProviderRepo.Primary(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("load primary kms provider: %w", err)
	}
	if row == nil {
		// First boot — create a Local provider with a fresh KEK.
		kek, err := pkgcrypto.RandomBytes(32)
		if err != nil {
			return nil, nil, fmt.Errorf("mint local KEK: %w", err)
		}
		sealed, err := unsealer.Seal(kek)
		if err != nil {
			return nil, nil, fmt.Errorf("seal local KEK: %w", err)
		}
		row = &model.KMSProvider{
			Name:           "default-local",
			Kind:           model.KMSKindLocal,
			DisplayName:    "Local (bootstrap)",
			Description:    "Auto-generated on first boot. Operators should migrate to a real KMS via /api/v1/setup/kms.",
			KeyID:          "primary",
			AuthMethod:     "",
			AuthCiphertext: sealed,
			IsPrimary:      true,
			Enabled:        true,
			CreatedAt:      time.Now().UTC(),
			UpdatedAt:      time.Now().UTC(),
		}
		if err := deps.ProviderRepo.Create(ctx, row); err != nil {
			return nil, nil, fmt.Errorf("persist local provider: %w", err)
		}
		deps.Logger.Warn("secrets bootstrap: provisioned default Local KMS provider",
			zap.String("guidance", "configure a real KMS via /api/v1/setup/kms and re-wrap envelopes"))
	}

	authPlain, err := unsealer.Open(row.AuthCiphertext)
	if err != nil {
		return nil, nil, fmt.Errorf("unseal primary kms auth: %w", err)
	}
	primary, err := kms.New(ctx, kms.ProviderRow{
		ID:            row.ID,
		Name:          row.Name,
		Kind:          kms.Kind(row.Kind),
		Endpoint:      row.Endpoint,
		KeyID:         row.KeyID,
		Namespace:     row.Namespace,
		AuthMethod:    row.AuthMethod,
		AuthRoleID:    row.AuthRoleID,
		AuthPlaintext: authPlain,
		ExtraJSON:     row.ExtraJSON,
	})
	if err != nil {
		return nil, nil, fmt.Errorf("construct primary kms (%s): %w", row.Kind, err)
	}
	if err := primary.Healthcheck(ctx); err != nil {
		return nil, nil, fmt.Errorf("primary kms healthcheck failed: %w", err)
	}
	return row, primary, nil
}

// hexEncode is a small alternative to fmt.Sprintf("%x", b) that avoids
// pulling fmt into bootstrap's hot path. Encodes one byte per two ASCII
// hex digits, lowercase.
func hexEncode(b []byte) string {
	const tbl = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, v := range b {
		out[i*2] = tbl[v>>4]
		out[i*2+1] = tbl[v&0x0f]
	}
	return string(out)
}

// writeFile0600 writes data to path with mode 0600, creating parent
// directories if needed. Cross-platform — on Windows the mode is
// best-effort (Windows ACLs are not POSIX) and the gateway logs a
// warning for operators.
func writeFile0600(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(data); err != nil {
		return err
	}
	return f.Sync()
}
