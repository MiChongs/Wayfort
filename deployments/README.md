# Wayfort 一键部署

跨平台(Linux / macOS / Windows)的容器化一键部署。一条命令拉起整套:
**Postgres + Redis + guacd + 后端网关 + Next.js 前端 + Caddy 单一入口**。

## 前置要求

- 已安装并运行 **Docker**(Linux 装 Docker Engine;Windows/macOS 装 Docker Desktop)。
- 自带 **Docker Compose v2**(`docker compose version` 能输出版本)。
- 仅此而已 —— 无需本机装 Go / Node / pnpm,全部在容器内构建。

## 快速开始

**Linux / macOS:**

```bash
./deploy.sh
```

**Windows(PowerShell 7+):**

```powershell
./deploy.ps1
```

首次运行会自动:
1. 从 `deployments/.env.example` 生成 `deployments/.env`,并填入随机 `JWT_SECRET` /
   `POSTGRES_PASSWORD` / `ADMIN_PASSWORD` / `OFFICE_JWT_SECRET`(该文件含明文密钥,已被
   `.gitignore` 忽略,切勿提交)。
2. 构建后端与前端镜像,拉起全部服务。
3. 等待后端就绪(自动建库 + 数据迁移 + 引导),随后打印访问地址与初始管理员密码。

完成后打开 **http://localhost:8088**,用 `admin` + 打印出来的密码登录(登录后请尽快改密)。

## 拓扑(单一入口)

```
                       ┌─────────────────────── Docker 内部网络 ───────────────────────┐
浏览器 ──▶ Caddy :8088 ─┤  /api/v1/*  ──▶ wayfort:8080 (后端 / 全部 WebSocket、freerdp)  │
        (唯一对外端口)  │  /jet/*     ──▶ wayfort:7171 (ironrdp Devolutions Gateway)     │
                       │  其余        ──▶ web:3000 (Next.js;经 /api/proxy/* 转发 REST)  │
                       │  wayfort ──▶ postgres:5432 / redis:6379 / guacd:4822          │
                       └───────────────────────────────────────────────────────────────┘
```

- **只有 Caddy 对宿主暴露端口**;其余服务仅在内部网络互通。浏览器只访问一个源,
  因此 WebSocket 与后端同源(绕开跨源 WS 校验),且无需暴露后端端口。
- 前端的浏览器侧 WebSocket 地址在**构建期**烤进镜像(`NEXT_PUBLIC_BACKEND_WS_URL`,
  由 `.env` 的 `WS_SCHEME` / `PUBLIC_HOST` / `WEB_PORT` 合成),所以改这三项后必须重建 web 镜像
  —— `up` / `update` 默认带 `--build`,会自动重建。

## 常用命令

| 命令 | 说明 |
|---|---|
| `./deploy.sh up` | 构建 + 启动(默认命令) |
| `./deploy.sh down` | 停止并移除容器(**保留数据卷**) |
| `./deploy.sh restart` | 重启所有服务 |
| `./deploy.sh logs [服务]` | 跟踪日志(如 `logs wayfort`) |
| `./deploy.sh status` | 查看各服务状态 |
| `./deploy.sh update` | 拉取基础镜像 + 按当前源码重建 + 滚动重启 |
| `./deploy.sh destroy` | 停止并**删除全部数据卷**(不可逆,需输入 `YES`) |

Windows 把 `./deploy.sh` 换成 `./deploy.ps1`,用法一致。

## 远程 / 公网访问

默认地址烤的是 `localhost`,只能本机访问。要让其他机器访问,编辑 `deployments/.env`:

```ini
PUBLIC_HOST=你的服务器IP或域名      # 例:10.0.0.12 或 bastion.example.com
WEB_PORT=8088
```

然后 `./deploy.sh up`(会自动重建 web 镜像以烤入新地址)。确保 `WEB_PORT` 在防火墙放通。

## 启用 HTTPS(可选,推荐用于公网)

Caddy 内置自动 HTTPS(Let's Encrypt),配好域名后零额外证书运维:

1. 把域名解析到本机,并放通入站 **80 + 443**(ACME 签发/续期与 HTTP→HTTPS 重定向都需要)。
2. 编辑 `deployments/Caddyfile`:把站点地址 `:80` 改为你的域名(如 `bastion.example.com`)。
   Caddy 会自动签发/续期证书,在容器内监听 443(HTTPS)并把 80 重定向到 443。
3. 编辑 `deployments/docker-compose.prod.yaml` 的 caddy 服务 `ports`,把单行
   `- "${WEB_PORT:-8088}:80"` **替换**为下面两行(让宿主 80/443 直通 Caddy,避免端口冲突):

   ```yaml
   ports:
     - "80:80"
     - "443:443"
   ```

4. 编辑 `deployments/.env`:`PUBLIC_HOST=你的域名`、`WS_SCHEME=wss`、`PUBLIC_SCHEME=https`、`WEB_PORT=443`
   (这几项合成浏览器侧 WebSocket 地址 `wss://你的域名:443` 与 ironrdp 网关的 `external_url`,
   会在重建/重部署时生效;`WS_SCHEME`/`PUBLIC_SCHEME` 必须配套:wss↔https)。
5. `./deploy.sh up`(自动重建 web 镜像)。完成后访问 **https://你的域名**。

## 可选特性

```bash
./deploy.sh up --office     # 叠加在线 Office 编辑(OnlyOffice,镜像约 2GB、首启较慢)
./deploy.sh up --sandbox    # 叠加匿名沙箱 / DB CLI 容器
```

> ⚠️ `--sandbox` 会把宿主 `docker.sock` 挂进后端容器并以 root 运行(≈授予宿主 root 等价权限)。
> 仅在确实需要「免注册一次性沙箱 / 容器化 DB 客户端」且信任部署环境时启用。

可视化 **DB Studio**(直连数据库)、SSH / SFTP / Telnet / 端口转发 / 对象存储 /
RDP·VNC(经 guacd)等均**默认可用**,无需任何额外开关。

## 新版 WebRDP(freerdp + ironrdp,完整内置)

后端镜像([deployments/Dockerfile.webrdp](Dockerfile.webrdp),compose 默认使用)**完整编译并内置**
新版桌面的全部原生组件,开箱即用,无需宿主机装任何东西:

- **freerdp 后端**:`freerdp-worker` 用 CGO 链接 libfreerdp3 + libfreerdp-client3 + winpr3,
  并编入全部编解码器 —— **libvpx**(VP8/VP9)、**libaom**(AV1)、**libturbojpeg**(SIMD JPEG)。
  其视频/位图流复用 Caddy 已路由的 `/api/v1/ws`,**默认后端**,链路最稳。
- **ironrdp 后端**:内置 **Devolutions Gateway**(上游 Release 的 glibc 二进制)。wayfort 监管其
  子进程(监听容器内 7171),浏览器经 Caddy 的 `/jet/*` 到达;`advertised_url` / `external_url`
  由 compose 按 `.env`(`PUBLIC_HOST`/`WEB_PORT`/`PUBLIC_SCHEME`/`WS_SCHEME`)注入。
  可在桌面会话设置里在 freerdp / ironrdp 之间切换。
  - `advertised_url`(`ws(s)://主机:端口/jet/rdp`)是浏览器实际连的 WebSocket 地址(经 Caddy 转发到网关);
    `external_url`(`http(s)://主机:端口`,无路径)是写入网关 JSON 的对外 HTTP 基址。二者主机/端口须一致,
    且 `WS_SCHEME` 与 `PUBLIC_SCHEME` 必须配套(ws↔http、wss↔https);deploy 脚本会在不配套时给出警告。

> 镜像基于 **Debian trixie**(freerdp **3.x** 所需;Devolutions 二进制是 glibc,故不用 alpine)。
> 首次构建较重(编译 freerdp worker + 下载 Devolutions Gateway,约数分钟、镜像 1–2GB);后续构建走缓存。
> Devolutions 下载走 GitHub:若被限流,在 `deployments/.env` 设 `DGW_VERSION=x.y.z` 固定版本。

### WebRTC 高清视频(可选)

freerdp 的 WebRTC 视频轨(VP9/AV1 硬件解码)需要浏览器与后端**直连 UDP** 做 ICE,而单端口
反向代理无法穿透 UDP,故容器基线**关闭 WebRTC**(自动回落到经 Caddy WS 的位图/视频路径,
编解码器已全部编入、随时可用)。要开启完整 WebRTC:

1. `config.docker.yaml` 里 `desktop.webrtc.enabled: true`、设 `public_ip: <宿主公网IP>`、
   并把 `udp_port_min/max` 收敛到一段范围(如 `50000`–`50100`);
2. 在 `docker-compose.prod.yaml` 的 caddy(或 wayfort)服务发布该 UDP 段:`- "50000-50100:50000-50100/udp"`;
3. `./deploy.sh up`。

## 其它已知边界

- guacamole(旧版 `/rdp`、guacd 容器)仍保留为备选 RDP/VNC 路径;其会话录像默认关闭
  (guacd 以 root 写、后端以非 root 读,跨用户权限易冲突)。

## 数据与备份

命名数据卷(`docker volume ls | grep wayfort`):

- `wayfort_pg_data` —— PostgreSQL 全量数据(用户 / 资产 / 凭据 / 审计 …)。
- `wayfort_redis_data` —— 会话与 TTL 缓存。
- `wayfort_wayfort_var` —— **解封口令 `keystore.unseal`** + 会话录制。
  > 务必**离线备份** `keystore.unseal`:它解封凭据信封加密层,丢失将无法解密已存凭据。

`down` 不删卷;`destroy` 才会删。升级用 `update`(数据卷保留)。

## 手动 / 高级

部署脚本本质等价于:

```bash
docker compose -p wayfort --env-file deployments/.env \
  -f deployments/docker-compose.prod.yaml \
  [-f deployments/docker-compose.office.yaml] [-f deployments/docker-compose.sandbox.yaml] \
  up -d --build --remove-orphans
```

后端配置见 `deployments/config/config.docker.yaml`;任意键可用 `WAYFORT_*` 环境变量覆盖
(前缀 `WAYFORT_`,键名 `.` → `_`,如 `auth.jwt_secret` → `WAYFORT_AUTH_JWT_SECRET`)。
```
