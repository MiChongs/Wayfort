package ssh

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"

	xssh "golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// HostKeyChecker is a thread-safe known_hosts wrapper that supports
// trust-on-first-use: an unknown host is appended to the file and accepted.
// For production multi-tenant use, callers should supply Strict=true.
type HostKeyChecker struct {
	mu       sync.Mutex
	path     string
	strict   bool
	callback xssh.HostKeyCallback
}

func NewHostKeyChecker(path string, strict bool) (*HostKeyChecker, error) {
	if path == "" {
		home, _ := os.UserHomeDir()
		path = filepath.Join(home, ".ssh", "known_hosts")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	_ = f.Close()
	cb, err := knownhosts.New(path)
	if err != nil {
		return nil, fmt.Errorf("load known_hosts: %w", err)
	}
	return &HostKeyChecker{path: path, strict: strict, callback: cb}, nil
}

func (c *HostKeyChecker) Callback() xssh.HostKeyCallback {
	return func(hostname string, remote net.Addr, key xssh.PublicKey) error {
		c.mu.Lock()
		defer c.mu.Unlock()
		err := c.callback(hostname, remote, key)
		if err == nil {
			return nil
		}
		var kerr *knownhosts.KeyError
		if errors.As(err, &kerr) && len(kerr.Want) == 0 && !c.strict {
			// Unknown host: trust on first use.
			line := knownhosts.Line([]string{knownhosts.Normalize(hostname)}, key)
			f, ferr := os.OpenFile(c.path, os.O_APPEND|os.O_WRONLY, 0o600)
			if ferr != nil {
				return ferr
			}
			defer f.Close()
			if _, werr := f.WriteString(line + "\n"); werr != nil {
				return werr
			}
			cb, rerr := knownhosts.New(c.path)
			if rerr != nil {
				return rerr
			}
			c.callback = cb
			return nil
		}
		return err
	}
}
