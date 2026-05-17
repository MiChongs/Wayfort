package ssh

import (
	"context"
	"crypto/sha256"
	"fmt"

	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	xssh "golang.org/x/crypto/ssh"
)

// PoolCredentialProvider satisfies sshpool.CredentialProvider by looking up the
// proxy's credential, decrypting it via Resolver, and returning a fingerprint
// for the pool key (so credential rotation creates a fresh pool entry).
type PoolCredentialProvider struct {
	Creds    *repo.CredentialRepo
	Resolver *Resolver
}

func (p *PoolCredentialProvider) ForProxy(ctx context.Context, proxy *model.Proxy) (string, []xssh.AuthMethod, []byte, error) {
	if proxy.CredentialID == nil {
		return "", nil, nil, fmt.Errorf("bastion proxy %s has no credential", proxy.Name)
	}
	cred, err := p.Creds.FindByID(ctx, *proxy.CredentialID)
	if err != nil {
		return "", nil, nil, err
	}
	if cred == nil {
		return "", nil, nil, fmt.Errorf("credential %d not found", *proxy.CredentialID)
	}
	methods, err := p.Resolver.AuthMethods(cred)
	if err != nil {
		return "", nil, nil, err
	}
	h := sha256.New()
	h.Write([]byte(cred.Kind))
	h.Write(cred.Secret)
	h.Write(cred.Passphrase)
	user := PreferredUser(cred, "")
	if user == "" {
		return "", nil, nil, fmt.Errorf("credential %d has no username", cred.ID)
	}
	return user, methods, h.Sum(nil), nil
}

// SOCKS5CredentialResolver implements dialer.CredentialResolver.
type SOCKS5CredentialResolver struct {
	Creds    *repo.CredentialRepo
	Resolver *Resolver
}

func (s *SOCKS5CredentialResolver) UserPassByCredentialID(ctx context.Context, id uint64) (string, string, error) {
	cred, err := s.Creds.FindByID(ctx, id)
	if err != nil {
		return "", "", err
	}
	if cred == nil {
		return "", "", fmt.Errorf("credential %d not found", id)
	}
	if cred.Kind != model.CredentialPassword {
		return "", "", fmt.Errorf("socks5 credential must be password kind")
	}
	pw, err := s.Resolver.sealer.Open(cred.Secret)
	if err != nil {
		return "", "", err
	}
	return cred.Username, string(pw), nil
}
