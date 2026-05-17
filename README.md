# JumpServer-Anonymous

Go-based web jump server (跳板机) backend that brokers SSH, Telnet, RDP, VNC,
database CLIs, and arbitrary TCP through a multi-hop proxy chain. Includes
SFTP file management, asciinema and Guacamole session recordings, async audit
logging, JWT auth (OIDC-ready), TCP port forwarding, and an anonymous Docker
sandbox mode.

| Protocol | Browser-rendered? | Recording | Notes |
| -------- | ----------------- | --------- | ----- |
| SSH | yes (xterm.js) | asciinema v2 | bastion + SOCKS5 chains, SFTP, anonymous sandbox |
| Telnet | yes (xterm.js) | asciinema v2 | raw TCP, IAC pass-through |
| RDP | yes (guacamole-common-js) | Guacamole `.guac` | via guacd sidecar; bastion via per-session SOCKS5 |
| VNC | yes (guacamole-common-js) | Guacamole `.guac` | via guacd sidecar |
| MySQL / PostgreSQL / Redis / MongoDB | yes (xterm.js) | asciinema v2 | one-shot Docker container with the CLI |
| Generic TCP | local listener or WS binary tunnel | metadata only | any TCP service through the chain |

All hot paths are non-blocking: each session runs three core goroutines
(WS-reader → backend, backend → WS-writer, heartbeat) plus protocol-specific
helpers (SOCKS5 acceptor for Guacamole, accept loop for TCP forwarding), and
feeds a separate recorder/audit worker via bounded channels.

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

## Additional protocols

### Telnet

```bash
# Stand up a busybox telnetd target
docker run --rm -d --name telnet-target -p 2323:23 alpine sh -c '
  apk add --no-cache busybox-extras && telnetd -F -p 23 -l /bin/sh'

# Register the node and connect
curl -X POST :8080/api/v1/nodes -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"tn","protocol":"telnet","host":"127.0.0.1","port":2323,
       "username":"-","credential_id":1}'
websocat "ws://localhost:8080/api/v1/ws/telnet/<id>?token=$TOKEN"
```

### RDP / VNC via Guacamole

Enable Guacamole in `configs/config.yaml`:

```yaml
protocols:
  guacamole:
    enabled: true
    guacd_addr: "127.0.0.1:4822"   # or "guacd:4822" in docker-compose
    recording: true
```

Then start `guacd`:

```bash
docker compose -f deployments/docker-compose.yaml up -d guacd
```

Register an RDP or VNC node:

```bash
curl -X POST :8080/api/v1/nodes -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"win","protocol":"rdp","host":"10.0.0.5","port":3389,
       "username":"Administrator","credential_id":<password-cred>,
       "proto_options":"{\"security\":\"any\",\"ignore-cert\":\"true\"}"}'
```

The browser connects via the Guacamole WebSocket subprotocol and renders
through `guacamole-common-js`:

```
ws://localhost:8080/api/v1/ws/rdp/<id>?token=$TOKEN&width=1280&height=720
ws://localhost:8080/api/v1/ws/vnc/<id>?token=$TOKEN
```

When `recording: true`, guacd writes a `.guac` file under `<sessions_dir>/<date>/`,
downloadable via `GET /api/v1/sessions/<id>/recording`. Convert to MP4:

```bash
docker run --rm -v $PWD:/data guacamole/guacd guacenc -s 1280x720 /data/<id>.guac
```

### Database CLI sessions

Enable in config:

```yaml
protocols:
  dbcli:
    enabled: true
```

Then mount the Docker socket on the app container (already configured in
`deployments/docker-compose.yaml`), register a node, and connect:

```bash
curl -X POST :8080/api/v1/nodes -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"prod-mysql","protocol":"mysql","host":"db.internal","port":3306,
       "username":"app","credential_id":<password-cred>,
       "proto_options":"{\"database\":\"app\"}"}'
websocat "ws://localhost:8080/api/v1/ws/dbcli/<id>?token=$TOKEN"
```

Supported: `mysql`, `postgres`, `redis`, `mongo`. The container is removed
after the session closes.

### Generic TCP port forwarding

```bash
# Open a tunnel on the gateway to a target node
curl -X POST :8080/api/v1/portforward \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"node_id":<id>,"ttl":"30m"}'
# -> { "id":"pf-...","local_host":"127.0.0.1","local_port":42531, ... }

# Now connect any local client
psql -h 127.0.0.1 -p 42531 -U app -d app

# Or use the browser WS binary tunnel (frames: {"t":"data","d":"<base64>"})
websocat "ws://localhost:8080/api/v1/ws/tcp/<node_id>?token=$TOKEN"

# Release
curl -X DELETE :8080/api/v1/portforward/pf-... -H "Authorization: Bearer $TOKEN"
```

The manager enforces `protocols.tcpfwd.max_per_user` and expires forwarders
when `ttl` elapses.

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
| GET     | `/api/v1/sessions/:id/recording`    | authed        |
| GET     | `/api/v1/nodes/:id/sftp/ls`         | authed        |
| POST    | `/api/v1/nodes/:id/sftp/mkdir`      | authed        |
| DELETE  | `/api/v1/nodes/:id/sftp/rm`         | authed        |
| POST    | `/api/v1/nodes/:id/sftp/upload`     | authed        |
| GET     | `/api/v1/nodes/:id/sftp/download`   | authed        |
| WS      | `/api/v1/ws/ssh/:node_id`           | authed        |
| WS      | `/api/v1/ws/telnet/:node_id`        | authed        |
| WS      | `/api/v1/ws/rdp/:node_id`           | authed        |
| WS      | `/api/v1/ws/vnc/:node_id`           | authed        |
| WS      | `/api/v1/ws/dbcli/:node_id`         | authed        |
| WS      | `/api/v1/ws/tcp/:node_id`           | authed        |
| POST    | `/api/v1/portforward`               | authed        |
| GET     | `/api/v1/portforward`               | authed        |
| DELETE  | `/api/v1/portforward/:id`           | authed        |
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
  model/                    # GORM rows (Node now has Protocol enum)
  repo/                     # CRUD + AutoMigrate
  cache/                    # Redis (active sessions, anonymous + portfwd TTL)
  dialer/                   # ContextDialer composition (direct/SOCKS5/bastion)
  sshpool/                  # bastion *ssh.Client pool + watchdog
  ssh/                      # high-level Connect, key verification, cred resolver
  audit/                    # async writer + asciinema recorder
  webssh/                   # WebSocket gateway, 3-goroutine session pump, SSH + Telnet handlers
  protocols/
    telnet/                 # raw-TCP backend matching webssh.Backend
    guacamole/              # guacd bridge, instruction encoder, per-session SOCKS5 listener
    dbcli/                  # one-shot Docker CLI containers (mysql/psql/redis-cli/mongosh)
    tcpfwd/                 # local listener forwarders + WS binary relay + manager
  sftp/                     # per-request SFTP REST handlers
  anonymous/                # Docker sandbox launcher + janitor
  api/                      # REST handlers
pkg/
  crypto/                   # AES-GCM Sealer
  log/                      # zap factory
```
