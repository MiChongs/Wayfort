package guacamole

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"go.uber.org/zap"
	"golang.org/x/net/proxy"
)

// directDialer is a minimal proxy.ContextDialer used as the listener's upstream
// in tests so we don't have to spin up the full ChainBuilder.
type directDialer struct{}

func (directDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, network, addr)
}

func TestSocksListenerProxiesConnect(t *testing.T) {
	// Echo server that the SOCKS5 listener will forward to.
	echo, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer echo.Close()
	go func() {
		for {
			c, err := echo.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) { _, _ = io.Copy(c, c); c.Close() }(c)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	listener, err := New(ctx, "127.0.0.1", directDialer{}, echo.Addr().String(), zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	d, err := proxy.SOCKS5("tcp", listener.Addr().String(), nil, proxy.Direct)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := d.Dial("tcp", echo.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "ping" {
		t.Fatalf("want ping got %s", buf)
	}
}
