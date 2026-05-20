package kms

import (
	"os"
	"strings"
)

// readFileTrim reads a small file (a few hundred bytes max — JWTs,
// passphrases) and returns the bytes with leading/trailing whitespace
// stripped. Used by the Kubernetes-auth path and the unseal flow.
func readFileTrim(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}
