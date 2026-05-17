package telnet

import (
	"context"
	"io"
	"net"
	"testing"
	"time"

	"golang.org/x/net/proxy"
)

type directDialer struct{}

func (directDialer) DialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	return (&net.Dialer{}).DialContext(ctx, network, addr)
}

func TestTelnetBackendEcho(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		_, _ = io.Copy(c, c)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port := 0
	for _, ch := range portStr {
		port = port*10 + int(ch-'0')
	}
	var d proxy.ContextDialer = directDialer{}
	b, err := Dial(ctx, d, host, port)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if _, err := b.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 5)
	if _, err := io.ReadFull(b, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "hello" {
		t.Fatalf("want hello got %s", buf)
	}
}
