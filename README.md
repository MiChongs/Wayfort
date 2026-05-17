# JumpServer-Anonymous

<div align="center">

**🚀 一个用 Go 实现的现代化 Web 跳板机（堡垒机）后端**

支持 SSH / Telnet / RDP / VNC / 数据库 CLI / 任意 TCP 协议转发，多级代理链路、会话录像、异步审计、匿名沙箱。

[![Go Version](https://img.shields.io/badge/Go-1.25%2B-00ADD8?style=flat-square&logo=go)](https://go.dev/)
[![License](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Build](https://img.shields.io/badge/build-passing-brightgreen?style=flat-square)](https://github.com/MiChongs/JumpServer-Anonymous)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen?style=flat-square)](https://github.com/MiChongs/JumpServer-Anonymous)
[![Code Style](https://img.shields.io/badge/code%20style-gofmt-blue?style=flat-square)](https://pkg.go.dev/cmd/gofmt)
[![Platform](https://img.shields.io/badge/platform-linux%20%7C%20macOS%20%7C%20windows-lightgrey?style=flat-square)](#)

[![Gin](https://img.shields.io/badge/Web-Gin-00ACD7?style=flat-square)](https://github.com/gin-gonic/gin)
[![GORM](https://img.shields.io/badge/ORM-GORM-blueviolet?style=flat-square)](https://gorm.io/)
[![Redis](https://img.shields.io/badge/Cache-Redis-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io/)
[![MySQL](https://img.shields.io/badge/DB-MySQL-4479A1?style=flat-square&logo=mysql&logoColor=white)](https://www.mysql.com/)
[![Docker](https://img.shields.io/badge/Container-Docker-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![Guacamole](https://img.shields.io/badge/RDP%2FVNC-Guacamole-FF6F00?style=flat-square)](https://guacamole.apache.org/)
[![WebSocket](https://img.shields.io/badge/Transport-WebSocket-010101?style=flat-square)](https://github.com/coder/websocket)
[![JWT](https://img.shields.io/badge/Auth-JWT-000000?style=flat-square&logo=jsonwebtokens&logoColor=white)](https://jwt.io/)

[快速开始](#-快速开始) · [架构设计](#-架构设计) · [协议矩阵](#-支持的协议矩阵) · [API 文档](#-api-文档) · [部署](#-部署)

</div>

---

## 📖 项目简介

**JumpServer-Anonymous** 是一个面向运维场景的 Web 跳板机后端，使用纯 Go 编写，依赖业界最主流的库。它把传统的多客户端运维流程（终端、远程桌面、数据库管理工具、文件传输等）统一收敛到浏览器中，并通过统一的代理链路、权限模型和审计录像，把所有运维行为纳入可观测、可追溯的轨道。

### 🎯 解决了什么问题

| 痛点 | 本项目方案 |
| --- | --- |
| 运维工具五花八门（mstsc / mysql workbench / SecureCRT…） | 一个浏览器搞定 SSH / RDP / VNC / Telnet / DB CLI |
| 跳板机本身就是单点，扩容困难 | 无状态网关 + Redis + MySQL，水平扩展 |
| 跨网穿透要装一堆 agent | 自带 SOCKS5 + SSH bastion + HTTP CONNECT 三种代理链路，可任意串联 |
| 录像要么没有，要么只能录终端 | 字符会话用 asciinema v2，图形会话用 Guacamole 原生录像（可转 MP4） |
| 审计写库阻塞主线程，并发上不去 | 全链路非阻塞 + 异步批量写入 + 背压丢弃带标记 |
| 临时给外包/演示账号开权限太重 | 匿名 Docker 沙箱：一次性容器 + TTL 自动销毁 |

### ✨ 核心特性

- 🤖 **AI 助手 + 多 Agent 协作**：OpenAI / Anthropic / Gemini / 兼容网关（NewAPI / 硅基流动 / DeepSeek / Moonshot / 通义）；管理员/用户级 provider；全局/个人 agent；plan/normal/bypass 三种权限模式（参考 Claude Code）；SSE 流式输出；运维工具集（ssh_exec、sftp 读写、会话查询、端口转发、sub-agent）
- 🔐 **多协议代理转发**：SSH / Telnet / RDP / VNC / MySQL / PostgreSQL / Redis / MongoDB / 任意 TCP
- 🌐 **浏览器原生支持**：xterm.js（字符）+ guacamole-common-js（图形）即可使用
- 🔗 **多级代理链路**：直连 / SOCKS5 / SSH 跳板 任意嵌套，统一基于 `proxy.ContextDialer`
- 📹 **会话录像**：asciinema v2（字符）+ Guacamole `.guac`（图形，可转 MP4）
- 📊 **异步审计**：bounded chan + 批量写库 + 背压丢弃带 lossy 标记
- ⚡ **高性能高并发**：每会话 3 个 goroutine + errgroup 编排，全部非阻塞
- 👥 **完整 RBAC + 部门 + 用户组 + 资产组授权**：grantee×subject×action 三维授权矩阵
- 🔑 **多因素认证**：TOTP（Google Authenticator 等）+ 邮箱 OTP + 一次性恢复码，支持多设备
- 🛂 **Passkey/WebAuthn**：无密码登录、二因子两免，FIDO2 设备 / Touch ID / Windows Hello
- 🌍 **OIDC 单点登录**：Keycloak/Auth0/Google/Azure AD/飞书 等，PKCE + nonce
- 🔒 **会话安全**：登录失败锁定、JWT 主动撤销（黑名单）、异常登录检测 + 邮件告警、强制下线
- 🐳 **匿名沙箱**：一次性 Docker 容器，资源限额 + TTL 自动销毁
- 🚇 **临时端口转发**：网关本地监听 + WS 二进制隧道
- 🛡️ **安全加固**：AES-GCM 凭据加密，known_hosts TOFU，bcrypt 密码哈希

---

## 📋 支持的协议矩阵

| 协议 | 浏览器渲染 | 录像格式 | 适用场景 | 代理链路 |
| --- | :---: | --- | --- | :---: |
| **SSH** | ✅ xterm.js | asciinema v2 | Linux 服务器运维、SFTP 文件管理 | ✅ |
| **Telnet** | ✅ xterm.js | asciinema v2 | 网络设备（思科、华为）配置 | ✅ |
| **RDP** | ✅ guacamole-js | Guacamole `.guac` | Windows 远程桌面 | ✅（SOCKS5 中转） |
| **VNC** | ✅ guacamole-js | Guacamole `.guac` | Linux 图形界面、嵌入式设备 | ✅（SOCKS5 中转） |
| **MySQL CLI** | ✅ xterm.js | asciinema v2 | MySQL 数据库交互 | 网关直连/SOCKS5 |
| **PostgreSQL CLI** | ✅ xterm.js | asciinema v2 | PG 数据库交互 | 网关直连/SOCKS5 |
| **Redis CLI** | ✅ xterm.js | asciinema v2 | Redis 调试 | 网关直连/SOCKS5 |
| **MongoDB CLI** | ✅ xterm.js | asciinema v2 | Mongo 数据库交互 | 网关直连/SOCKS5 |
| **TCP 端口转发** | 本地监听 / WS 隧道 | 仅元数据 | 任意 TCP 协议（SMTP、HTTP、专有应用） | ✅ |
| **SFTP** | REST | 操作审计 | 文件上传下载、目录管理 | ✅ |
| **匿名沙箱** | ✅ xterm.js | asciinema v2 | 演示环境、CTF 靶场、命令练习 | — |

---

## 🛠️ 技术栈

| 用途 | 技术选型 |
| --- | --- |
| HTTP 框架 | [Gin](https://github.com/gin-gonic/gin) |
| WebSocket | [coder/websocket](https://github.com/coder/websocket)（社区维护的 nhooyr/websocket 继承版） |
| SSH 协议栈 | [`golang.org/x/crypto/ssh`](https://pkg.go.dev/golang.org/x/crypto/ssh) + `knownhosts` |
| SOCKS5 客户端 | [`golang.org/x/net/proxy`](https://pkg.go.dev/golang.org/x/net/proxy) |
| SFTP 子系统 | [pkg/sftp](https://github.com/pkg/sftp) |
| 图形协议网关 | [Apache Guacamole](https://guacamole.apache.org/)（guacd 旁路 + 自研 Go 桥接） |
| 容器 SDK | [docker/docker/client](https://pkg.go.dev/github.com/docker/docker/client) |
| ORM | [GORM](https://gorm.io/) + MySQL Driver |
| 缓存/分布式锁 | [go-redis v9](https://github.com/redis/go-redis) |
| JWT | [golang-jwt/jwt/v5](https://github.com/golang-jwt/jwt) |
| 配置 | [spf13/viper](https://github.com/spf13/viper) |
| 日志 | [uber-go/zap](https://github.com/uber-go/zap) |
| 密码哈希 | [`golang.org/x/crypto/bcrypt`](https://pkg.go.dev/golang.org/x/crypto/bcrypt) |
| 凭据加密 | 标准库 `crypto/aes` + `crypto/cipher`（AES-256-GCM） |
| 并发原语 | [`golang.org/x/sync/errgroup`](https://pkg.go.dev/golang.org/x/sync/errgroup) + `sync.Map` + `sync/atomic` |

---

## 🏗️ 架构设计

### 整体架构

```
                          ┌─────────────────────────────────────────┐
                          │              用户浏览器                    │
                          │   xterm.js  /  guacamole-common-js       │
                          └────────────────────┬────────────────────┘
                                               │ WSS（JWT 鉴权）
                          ┌────────────────────▼────────────────────┐
                          │            Gin HTTP/WS 网关              │
                          │   /ws/ssh   /ws/telnet   /ws/rdp         │
                          │   /ws/vnc   /ws/dbcli    /ws/tcp         │
                          │   /portforward  /sftp/*  /api/v1/*       │
                          └──┬───────────┬──────────┬───────────┬────┘
                             │           │          │           │
                ┌────────────▼──┐  ┌─────▼─────┐ ┌──▼──────┐ ┌──▼──────────┐
                │  SSH Backend   │  │ Telnet    │ │Guacamole│ │ DBCli       │
                │  (ssh.Session) │  │ (net.Conn)│ │ Bridge  │ │ (docker run)│
                └────────────┬──┘  └─────┬─────┘ └──┬──┬───┘ └──┬──────────┘
                             │           │          │  │        │
                             │           │          │  │ guacd  │
                             │           │          │  │ (旁路)  │
                             │           │          │  ▼        │
                             │           │          │ 每会话    │
                             │           │          │ SOCKS5    │
                             │           │          │ Listener  │
                             ▼           ▼          ▼  ▼        ▼
                          ┌─────────────────────────────────────────┐
                          │     ContextDialer 代理链路（统一拨号）     │
                          │   direct  →  SOCKS5  →  SSH Bastion     │
                          │   （任意嵌套，逐级穿透到目标）              │
                          └────────────────────┬────────────────────┘
                                               │
                          ┌────────────────────▼────────────────────┐
                          │           目标主机 / 容器 / 设备           │
                          │  Linux  Windows  网络设备  数据库  内网    │
                          └──────────────────────────────────────────┘

         ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
         │  异步审计 Writer   │   │  录像 Recorder    │   │  Bastion 客户端   │
         │  bounded chan +   │   │  asciinema v2 /  │   │  连接池 + watchdog │
         │  批量 INSERT      │   │  Guacamole .guac │   │                  │
         └──────────────────┘   └──────────────────┘   └──────────────────┘
              ▲                       ▲                       ▲
              │                       │                       │
              └───────── 后台 errgroup goroutine ──────────────┘
```

### 并发模型

整个系统遵循 **「主线程绝不阻塞 I/O」** 原则：

#### 每个会话固定 3 个核心 goroutine + 协议特定 goroutine

| 类型 | 数量 | 作用 |
| --- | :---: | --- |
| WS reader | 1 | 浏览器输入帧 → Backend.Write |
| Backend reader | 1 | Backend.Read → 浏览器输出帧 |
| Heartbeat | 1 | WebSocket ping/pong 保活 |
| Recorder writer | 1 | 消费 bounded chan → bufio 写盘（按需） |
| 协议附加 | 0~N | SOCKS5 listener / TCP accept / docker exec stream |

#### 全局后台 goroutine

| 任务 | 频率 | 作用 |
| --- | :---: | --- |
| 审计 writer worker | 200ms / 64 条 | 批量 `INSERT INTO audit_logs` |
| 匿名容器 janitor | 30s | 扫描 Redis TTL + Docker 实际列表对账，清理过期容器 |
| Bastion 池 watchdog | 实时 | 监听 `ssh.Client.Wait()`，断连原子驱逐 |
| Bastion 空闲清理 | `idle_eviction/2` | 回收无引用且超时的 SSH 客户端 |
| 端口转发 janitor | 30s | 关闭过期 TCP 转发监听器 |

#### 背压策略

| 组件 | 满了怎么办 |
| --- | --- |
| 录像 chan（默认 1024） | 丢弃帧 + 计数 + 写入 `["m","lossy:N"]` 标记，回放时显示空白 |
| 审计 chan（默认 4096） | 丢弃命令级事件，保留连接级事件，记日志 |
| WebSocket 写 | 10s 超时即断开 |

#### 优雅停机

所有长生命周期任务都通过 `errgroup.Group` + `context.Context` 编排。收到 `SIGINT/SIGTERM` 后：

1. 主 ctx cancel
2. HTTP server 拒绝新连接，等待存量请求
3. Bastion 池关闭所有 SSH 客户端
4. 审计 writer 排干 chan 落库
5. 录像 writer flush bufio
6. 所有 goroutine 5s 内退出

---

## 📂 项目结构

```
JumpServer-Anonymous/
├── cmd/jumpserver/main.go                  # 入口：装配 DI、起 errgroup、信号处理、首次启动 admin
├── configs/config.example.yaml             # 完整配置示例
├── deployments/
│   ├── Dockerfile                          # 多阶段构建，distroless 思路
│   └── docker-compose.yaml                 # mysql + redis + guacd + sshd-target + app
├── internal/
│   ├── config/                             # viper 加载 + env 覆盖 + 校验
│   ├── server/                             # gin engine、路由挂载、graceful shutdown
│   ├── auth/                               # JWT issuer、Provider 抽象（local/oidc）、中间件
│   ├── model/                              # GORM 模型：user/node/credential/proxy/session/audit/portforward
│   ├── repo/                               # CRUD + AutoMigrate
│   ├── cache/                              # go-redis：活动会话集合、容器/转发 TTL、分布式锁
│   ├── dialer/                             # ★ ContextDialer 组合层（direct/SOCKS5/bastion 链式）
│   ├── sshpool/                            # ★ Bastion *ssh.Client 池 + MaxSessions spin-up + watchdog
│   ├── ssh/                                # 高层 Connect、known_hosts TOFU、AES-GCM 凭据解密
│   ├── audit/                              # 异步 writer + asciinema v2 recorder
│   ├── webssh/                             # WebSocket 网关 + 3-goroutine 会话泵 + SSH/Telnet handler
│   ├── sftp/                               # REST 风格 SFTP（ls/mkdir/rm/upload/download）
│   ├── anonymous/                          # 匿名 Docker 沙箱（创建/退出/janitor 清理）
│   ├── protocols/                          # ★ 协议扩展聚合包
│   │   ├── telnet/                         #   原始 TCP Backend
│   │   ├── guacamole/                      #   guacd 桥接 + 指令编码 + per-session SOCKS5
│   │   ├── dbcli/                          #   mysql/psql/redis-cli/mongosh 一次性容器
│   │   └── tcpfwd/                         #   本地监听器 + WS 二进制隧道 + 管理器
│   └── api/                                # REST handler：auth/node/proxy/credential/session
├── pkg/
│   ├── crypto/                             # AES-256-GCM Sealer
│   └── log/                                # zap factory
├── go.mod / go.sum
└── README.md
```

---

## 🚀 快速开始

### 环境要求

- Go 1.25 或更新版本
- Docker（用于匿名沙箱、数据库 CLI、Guacamole 旁路）
- MySQL 5.7+ / 8.0
- Redis 6.0+

### 一键启动（推荐）

```bash
# 1. 克隆代码
git clone https://github.com/MiChongs/JumpServer-Anonymous.git
cd JumpServer-Anonymous

# 2. 启动依赖（MySQL + Redis + 测试用 SSHD + guacd）
docker compose -f deployments/docker-compose.yaml up -d mysql redis sshd-target guacd

# 3. 拷贝配置
cp configs/config.example.yaml configs/config.yaml

# 4. 启动网关
go run ./cmd/jumpserver --config configs/config.yaml
```

启动后默认监听 `:8080`，首次启动自动创建管理员账号（来自配置文件，默认 `admin / admin`）。

### 第一次 SSH 体验

```bash
# 1. 登录拿 JWT
TOKEN=$(curl -s -X POST localhost:8080/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin"}' | jq -r .access_token)

# 2. 注册一个密码凭据
curl -X POST localhost:8080/api/v1/credentials \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"test","kind":"password","username":"testuser","secret":"testpass"}'

# 3. 注册一个 SSH 节点（默认协议 ssh）
curl -X POST localhost:8080/api/v1/nodes \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"local","host":"127.0.0.1","port":2222,"username":"testuser","credential_id":1}'

# 4. WebSocket 连接（用 websocat 验证）
websocat "ws://localhost:8080/api/v1/ws/ssh/1?token=$TOKEN&cols=120&rows=32"
# 客户端发送 {"t":"input","d":"bHMK"}  (base64 of "ls\n")
# 服务端返回 {"t":"output","d":"..."}

# 5. 下载会话录像
curl -OJ "localhost:8080/api/v1/sessions/<session_id>/recording" \
  -H "Authorization: Bearer $TOKEN"
asciinema play *.cast
```

---

## 🌐 各协议使用指南

### Telnet（网络设备）

```bash
# 起一个 busybox telnetd 测试目标
docker run --rm -d --name telnet-target -p 2323:23 alpine sh -c '
  apk add --no-cache busybox-extras && telnetd -F -p 23 -l /bin/sh'

# 注册节点（指定 protocol: telnet）
curl -X POST :8080/api/v1/nodes -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"router-1","protocol":"telnet","host":"127.0.0.1","port":2323,
       "username":"-","credential_id":1}'

# 连接
websocat "ws://localhost:8080/api/v1/ws/telnet/<id>?token=$TOKEN"
```

### RDP（Windows 远程桌面）

需要先在 `configs/config.yaml` 启用 Guacamole：

```yaml
protocols:
  guacamole:
    enabled: true
    guacd_addr: "guacd:4822"     # docker-compose 内的 guacd
    recording: true              # 启用原生会话录像
```

注册节点：

```bash
curl -X POST :8080/api/v1/nodes -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"win-server","protocol":"rdp","host":"10.0.0.5","port":3389,
       "username":"Administrator","credential_id":<pwd-cred-id>,
       "proto_options":"{\"security\":\"any\",\"ignore-cert\":\"true\"}"}'
```

浏览器使用 `guacamole-common-js`，连接 URL：

```
ws://localhost:8080/api/v1/ws/rdp/<id>?token=$TOKEN&width=1280&height=720
```

录像（`.guac` 格式）下载后可用 `guacenc` 转 MP4：

```bash
curl -OJ ":8080/api/v1/sessions/<id>/recording" -H "Authorization: Bearer $TOKEN"
docker run --rm -v $PWD:/data guacamole/guacd guacenc -s 1280x720 /data/<id>.guac
```

> **跨 bastion 的妙招**：guacd 自己拨 TCP，无法走我们的 SSH 跳板。
> 解法是**每个图形会话起一个临时 SOCKS5 监听器**（绑 127.0.0.1:0），把端口作为
> `socks-proxy-host/port` 参数传给 guacd。Guacamole 的 RDP/VNC 驱动原生支持 SOCKS5，
> 自然就穿透了所有 bastion 层。代码见 `internal/protocols/guacamole/socks_local.go`。

### VNC

```bash
# 测试目标：Ubuntu XFCE VNC 容器
docker run --rm -d --name vnc-target -p 5900:5900 -e VNC_PASSWORD=test \
  consol/ubuntu-xfce-vnc

curl -X POST :8080/api/v1/nodes -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"linux-desktop","protocol":"vnc","host":"127.0.0.1","port":5900,
       "credential_id":<pwd-cred-id>}'

# 浏览器连接
ws://localhost:8080/api/v1/ws/vnc/<id>?token=$TOKEN
```

### 数据库 CLI

```yaml
# 启用配置
protocols:
  dbcli:
    enabled: true
    images:
      mysql:    "mysql:8.0"
      postgres: "postgres:16-alpine"
      redis:    "redis:7-alpine"
      mongo:    "mongo:7"
    ttl: 30m
```

> ⚠️ 启用后需要给网关挂载 docker socket（`/var/run/docker.sock`），`docker-compose.yaml` 中已注释好示例。

```bash
# 注册一个 MySQL 节点
curl -X POST :8080/api/v1/nodes -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"prod-mysql","protocol":"mysql","host":"db.internal","port":3306,
       "username":"app","credential_id":<pwd-cred-id>,
       "proto_options":"{\"database\":\"app\"}"}'

# 连接（会拉起一个 mysql:8.0 容器执行交互式 CLI）
websocat "ws://localhost:8080/api/v1/ws/dbcli/<id>?token=$TOKEN"
# 命令直接落地到目标 DB，容器关闭即自动销毁
```

支持的协议：`mysql` / `postgres` / `redis` / `mongo`。

### 通用 TCP 端口转发

**方式 1：网关本地监听**（最通用，适合任何本地客户端）

```bash
# 申请一个临时本地端口
curl -X POST :8080/api/v1/portforward \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"node_id":<id>,"ttl":"30m"}'
# → { "id":"pf-xxx","local_host":"127.0.0.1","local_port":42531, ... }

# 此后任何本地客户端都可以通过 127.0.0.1:42531 访问目标
psql -h 127.0.0.1 -p 42531 -U app -d app
mysql -h 127.0.0.1 -P 42531 -u app -p
mstsc /v:127.0.0.1:42531   # 甚至可以转 RDP

# 用完释放
curl -X DELETE :8080/api/v1/portforward/pf-xxx -H "Authorization: Bearer $TOKEN"
```

**方式 2：浏览器 WebSocket 二进制隧道**（适合扩展程序、Webhook 调试）

```
ws://localhost:8080/api/v1/ws/tcp/<node_id>?token=$TOKEN
# 帧格式：{"t":"data","d":"<base64 二进制数据>"}
```

### 匿名 Docker 沙箱（演示 / CTF）

```yaml
anonymous:
  enabled: true
  image: "alpine:latest"
  ttl: 10m
  memory_mb: 128
  cpu: 0.5
  network: "none"
```

```bash
# 游客拿一个匿名 token（无需登录）
TOKEN=$(curl -s -X POST :8080/api/v1/auth/anonymous | jq -r .access_token)

# 进入沙箱 shell
websocat "ws://localhost:8080/api/v1/ws/ssh/anonymous?token=$TOKEN"
# 10 分钟后 janitor 自动销毁容器
```

容器以 `--read-only` 根 + `tmpfs /tmp` + `--network none` + 内存/CPU/PID 限额运行，安全可靠。

---

## 🤖 AI 助手快速开始

```bash
# 1. admin 注册一个全局 OpenAI provider
TOKEN=...   # admin JWT
curl -X POST :8080/api/v1/ai/providers -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"openai","kind":"openai","api_key":"sk-...","default_model":"gpt-4o-mini","is_global":true}'

# 也可注册兼容网关（硅基流动 / DeepSeek / NewAPI / 通义 ...）
curl -X POST :8080/api/v1/ai/providers -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"siliconflow","kind":"openai_compatible",
       "base_url":"https://api.siliconflow.cn/v1","api_key":"sk-...",
       "default_model":"Qwen/Qwen2.5-72B-Instruct","is_global":true}'

# 或 Anthropic
curl -X POST :8080/api/v1/ai/providers -d '{"name":"claude","kind":"anthropic",
  "api_key":"sk-ant-...","default_model":"claude-sonnet-4-5","is_global":true}'

# 2. 创建一个运维 agent
curl -X POST :8080/api/v1/ai/agents -d '{
  "name":"sre","scope":"global",
  "system_prompt":"你是资深 SRE，使用工具帮助用户诊断和修复问题。",
  "allowed_tools":["list_nodes","get_node","health_check","ssh_exec_readonly","ssh_exec","sftp_list","sftp_read","session_list","audit_query"],
  "default_provider_id":1,"default_model":"gpt-4o-mini",
  "permission_mode":"normal","max_iterations":20}'

# 3. 创建会话 + 订阅 SSE
CID=$(curl -s -X POST :8080/api/v1/ai/conversations -d '{"agent_id":1}' | jq -r .id)
curl -N "http://localhost:8080/api/v1/ai/conversations/$CID/stream" \
  -H "Authorization: Bearer $TOKEN" &

# 4. 另一个终端发指令
curl -X POST :8080/api/v1/ai/conversations/$CID/messages \
  -d '{"text":"检查节点 prod-web-1 的磁盘并告诉我是否有 >80% 的分区"}'

# 期望 SSE 事件：
#   event: text_delta       data: {"text":"我来检查..."}
#   event: tool_call        data: {"id":"call_x","name":"health_check","arguments":{"node_id":7}}
#   event: tool_start       data: {"id":"call_x","invocation_id":"inv_y"}
#   event: tool_output      data: {"id":"call_x","output":"uptime ..."}
#   event: text_delta       data: {"text":"磁盘使用..."}
#   event: message_end      data: {"finish_reason":"stop"}
#   event: done             data: {}

# 5. 高危工具会先 permission_required，用户点同意：
curl -X POST :8080/api/v1/ai/conversations/$CID/invocations/inv_y/approve

# 6. 切到 plan 模式（所有写操作 dry-run）
curl -X PATCH :8080/api/v1/ai/conversations/$CID -d '{"permission_mode":"plan"}'

# 7. 多 agent 协作：注册一个 sub-agent，让主 agent 调用
curl -X POST :8080/api/v1/ai/agents -d '{
  "name":"sql-diagnose","scope":"global","is_sub_agent":true,
  "invocation_hint":"诊断 MySQL 慢查询时调用我",
  "system_prompt":"你是 MySQL 专家...","allowed_tools":["ssh_exec_readonly"],
  "default_provider_id":1}'
# 然后给主 agent 的 allowed_tools 加上 "call_subagent"
```

### 三种权限模式

| 模式 | 行为 |
| --- | --- |
| `plan` | 危险工具一律转 `DryRun`，仅返回"将要做什么"——适合先让 AI 规划，再人工 review |
| `normal` | 低危工具直接执行；中/高危工具弹 `permission_required`，等用户在前端点同意 |
| `bypass` | 任何工具直接执行；只受调用者本人的资产授权拦截 |

### 工具集

| Tool | Danger | 用途 |
| --- | --- | --- |
| `list_nodes` / `get_node` | Low | 浏览资产 |
| `health_check` | Low | 节点健康巡检 |
| `ssh_exec_readonly` | Low | 仅白名单命令（ls/cat/uptime/free/df/ps/journalctl status…） |
| `ssh_exec` | High | 任意命令执行（需确认） |
| `sftp_list` / `sftp_read` | Low | 只读文件浏览（256KB 上限） |
| `sftp_write` / `sftp_delete` | High | 改写远端文件（需确认） |
| `session_list` / `audit_query` | Low | 历史会话与审计 |
| `portforward_create` / `portforward_delete` | High | 端口转发管理（需确认） |
| `call_subagent` | Medium | 委派给另一个 is_sub_agent=true 的 agent，深度上限 2 |

---

## 📡 API 文档

### 认证

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | 公开 | 用户名密码登录；若启用 MFA 返回 `mfa_required` + `challenge_token` |
| POST | `/api/v1/auth/login/totp` | challenge_token | 提交 TOTP 验证码完成登录 |
| POST | `/api/v1/auth/login/email-otp/send` | challenge_token | 发送邮箱 OTP |
| POST | `/api/v1/auth/login/email-otp` | challenge_token | 提交邮箱验证码完成登录 |
| POST | `/api/v1/auth/login/recovery` | challenge_token | 用一次性恢复码登录 |
| POST | `/api/v1/auth/login/passkey/begin` | 公开 | 获取 WebAuthn assertion challenge |
| POST | `/api/v1/auth/login/passkey/finish` | 公开 | 提交浏览器签名完成 Passkey 登录 |
| POST | `/api/v1/auth/refresh` | refresh token | 刷新 access token |
| POST | `/api/v1/auth/logout` | authed | 主动登出，加入 jti 黑名单 |
| POST | `/api/v1/auth/anonymous` | 公开（受开关） | 申请匿名 JWT |
| GET  | `/api/v1/auth/providers` | 公开 | 列出可用的第三方 OIDC IdP |
| GET  | `/api/v1/auth/oidc/:provider/login` | 公开 | 跳转到 IdP |
| GET  | `/api/v1/auth/oidc/:provider/callback` | 公开 | OIDC 授权回调 |

### 自助（/me）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / PATCH | `/api/v1/me/profile` | 查看 / 修改个人资料 |
| POST | `/api/v1/me/password` | 修改密码 |
| GET | `/api/v1/me/mfa` | 已绑定的 MFA 设备 |
| POST | `/api/v1/me/mfa/totp/begin` | 申请 TOTP 注册，返回 QR + secret |
| POST | `/api/v1/me/mfa/totp/finish` | 提交 OTP 完成 TOTP 绑定 |
| DELETE | `/api/v1/me/mfa/:id` | 解绑 MFA |
| POST | `/api/v1/me/mfa/recovery-codes/regenerate` | 重新生成 10 个恢复码 |
| GET | `/api/v1/me/passkeys` | 已注册的 Passkey |
| POST | `/api/v1/me/passkeys/register/begin` | 申请 Passkey 注册 challenge |
| POST | `/api/v1/me/passkeys/register/finish` | 提交浏览器返回的 attestation |
| DELETE | `/api/v1/me/passkeys/:id` | 删除一个 Passkey |
| GET / POST / DELETE | `/api/v1/me/favorites[/:node_id]` | 收藏 / 取消 |
| GET | `/api/v1/me/recent-nodes` | 最近使用的节点 |
| GET | `/api/v1/me/login-history` | 自己的登录历史 |
| GET | `/api/v1/me/nodes` | 经资产授权过滤后的可见节点列表 |

### 用户 / 角色 / 部门 / 组（admin）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| CRUD | `/api/v1/users` | 用户 CRUD |
| POST | `/api/v1/users/:id/reset-password` | 重置密码 |
| POST | `/api/v1/users/:id/unlock` | 解锁账号 |
| POST | `/api/v1/users/:id/force-logout` | 强制踢下线（撤销全部 token） |
| GET / PUT | `/api/v1/users/:id/roles` | 查看 / 替换角色 |
| CRUD | `/api/v1/roles` | 角色 CRUD（系统内置角色不可删） |
| GET | `/api/v1/permissions` | 列出所有权限点 |
| CRUD | `/api/v1/departments` | 部门 CRUD（树形） |
| CRUD | `/api/v1/groups` | 用户组 CRUD |
| POST/DELETE | `/api/v1/groups/:id/members[/:uid]` | 增删成员 |

### 资产授权

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| CRUD | `/api/v1/asset-groups` | 资产组（树形） |
| POST/DELETE | `/api/v1/asset-groups/:id/nodes[/:nid]` | 节点入/出组 |
| CRUD | `/api/v1/tags` | 标签 |
| POST/DELETE | `/api/v1/nodes/:id/tags[/:tid]` | 给节点贴/撕标签 |
| CRUD | `/api/v1/asset-grants` | 资产授权（用户/角色/组 × 节点/组/标签 × 动作） |

### OIDC 客户端管理（admin）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| CRUD | `/api/v1/oidc-clients` | 注册 Keycloak/Auth0/Google/Azure/飞书 等 IdP |

### AI 助手

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| CRUD | `/api/v1/ai/providers` | 注册/管理 LLM 提供商（全局/个人） |
| POST | `/api/v1/ai/providers/:id/test` | 拨测 |
| GET | `/api/v1/ai/providers/:id/models` | 列出可用模型 |
| CRUD | `/api/v1/ai/agents` | 全局 + 个人 agent |
| GET | `/api/v1/ai/tools` | 工具目录（含 danger 级别 + JSON schema） |
| CRUD | `/api/v1/ai/conversations` | 会话管理 |
| POST | `/api/v1/ai/conversations/:id/messages` | 发用户消息（响应是 SSE 流） |
| GET | `/api/v1/ai/conversations/:id/stream` | 重连进行中会话的 SSE |
| POST | `/api/v1/ai/conversations/:id/cancel` | 中断生成 |
| POST | `/api/v1/ai/conversations/:id/invocations/:inv_id/approve` | 同意危险工具 |
| POST | `/api/v1/ai/conversations/:id/invocations/:inv_id/reject` | 拒绝 |

### 资产管理

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET / POST / PATCH / DELETE | `/api/v1/nodes`、`/nodes/:id` | admin | 节点 CRUD |
| GET / POST / PATCH / DELETE | `/api/v1/proxies`、`/proxies/:id` | admin | 代理 CRUD |
| GET / POST / PATCH / DELETE | `/api/v1/credentials`、`/credentials/:id` | admin | 凭据 CRUD（响应不含密文） |

### 会话与录像

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/sessions` | authed | 历史会话列表 |
| GET | `/api/v1/sessions/:id/recording` | authed | 下载录像（.cast 或 .guac） |
| GET | `/api/v1/sessions/:id/cast` | authed | 同上，旧版兼容别名 |

### SFTP 文件管理

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/v1/nodes/:id/sftp/ls?path=/` | authed | 列目录 |
| POST | `/api/v1/nodes/:id/sftp/mkdir` | authed | 创建目录 |
| DELETE | `/api/v1/nodes/:id/sftp/rm?path=...` | authed | 删除文件或目录 |
| POST | `/api/v1/nodes/:id/sftp/upload?path=...` | authed | 上传（multipart） |
| GET | `/api/v1/nodes/:id/sftp/download?path=...` | authed | 下载（流式） |

### 端口转发

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/portforward` | authed | 申请新端口转发 |
| GET | `/api/v1/portforward` | authed | 列出我的（或全部，admin） |
| DELETE | `/api/v1/portforward/:id` | authed | 释放 |

### WebSocket 会话

| 路径 | 子协议 | 协议要求 | 说明 |
| --- | --- | --- | --- |
| `/api/v1/ws/ssh/:node_id` | `webssh.v1` | ssh | SSH 终端 |
| `/api/v1/ws/telnet/:node_id` | `webssh.v1` | telnet | Telnet 终端 |
| `/api/v1/ws/rdp/:node_id` | `guacamole` | rdp | RDP 图形 |
| `/api/v1/ws/vnc/:node_id` | `guacamole` | vnc | VNC 图形 |
| `/api/v1/ws/dbcli/:node_id` | `webssh.v1` | mysql/postgres/redis/mongo | 数据库 CLI |
| `/api/v1/ws/tcp/:node_id` | `tcp.v1` | 任意 | TCP 二进制隧道 |
| `/api/v1/ws/ssh/anonymous` | `webssh.v1` | — | 匿名沙箱 |

#### WebSocket 帧格式（webssh.v1）

```json
// 客户端 → 服务端
{"t":"input",  "d":"<base64 输入>"}
{"t":"resize", "cols":120, "rows":32}
{"t":"ping"}
{"t":"close"}

// 服务端 → 客户端
{"t":"ready"}
{"t":"output", "d":"<base64 输出>"}
{"t":"pong"}
{"t":"error",  "msg":"..."}
{"t":"close",  "msg":"reason"}
```

### 鉴权方式

JWT token 可通过三种方式传递（按优先级）：

1. HTTP Header：`Authorization: Bearer <token>`
2. Query 参数：`?token=<token>`（WebSocket 友好）
3. WebSocket 子协议：`Sec-WebSocket-Protocol: bearer.<token>, webssh.v1`

---

## 🖥️ 前端（Next.js 16 + shadcn/ui）

完整 Web 控制台位于 `web/` 子目录，覆盖登录 / MFA / Passkey / OIDC / Dashboard /
节点列表 / WebSSH / Telnet / RDP / VNC / DB CLI / SFTP / 会话录像 / 端口转发 /
AI 助手（SSE 流 + 工具确认）/ 个人设置 / 管理员全套 CRUD（用户、角色、部门、
用户组、节点、凭据、代理、资产组、标签、资产授权、OIDC、AI provider、AI agent）。

### 技术栈

- Next.js 16 App Router + React 19 + TypeScript
- Tailwind CSS v4 + shadcn/ui（zinc 主题，明/暗双色）+ sonner（toast）
- TanStack Query v5 + React Hook Form + zod
- xterm.js（终端）、guacamole-common-js（图形协议）、@simplewebauthn/browser（Passkey）
- react-markdown + remark-gfm + rehype-highlight（AI 输出）
- asciinema-player（录像回放）、@monaco-editor/react（文件编辑）
- motion、next-themes、lucide-react、cmdk、vaul、react-resizable-panels、react-virtuoso、recharts、nuqs、react-hotkeys-hook

### 启动

```bash
cd web
cp .env.example .env.local
# .env.local：
#   BACKEND_HTTP_URL=http://127.0.0.1:8080
#   NEXT_PUBLIC_BACKEND_WS_URL=ws://127.0.0.1:8080
#   NEXT_PUBLIC_API_BASE=/api/proxy/api/v1
npm install
npm run dev         # localhost:3000
```

### API 代理与 IP 透传

`web/src/app/api/proxy/[...path]/route.ts` 是 REST / SSE 反向代理：把浏览器对
`/api/proxy/api/v1/...` 的请求转发到 `BACKEND_HTTP_URL`，自动附加
`X-Forwarded-For` / `X-Real-IP` / `X-Forwarded-Host`，后端的 `c.ClientIP()` 因此能
拿到真实客户端 IP。SSE 不缓冲：流式 ReadableStream 直接管道转发。

**WebSocket 不走 Next.js 代理**（Route Handler 不支持 upgrade），浏览器通过
`NEXT_PUBLIC_BACKEND_WS_URL` 直连后端 `/api/v1/ws/...`，token 走 query string。
生产建议挂在 Nginx 后做统一反代 + TLS。

### 部署

```bash
docker build -t jumpserver-web ./web
docker run -d -p 3000:3000 \
  -e BACKEND_HTTP_URL=http://app:8080 \
  -e NEXT_PUBLIC_BACKEND_WS_URL=wss://your.domain \
  jumpserver-web
```

---

## ⚙️ 配置参考

完整示例见 `configs/config.example.yaml`，关键字段说明：

```yaml
server:
  addr: ":8080"                              # 监听地址
  shutdown_timeout: 10s                      # 优雅停机超时

db:
  dsn: "user:pass@tcp(host:3306)/jumpserver?charset=utf8mb4&parseTime=True&loc=Local"
  max_open: 50                               # 数据库连接池
  max_idle: 10

redis:
  addr: "127.0.0.1:6379"

auth:
  jwt_secret: "至少 32 字节的随机字符串"         # ⚠️ 必须修改
  access_ttl: 1h
  refresh_ttl: 168h
  bootstrap_admin: "admin"                   # 首次启动创建的管理员
  bootstrap_password: "admin"                # ⚠️ 生产必须修改

crypto:
  master_key_hex: "64 字符 hex（32 字节）"    # ⚠️ 凭据加密主密钥，必须妥善保管

sshpool:
  max_sessions_per_client: 8                 # 单个 bastion 客户端最大复用会话数
  idle_eviction: 10m                         # 空闲多久回收

anonymous:
  enabled: true
  image: "alpine:latest"
  ttl: 10m                                   # 容器存活时长
  memory_mb: 128
  cpu: 0.5
  network: "none"                            # 网络隔离

recorder:
  chan_size: 1024                            # 录像 chan 容量，满则丢帧+lossy 标记
  flush_interval: 250ms                      # bufio flush 周期

audit:
  chan_size: 4096
  batch_size: 64
  batch_interval: 200ms

protocols:
  guacamole:
    enabled: true
    guacd_addr: "127.0.0.1:4822"
    recording: true
    socks_listen_host: "127.0.0.1"           # per-session SOCKS5 监听器绑定地址
  dbcli:
    enabled: false                           # 需要挂 docker.sock
    ttl: 30m
  tcpfwd:
    enabled: true
    listen_host: "127.0.0.1"
    port_range: [40000, 49999]
    default_ttl: 1h
    max_per_user: 8                          # 单用户最大并发转发数
```

### 环境变量覆盖

所有配置都可以用 `JUMPSERVER_` 前缀的环境变量覆盖（`.` 转 `_`）：

```bash
export JUMPSERVER_DB_DSN="..."
export JUMPSERVER_REDIS_ADDR="redis:6379"
export JUMPSERVER_AUTH_JWT_SECRET="..."
export JUMPSERVER_PROTOCOLS_GUACAMOLE_ENABLED=true
```

---

## 🧪 测试

```bash
# 全部单元测试
go test ./...

# 详细输出
go test ./... -v -count 1

# 单包测试
go test ./internal/audit/... -v
go test ./internal/protocols/... -v
```

### 测试覆盖的关键路径

- ✅ `internal/audit/recorder_test.go` — asciinema header / 输出 / 改窗 / 背压丢帧 + lossy 标记
- ✅ `internal/dialer/chain_test.go` — 代理链组合 / 失败时释放 / 直连穿透
- ✅ `internal/protocols/guacamole/instruction_test.go` — 协议帧编解码 / SOCKS5 参数装配
- ✅ `internal/protocols/guacamole/socks_local_test.go` — SOCKS5 监听器 + 真实 `proxy.SOCKS5` 客户端 echo
- ✅ `internal/protocols/tcpfwd/forwarder_test.go` — 本地监听器端到端 echo
- ✅ `internal/protocols/telnet/backend_test.go` — Telnet Backend echo

---

## 🐳 部署

### Docker Compose（推荐）

```bash
docker compose -f deployments/docker-compose.yaml up -d
```

包含：
- MySQL 8.0
- Redis 7
- Apache Guacamole guacd 1.5.5
- 测试用 OpenSSH server（`testuser/testpass`，端口 2222）
- 应用本身（端口 8080）

### 单独构建 Docker 镜像

```bash
docker build -t jumpserver-anonymous:latest -f deployments/Dockerfile .
docker run -d --name jumpserver \
  -p 8080:8080 \
  -v $(pwd)/configs:/app/configs \
  -v jumpserver-sessions:/var/lib/jumpserver/sessions \
  jumpserver-anonymous:latest
```

### 二进制部署

```bash
# 编译
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o jumpserver ./cmd/jumpserver

# 运行
./jumpserver --config /etc/jumpserver/config.yaml
```

### 生产环境注意事项

| 事项 | 建议 |
| --- | --- |
| JWT 密钥 | 使用 `openssl rand -base64 48` 生成 |
| 凭据加密主密钥 | 使用 `openssl rand -hex 32`，妥善保管（如 Vault / KMS） |
| TLS 终结 | 前面挂 Nginx / Traefik，本服务可以不开 TLS |
| 反向代理 | 配置 `proxy_read_timeout` ≥ 1h（WebSocket 长连接） |
| 日志收集 | zap 输出 JSON，建议接 Loki / ELK |
| Bastion 容量 | `sshpool.max_sessions_per_client` 与 OpenSSH `MaxSessions`(默认 10) 对齐 |
| 录像存储 | 长期归档建议用对象存储（S3/OSS），通过定时任务搬运 |
| Guacamole | guacd 设置 `restart: unless-stopped`，配合健康检查 |

---

## 🔒 安全特性

| 维度 | 实现 |
| --- | --- |
| 密码存储 | bcrypt 默认 cost（10） |
| 凭据加密 | AES-256-GCM，nonce 前置；主密钥独立配置 |
| Token 鉴权 | JWT HS256，access + refresh 双 token |
| Host Key 校验 | known_hosts + 首次信任（TOFU），可配置为严格模式 |
| 输入校验 | gin + go-playground/validator |
| SQL 注入防护 | GORM 参数化查询 |
| 容器隔离 | `--read-only` + tmpfs + no-new-privileges + 网络/资源限额 |
| 端口转发约束 | 默认仅绑 127.0.0.1 + per-user quota + TTL |
| 审计完整性 | 所有连接/命令/文件操作落库，无法关闭 |

---

## 🤝 贡献指南

欢迎 Issue 与 PR！

```bash
# 准备开发环境
git clone https://github.com/MiChongs/JumpServer-Anonymous.git
cd JumpServer-Anonymous
go mod download

# 修改前先跑测试
go test ./...

# 提交前
go fmt ./...
go vet ./...
go test ./... -count 1
```

提交规范：

- `feat:` 新功能
- `fix:` Bug 修复
- `refactor:` 重构
- `docs:` 文档
- `test:` 测试

---

## 📜 License

MIT License — 详见 [LICENSE](LICENSE)。

---

## 🙏 致谢

本项目基于以下优秀开源项目构建：

- [Apache Guacamole](https://guacamole.apache.org/) — 图形协议网关
- [Gin](https://github.com/gin-gonic/gin)、[GORM](https://gorm.io/)、[Zap](https://github.com/uber-go/zap)
- [coder/websocket](https://github.com/coder/websocket) — 现代 WebSocket 库
- [JumpServer](https://github.com/jumpserver/jumpserver) — 设计思路参考

如果本项目对你有帮助，欢迎 ⭐ Star！
