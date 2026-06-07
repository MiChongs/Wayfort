package oss

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// dialFunc matches both net.Dialer.DialContext and proxy.ContextDialer.DialContext.
type dialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// Open builds an ObjectStore for the given options + AccessKey pair, wired to
// the supplied proxy-aware http.Client. Dispatch is by provider.
func Open(ctx context.Context, opts Options, accessKeyID, secretKey string, httpClient *http.Client) (ObjectStore, error) {
	if accessKeyID == "" || secretKey == "" {
		return nil, fmt.Errorf("missing AccessKey credential")
	}
	switch opts.Provider {
	case ProviderAliyun:
		return newAliyunStore(opts, accessKeyID, secretKey, httpClient)
	case ProviderTencent:
		return newTencentStore(opts, accessKeyID, secretKey, httpClient)
	case ProviderS3, "":
		return newS3Store(opts, accessKeyID, secretKey, httpClient)
	default:
		return nil, fmt.Errorf("unsupported OSS provider %q", opts.Provider)
	}
}

// buildHTTPClient wraps a proxy-chain dialer in an http.Client suitable for the
// object-storage SDKs. No global timeout (downloads/uploads stream); per-phase
// timeouts guard the handshake.
func buildHTTPClient(dial dialFunc, insecureTLS bool) *http.Client {
	tr := &http.Transport{
		DialContext:           dial,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          50,
		MaxIdleConnsPerHost:   10,
		IdleConnTimeout:       60 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
	}
	if insecureTLS {
		tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // operator-opt-in for self-signed on-prem endpoints
	}
	return &http.Client{Transport: tr}
}

// ensureScheme prepends https:// when an endpoint has no scheme. Aliyun
// endpoints are bare hosts (oss-cn-hangzhou.aliyuncs.com); S3/MinIO may include
// a scheme.
func ensureScheme(endpoint string) string {
	endpoint = strings.TrimSpace(endpoint)
	if endpoint == "" {
		return ""
	}
	if strings.HasPrefix(endpoint, "http://") || strings.HasPrefix(endpoint, "https://") {
		return endpoint
	}
	return "https://" + endpoint
}

// metaFromHeader builds ObjectMeta from a HEAD/GET response header (used by the
// Aliyun and Tencent adapters, whose SDKs return raw http.Header for metadata).
func metaFromHeader(key string, h http.Header) *ObjectMeta {
	m := &ObjectMeta{
		Key:         key,
		ContentType: h.Get("Content-Type"),
		ETag:        strings.Trim(h.Get("ETag"), `"`),
	}
	if cl := h.Get("Content-Length"); cl != "" {
		if n, err := strconv.ParseInt(cl, 10, 64); err == nil {
			m.Size = n
		}
	}
	if lm := h.Get("Last-Modified"); lm != "" {
		if t, err := http.ParseTime(lm); err == nil {
			m.LastModified = t
		}
	}
	if sc := h.Get("x-oss-storage-class"); sc != "" {
		m.StorageClass = sc
	} else if sc := h.Get("x-cos-storage-class"); sc != "" {
		m.StorageClass = sc
	}
	return m
}

// baseName returns the last path segment of an object key (folder-aware: the
// trailing "/" of a folder key is stripped first).
func baseName(key string) string {
	k := strings.TrimSuffix(key, "/")
	if i := strings.LastIndex(k, "/"); i >= 0 {
		return k[i+1:]
	}
	return k
}
