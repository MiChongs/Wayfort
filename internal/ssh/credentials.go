package ssh

import (
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	pkgcrypto "github.com/michongs/jumpserver-anonymous/pkg/crypto"
	xssh "golang.org/x/crypto/ssh"
)

// Resolver decrypts a Credential row into ssh.AuthMethods.
type Resolver struct{ sealer pkgcrypto.Vault }

func NewResolver(s pkgcrypto.Vault) *Resolver { return &Resolver{sealer: s} }

func (r *Resolver) AuthMethods(c *model.Credential) ([]xssh.AuthMethod, error) {
	if c == nil {
		return nil, fmt.Errorf("nil credential")
	}
	secret, err := r.sealer.Open(c.Secret)
	if err != nil {
		return nil, fmt.Errorf("decrypt secret: %w", err)
	}
	switch c.Kind {
	case model.CredentialPassword:
		return []xssh.AuthMethod{xssh.Password(string(secret))}, nil
	case model.CredentialPrivateKey:
		var signer xssh.Signer
		if len(c.Passphrase) > 0 {
			pass, err := r.sealer.Open(c.Passphrase)
			if err != nil {
				return nil, fmt.Errorf("decrypt passphrase: %w", err)
			}
			signer, err = xssh.ParsePrivateKeyWithPassphrase(secret, pass)
			if err != nil {
				return nil, fmt.Errorf("parse encrypted key: %w", err)
			}
		} else {
			signer, err = xssh.ParsePrivateKey(secret)
			if err != nil {
				return nil, fmt.Errorf("parse key: %w", err)
			}
		}
		return []xssh.AuthMethod{xssh.PublicKeys(signer)}, nil
	case model.CredentialAgent:
		return nil, fmt.Errorf("agent auth not implemented in this MVP")
	default:
		return nil, fmt.Errorf("unknown credential kind %q", c.Kind)
	}
}

// PreferredUser returns the username on the credential, falling back to the
// override (typically Node.Username).
func PreferredUser(c *model.Credential, override string) string {
	if override != "" {
		return override
	}
	if c != nil {
		return c.Username
	}
	return ""
}
