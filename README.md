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

- 🔐 **多协议代理转发**：SSH / Telnet / RDP / VNC / MySQL / PostgreSQL / Redis / MongoDB / 任意 TCP
- 🌐 **浏览器原生支持**：xterm.js（字符）+ guacamole-common-js（图形）即可使用
- 🔗 **多级代理链路**：直连 / SOCKS5 / SSH 跳板 任意嵌套，统一基于 `proxy.ContextDialer`
- 📹 **会话录像**：asciinema v2（字符）+ Guacamole `.guac`（图形，可转 MP4）
- 📊 **异步审计**：bounded chan + 批量写库 + 背压丢弃带 lossy 标记
- ⚡ **高性能高并发**：每会话 3 个 goroutine + errgroup 编排，全部非阻塞
- 🔑 **可插拔认证**：JWT + 本地账号 + 预留 OIDC/OAuth2 Provider
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

## 📡 API 文档

### 认证

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | 公开 | 用户名密码登录，返回 access + refresh token |
| POST | `/api/v1/auth/refresh` | refresh token | 刷新 access token |
| POST | `/api/v1/auth/anonymous` | 公开（受开关） | 申请匿名 JWT |

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
