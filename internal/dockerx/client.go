// Package dockerx centralises construction of the local Docker Engine SDK
// client.
//
// The SDK requests its compiled-in API version by default (v1.47 for this
// module). Docker Desktop's Windows named-pipe proxy answers a too-new version
// with an empty-body HTTP 500 — surfaced by the SDK as "request returned
// Internal Server Error for API route and version …, check if the server
// supports the requested API version" — rather than a clean downgrade hint.
// The SDK's lazy version negotiation normally caps the request down to the
// daemon's maximum, but it is skipped entirely when DOCKER_API_VERSION pins a
// version, and it only runs on the first request.
//
// NewClient pings the daemon up front and, if the version we would request
// exceeds what the daemon supports, re-pins the client to the daemon's maximum.
// Older API versions always work against a newer daemon, so capping down is
// safe; this makes the client robust across Docker Desktop versions and against
// a stale DOCKER_API_VERSION override.
package dockerx

import (
	"context"
	"os"
	"time"

	"github.com/docker/docker/api"
	"github.com/docker/docker/api/types/versions"
	dclient "github.com/docker/docker/client"
)

// pingTimeout bounds the up-front daemon probe so a misbehaving (but reachable)
// pipe can't stall startup. A missing daemon fails fast on its own.
const pingTimeout = 5 * time.Second

// NewClient builds a Docker Engine API client whose negotiated API version is
// guaranteed not to exceed the daemon's maximum supported version. If the
// daemon is unreachable at construction time, the returned client still has
// lazy negotiation enabled and will settle its version on the first real call.
func NewClient() (*dclient.Client, error) {
	cli, err := dclient.NewClientWithOpts(dclient.FromEnv, dclient.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}

	// The version this client would otherwise request: an explicit
	// DOCKER_API_VERSION override, or the SDK default.
	want := os.Getenv("DOCKER_API_VERSION")
	if want == "" {
		want = api.DefaultVersion
	}

	ctx, cancel := context.WithTimeout(context.Background(), pingTimeout)
	defer cancel()
	ping, perr := cli.Ping(ctx)
	if perr != nil || ping.APIVersion == "" || !versions.LessThan(ping.APIVersion, want) {
		// Daemon unreachable now (lazy negotiation retries on real calls),
		// reported no version, or already supports `want` — nothing to cap.
		return cli, nil
	}

	// Daemon caps below what we'd request. Re-pin explicitly so every request
	// targets a supported version, even when DOCKER_API_VERSION forced a too-new
	// one (which disables the SDK's own negotiation). FromEnv stays first so
	// host/TLS settings are preserved; WithVersion overrides the version only.
	pinned, perr := dclient.NewClientWithOpts(dclient.FromEnv, dclient.WithVersion(ping.APIVersion))
	if perr != nil {
		return cli, nil
	}
	_ = cli.Close()
	return pinned, nil
}
