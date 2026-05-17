package tcpfwd

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"go.uber.org/zap"
)

type directDialer struct{}

func (directDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, network, addr)
}

func TestForwarderEndToEnd(t *testing.T) {
	// Stand up an echo server that the forwarder will tunnel to.
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
	f, err := Start(ctx, "127.0.0.1", [2]int{0, 0}, directDialer{}, echo.Addr().String(), zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()

	conn, err := net.Dial("tcp", f.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 2)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "hi" {
		t.Fatalf("want hi got %s", buf)
	}
}
