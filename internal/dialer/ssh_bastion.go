package dialer

import (
	"context"
	"net"

	"golang.org/x/crypto/ssh"
	"golang.org/x/net/proxy"
)

// BastionDialer wraps a connected *ssh.Client so callers can use it as a
// ContextDialer. The next-hop TCP connection is opened through the bastion's
// SSH channel via DialContext.
type BastionDialer struct{ Client *ssh.Client }

var _ proxy.ContextDialer = (*BastionDialer)(nil)

func (b *BastionDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	return b.Client.DialContext(ctx, network, addr)
}
