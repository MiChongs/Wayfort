package secrets

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"fmt"
	"sort"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// AAD construction
// ----------------
// Every envelope binds its ciphertext to an Additional Authenticated
// Data string that names the *business owner*. The AEAD verifies AAD
// at decrypt time, so a ciphertext smuggled into a different row
// (different owner_id, different version, different table) fails open.
//
// Canonical AAD layout is:
//
//   "jumpserver.envelope|owner_type|owner_id|version|extra_k1=v1|extra_k2=v2…"
//
// where extra_k=v pairs come from the caller's per-Seal context map
// (used by multi-tenant deployments to bind on tenant_id, by the SSH
// session path to bind on session_id, etc.) and are sorted
// lexicographically so encrypt + decrypt agree.
//
// We store sha256(AAD) on the row instead of the AAD bytes themselves
// — the AAD can be very long (tenant + session + correlation IDs) and
// 32 bytes is enough to verify the binding matches at decrypt time.

// AADInput holds the inputs needed to build a canonical AAD. Used by
// both Encrypt and Decrypt; reusing the same struct keeps the two
// sides honest.
type AADInput struct {
	OwnerType model.SecretEnvelopeOwnerType
	OwnerID   uint64
	Version   int
	Extra     map[string]string
}

// Build computes the canonical AAD bytes.
func (a AADInput) Build() []byte {
	var b strings.Builder
	b.WriteString("jumpserver.envelope")
	b.WriteByte('|')
	b.WriteString(string(a.OwnerType))
	b.WriteByte('|')
	b.WriteString(formatUint(a.OwnerID))
	b.WriteByte('|')
	b.WriteString(formatUint(uint64(a.Version)))
	if len(a.Extra) > 0 {
		keys := make([]string, 0, len(a.Extra))
		for k := range a.Extra {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			b.WriteByte('|')
			b.WriteString(k)
			b.WriteByte('=')
			b.WriteString(a.Extra[k])
		}
	}
	return []byte(b.String())
}

// Hash returns sha256(Build()).
func (a AADInput) Hash() []byte {
	sum := sha256.Sum256(a.Build())
	return sum[:]
}

// Verify constant-time compares the hash on the envelope row against
// what we derive from the supplied AAD inputs. A mismatch means
// either:
//
//   - the envelope was tampered with at the DB layer (different
//     owner_id swapped in to point at someone else's wrapped DEK), or
//   - the caller built the wrong AAD (a bug — Encrypt and Decrypt
//     must use the same input set)
//
// Either way Decrypt refuses to talk to the KMS.
func Verify(input AADInput, stored []byte) error {
	got := input.Hash()
	if subtle.ConstantTimeCompare(got, stored) != 1 {
		return fmt.Errorf("secrets: AAD mismatch — envelope binding rejected")
	}
	return nil
}

// EncryptionContextFor returns the {k:v} context map handed to the KMS
// at encrypt time. The same map is required at decrypt time for KMS
// providers that support EncryptionContext natively (Vault, AWS, GCP).
//
// We pin owner_type + owner_id + version + the caller's extras; same
// inputs as the AAD itself. Sorted serialisation happens inside the
// KMS provider.
func EncryptionContextFor(input AADInput) map[string]string {
	ec := map[string]string{
		"jumpserver.envelope.owner_type": string(input.OwnerType),
		"jumpserver.envelope.owner_id":   formatUint(input.OwnerID),
		"jumpserver.envelope.version":    formatUint(uint64(input.Version)),
	}
	for k, v := range input.Extra {
		ec["x."+k] = v
	}
	return ec
}

// formatUint avoids strconv.FormatUint's import on every AAD build,
// which would dominate the hot decrypt path's allocation profile.
func formatUint(v uint64) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}

// Pointer is the bytes-on-the-row format used by EnvelopeVault to
// reference a SecretEnvelope row from the legacy `Secret []byte`
// column on Credential, OIDCClient, AIProvider, etc. Layout:
//
//   [4-byte magic "ENV1"] [8-byte big-endian envelope ID]
//
// 12 bytes total. Distinct enough from legacy AES-GCM blobs (which
// start with a 12-byte random nonce, statistically never collide with
// the magic prefix) that EnvelopeVault.Open can detect the difference
// and route to the right unwrap path.
const pointerMagic = "ENV1"
const pointerLen = 4 + 8

// EncodePointer wraps the envelope ID for storage in the legacy
// `Secret []byte` column.
func EncodePointer(envelopeID uint64) []byte {
	out := make([]byte, pointerLen)
	copy(out[:4], pointerMagic)
	binary.BigEndian.PutUint64(out[4:], envelopeID)
	return out
}

// DecodePointer is the inverse of EncodePointer. Returns (0, false)
// if the input is not in pointer format — callers fall back to the
// legacy Sealer path in that case.
func DecodePointer(b []byte) (uint64, bool) {
	if len(b) != pointerLen {
		return 0, false
	}
	if string(b[:4]) != pointerMagic {
		return 0, false
	}
	return binary.BigEndian.Uint64(b[4:]), true
}
