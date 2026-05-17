# JumpServer-Anonymous

Go-based web SSH jump server (跳板机) backend with multi-hop proxy chains,
SFTP file management, asciinema session recording, async audit logging,
JWT auth (OIDC-ready), and an anonymous Docker sandbox mode.

All hot paths are non-blocking: each WebSSH session runs three goroutines
(WS-reader → backend, backend → WS-writer, heartbeat) and feeds a separate
recorder/audit worker via bounded channels.

## Stack

- **Web**: `github.com/gin-gonic/gin`, `github.com/coder/websocket`
- **SSH**: `golang.org/x/crypto/ssh` (+ `knownhosts`), `golang.org/x/net/proxy` for SOCKS5, `github.com/pkg/sftp`
- **Sandbox**: `github.com/docker/docker/client` (ephemeral containers)
- **Persistence**: GORM + MySQL + Redis
- **Auth**: `github.com/golang-jwt/jwt/v5` with provider abstraction (local + OIDC stub)
- **Config / log**: `viper`, `zap`

## Quick start

```bash
# 1. Bring up dependencies (MySQL + Redis + a test sshd target on :2222).
docker compose -f deployments/docker-compose.yaml up -d mysql redis sshd-target

# 2. Copy config and start the server.
cp configs/config.example.yaml configs/config.yaml
go run ./cmd/jumpserver --config configs/config.yaml

# 3. Log in as the bootstrap admin (admin / admin from the example config).
curl -s -X POST localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}'
# -> {"access_token":"...","refresh_token":"...","expires_at":"..."}

export TOKEN=...

# 4. Register a credential for the test sshd container.
curl -s -X POST localhost:8080/api/v1/credentials \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"testuser-pwd","kind":"password","username":"testuser","secret":"testpass"}'

# 5. Register the node.
curl -s -X POST localhost:8080/api/v1/nodes \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"local","host":"127.0.0.1","port":2222,"username":"testuser","credential_id":1}'

# 6. Open a WebSSH session (xterm.js-compatible).
websocat "ws://localhost:8080/api/v1/ws/ssh/1?token=$TOKEN&cols=120&rows=32"
# Send: {"t":"input","d":"bHMK"}  (base64 of "ls\n")

# 7. Download the recording and replay.
curl -OJ "localhost:8080/api/v1/sessions/<id>/cast" -H "Authorization: Bearer $TOKEN"
asciinema play *.cast
```

## Multi-hop proxy chains

A node references a `proxy_chain` like `"3,1"` meaning *traverse proxy 3, then
proxy 1, then connect to the target*. Each `proxies` row is one of:

- `direct` — net.Dialer
- `socks5` — `golang.org/x/net/proxy.SOCKS5`
- `bastion` — pooled `*ssh.Client.DialContext`

All implement `golang.org/x/net/proxy.ContextDialer` so they compose
cleanly. Bastion clients are pooled per `(host, user, credential)` with a
`MaxSessions`-aware spin-up policy and a `ssh.Client.Wait()` watchdog.

## Anonymous Docker sandbox

When `anonymous.enabled: true` and a Docker socket is available:

```bash
TOKEN=$(curl -s -X POST localhost:8080/api/v1/auth/anonymous | jq -r .access_token)
websocat "ws://localhost:8080/api/v1/ws/ssh/anonymous?token=$TOKEN"
```

The server creates a fresh container per session with `--read-only`,
`tmpfs /tmp`, `--network none`, CPU/memory/pids limits, and reaps it via a
janitor goroutine that reconciles Docker labels against Redis TTL keys.

## Testing

```bash
go test ./...
```

`internal/audit/recorder_test.go` covers the asciinema header, output
roundtrip, resize events, and backpressure drop with the `lossy:N` marker.

## Endpoints

| Method  | Path                                | Auth          |
| ------- | ----------------------------------- | ------------- |
| POST    | `/api/v1/auth/login`                | public        |
| POST    | `/api/v1/auth/refresh`              | refresh token |
| POST    | `/api/v1/auth/anonymous`            | public        |
| CRUD    | `/api/v1/nodes`                     | admin         |
| CRUD    | `/api/v1/proxies`                   | admin         |
| CRUD    | `/api/v1/credentials`               | admin         |
| GET     | `/api/v1/sessions`                  | authed        |
| GET     | `/api/v1/sessions/:id/cast`         | authed        |
| GET     | `/api/v1/nodes/:id/sftp/ls`         | authed        |
| POST    | `/api/v1/nodes/:id/sftp/mkdir`      | authed        |
| DELETE  | `/api/v1/nodes/:id/sftp/rm`         | authed        |
| POST    | `/api/v1/nodes/:id/sftp/upload`     | authed        |
| GET     | `/api/v1/nodes/:id/sftp/download`   | authed        |
| WS      | `/api/v1/ws/ssh/:node_id`           | authed        |
| WS      | `/api/v1/ws/ssh/anonymous`          | anonymous JWT |

## Configuration

Every field has a default; only `db.dsn`, `auth.jwt_secret`, and
`crypto.master_key_hex` (32 random bytes hex-encoded) are required.
Environment overrides use the `JUMPSERVER_` prefix with `.` → `_`, e.g.
`JUMPSERVER_DB_DSN`.

## Layout

```
cmd/jumpserver/             # entry point, lifecycle, admin bootstrap
internal/
  config/                   # viper-backed configuration
  server/                   # gin engine + routes
  auth/                     # JWT issuer, provider registry, middleware
  model/                    # GORM rows
  repo/                     # CRUD + AutoMigrate
  cache/                    # Redis (active sessions, anonymous TTL)
  dialer/                   # ContextDialer composition (direct/SOCKS5/bastion)
  sshpool/                  # bastion *ssh.Client pool + watchdog
  ssh/                      # high-level Connect, key verification, cred resolver
  audit/                    # async writer + asciinema recorder
  webssh/                   # WebSocket gateway + 3-goroutine session pump
  sftp/                     # per-request SFTP REST handlers
  anonymous/                # Docker sandbox launcher + janitor
  api/                      # REST handlers
pkg/
  crypto/                   # AES-GCM Sealer
  log/                      # zap factory
```
