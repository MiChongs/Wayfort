package dialer

import (
	"crypto/tls"
	"net/http"
	"net/url"
	"time"

	"github.com/wzshiming/httpproxy"
	"golang.org/x/net/proxy"
)

// NewHTTPConnect wraps the upstream ContextDialer so connections traverse an
// HTTP CONNECT proxy. It supports proxy-side TLS (https:// CONNECT endpoint with
// optional SNI override / skip-verify), basic proxy authentication, and extra
// CONNECT request headers. This replaces the previously-declared-but-unwired
// http_connect kind that errored at runtime.
func NewHTTPConnect(addr, user, pass string, tlsToProxy bool, sni string, insecure bool, hdr http.Header, timeout time.Duration, upstream proxy.ContextDialer) (proxy.ContextDialer, error) {
	scheme := "http"
	if tlsToProxy {
		scheme = "https"
	}
	d, err := httpproxy.NewDialer(scheme + "://" + addr)
	if err != nil {
		return nil, err
	}
	d.ProxyDial = upstream.DialContext
	d.Timeout = timeout
	if tlsToProxy {
		d.TLSClientConfig = &tls.Config{ServerName: sni, InsecureSkipVerify: insecure} //nolint:gosec // operator-opt-in lab flag
	}
	if user != "" {
		d.Userinfo = url.UserPassword(user, pass)
	}
	if len(hdr) > 0 {
		d.ProxyHeader = hdr
	}
	return d, nil
}
