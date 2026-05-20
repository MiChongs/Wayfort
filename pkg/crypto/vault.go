package crypto

// Vault is the byte-in / byte-out shim consumers use to seal and open
// arbitrary credential material. Phase 14 split it out of the concrete
// *Sealer type so the implementation can be swapped between:
//
//   - the legacy fixed-key Sealer (still here for the one-shot migration
//     of pre-Phase-14 ciphertexts), and
//
//   - the envelope-encryption vault in internal/secrets, which delegates
//     KEK custody to Vault Transit / OpenBao / AWS / Azure / GCP KMS
//     and persists per-row metadata to the secret_envelopes table.
//
// Both implementations honour the same contract: Seal(plain) → opaque,
// Open(opaque) → plain. Owner-context AAD binding happens inside the
// envelope vault via a per-Seal context the legacy Sealer cannot see;
// the interface stays narrow on purpose so refactoring 29 call sites is
// mechanical.
type Vault interface {
	Seal(plain []byte) ([]byte, error)
	Open(sealed []byte) ([]byte, error)
}

// Compile-time assertion that the legacy *Sealer still satisfies Vault.
// Removing this line if Sealer is deleted later is intentional.
var _ Vault = (*Sealer)(nil)
