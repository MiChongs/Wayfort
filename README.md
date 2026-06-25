<div align="center">

# 🛡️ Wayfort

**用 Go + Next.js 打造的现代化特权访问管理平台（PAM / 堡垒机）—— 全协议、浏览器原生、零客户端**

把 SSH · Telnet · RDP · VNC · 数据库 · 对象存储 · 文件传输 · 端口转发 统一收敛到浏览器，
配合多级代理链、细粒度授权、审批工作流、会话录像、异步审计、KMS 凭据加密与内置 AI 运维助手，
让每一次运维行为都**可视、可控、可追溯**。

<br/>

[![官网 Website](https://img.shields.io/badge/🌐_官网-wayfort.karpov.cn-6366F1?style=for-the-badge)](https://wayfort.karpov.cn/)
[![Linux.do 社区](https://img.shields.io/badge/💬_Linux.do-社区讨论-F56040?style=for-the-badge)](https://linux.do/)

[![Go](https://img.shields.io/badge/Go-1.26-00ADD8?style=flat-square&logo=go&logoColor=white)](https://go.dev/)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?style=flat-square&logo=nextdotjs&logoColor=white)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-22c55e?style=flat-square)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4?style=flat-square)](#-贡献指南)

[![Gin](https://img.shields.io/badge/HTTP-Gin-00ACD7?style=flat-square)](https://github.com/gin-gonic/gin)
[![GORM](https://img.shields.io/badge/ORM-GORM-7c3aed?style=flat-square)](https://gorm.io/)
[![PostgreSQL](https://img.shields.io/badge/DB-PostgreSQL-4169E1?style=flat-square&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Cache-Redis-DC382D?style=flat-square&logo=redis&logoColor=white)](https://redis.io/)
[![WebRTC](https://img.shields.io/badge/Desktop-WebRTC%20%2F%20pion-333333?style=flat-square&logo=webrtc&logoColor=white)](https://github.com/pion/webrtc)
[![WebGPU](https://img.shields.io/badge/Render-WebGPU-005A9C?style=flat-square)](https://www.w3.org/TR/webgpu/)
[![Docker](https://img.shields.io/badge/Container-Docker-2496ED?style=flat-square&logo=docker&logoColor=white)](https://www.docker.com/)
[![AI](https://img.shields.io/badge/AI-OpenAI%20%C2%B7%20Claude%20%C2%B7%20Gemini-10a37f?style=flat-square&logo=openai&logoColor=white)](#-ai-运维助手)

[🌐 官网](https://wayfort.karpov.cn/) · [💬 Linux.do 社区](https://linux.do/) · [功能特性](#-功能特性) · [能力矩阵](#-协议与能力矩阵) · [架构](#-架构总览) · [快速开始](#-快速开始) · [配置](#-配置参考) · [API](#-api-概览) · [部署](#-部署)

</div>

---

## 📖 项目简介

**Wayfort** 是一个面向运维与安全团队的 **Web 特权访问管理平台**：后端纯 Go（Gin + GORM + Redis + pion WebRTC），前端 Next.js 16 / React 19。它把传统运维需要的一大堆客户端（mstsc、SecureCRT、Navicat、FileZilla、各家对象存储工具……）统一收敛进浏览器，并在统一的**代理链路、RBAC + 资产授权、审批工作流、会话录像、异步审计、KMS 凭据加密**之上，把所有运维动作纳入可观测、可追溯、可治理的轨道。

> 💡 除完整的企业账号体系外，Wayfort 还内置一次性「**匿名 Docker 沙箱**」：无需注册即可领到一个带 TTL 自动销毁的隔离 shell —— 适合产品演示、CTF 靶场与临时命令练习。

### 🎯 解决了什么问题

| 痛点 | 本项目方案 |
| --- | --- |
| 运维工具五花八门 | 一个浏览器搞定 SSH / Telnet / RDP / VNC / 数据库 / 对象存储 / 文件传输 / 端口转发 |
| Windows 远程桌面卡、糊、费流量 | 自研 **WebRDP**：FreeRDP/IronRDP 双后端 + WebRTC VP9/AV1 + WebGPU 渲染 + 动态分辨率 |
| 数据库要装客户端、权限难管 | **DB Studio**：浏览器里的结构化库管（SQL 编辑器 / 表浏览 / EXPLAIN 可视化 / 多格式导出），写操作走审批 |
| 临时放权太重、出了事查不清 | **审批工作流** + 时限授权 + 全链路审计 + KMS 签名防篡改账本 |
| 凭据明文落库、泄露即灾难 | **KMS 信封加密**（Vault / AWS / Azure / GCP KMS），密钥不落配置文件 |
| 跨网穿透要装一堆 agent | 内置 SOCKS5 + SSH 跳板 + 代理链，任意嵌套，逐级穿透 |
| 录像只能录终端 | 字符会话 asciinema v2、图形会话 H.264/`.guac`、DB/文件操作全审计 |
| 运维要人盯、重复劳动多 | 内置 **AI 助手**（OpenAI / Claude / Gemini）+ 多 Agent 协作 + 工具调用审批 |

---

## ✨ 功能特性

<table>
<tr>
<td width="33%" valign="top">

### 🔌 多协议接入
- **SSH / Telnet** 终端（xterm.js + WebGL）
- **RDP / VNC** 图形桌面
- **数据库 CLI**（MySQL / PG / Redis / Mongo）
- **TCP 端口转发**（本地监听 / WS 隧道）
- **SFTP** 文件管理
- **匿名 Docker 沙箱**

</td>
<td width="33%" valign="top">

### 🖥️ WebRDP 远程桌面
- **FreeRDP / IronRDP** 双后端
- **WebRTC** VP8 / VP9 / **AV1** 视频流
- **WebGPU** 零拷贝渲染（省 CPU/内存）
- **AVC444** 4:4:4 全彩、高 DPI
- **动态分辨率**跟随窗口
- 个人盘重定向 · 音频 · 会话录像

</td>
<td width="33%" valign="top">

### 🗄️ DB Studio
- 结构化库管：schema / 表 / 行
- **SQL 编辑器**（Monaco，收藏夹）
- **EXPLAIN 树形可视化**
- 列级数据摘要 popover
- 多格式导出 CSV/JSONL/SQL/MD
- 适配 MySQL / PostgreSQL / **达梦**

</td>
</tr>
<tr>
<td valign="top">

### ☁️ 对象存储跳板（OSS）
- 阿里云 OSS / 腾讯 COS / **AWS S3**
- 账号级节点浏览多桶
- 完整读写 + 在线预览
- access_key 凭据托管

</td>
<td valign="top">

### 📁 SFTP 高级文件中心
- 上传/下载/重命名/移动/打包
- **在线预览**：Office / PDF / 图片 / 媒体
- **OnlyOffice** 在线编辑文档
- 图片编辑器 · EXIF · 语法高亮

</td>
<td valign="top">

### ✅ 审批工作流
- 连接前申请、SSE 实时推送
- 多级审批 / 批量决策 / 转交
- 时限授权 + 自助提前释放
- KMS 签名审计链（防篡改）

</td>
</tr>
<tr>
<td valign="top">

### 🤖 AI 运维助手
- OpenAI / **Claude** / Gemini / 兼容网关
- 全局 + 个人 Agent、多 Agent 协作
- plan / normal / bypass 权限模式
- 工具集 + 高危操作人工确认 + SSE 流

</td>
<td valign="top">

### 🔐 安全与凭据
- **KMS 信封加密**（Vault/AWS/Azure/GCP）
- MFA（TOTP + 邮箱 OTP + 恢复码）
- **Passkey / WebAuthn** 无密码登录
- OIDC 单点登录 · JWT 主动撤销 · 锁定

</td>
<td valign="top">

### 📊 治理与可观测
- RBAC + 部门 + 用户组 + 资产组授权
- **系统遥测**（CPU/内存/磁盘/进程/网络）
- 在线监看 + 强制下线
- 防火墙 / Docker 管理面板 · 通知中心

</td>
</tr>
</table>

---

## 📋 协议与能力矩阵

| 协议 / 能力 | 浏览器侧 | 录像 / 审计 | 代理链路 | 审批门控 |
| --- | --- | --- | :---: | :---: |
| **SSH** | xterm.js + WebGL | asciinema v2 + 命令审计 | ✅ | ✅ |
| **Telnet** | xterm.js | asciinema v2 | ✅ | ✅ |
| **RDP（新栈）** | WebRTC `<video>` / WebGPU canvas | `.dtr`（H.264 + 输入时间线） | ✅（SOCKS5） | ✅ |
| **RDP / VNC（Guacamole）** | guacamole-common-js | `.guac`（可转 MP4） | ✅（SOCKS5） | ✅ |
| **数据库 CLI** | xterm.js | asciinema v2 | 直连 / SOCKS5 | ✅ |
| **DB Studio**（结构化） | Monaco + ResultGrid | 操作审计 + 写操作审批 | 直连 / SOCKS5 | ✅ |
| **对象存储 OSS** | 文件管理器 + 预览 | 操作审计 | 厂商 SDK | ✅ |
| **SFTP** | 文件管理器 + 预览/编辑 | 操作审计 | ✅ | ✅ |
| **TCP 端口转发** | 本地监听 / WS 隧道 | 元数据 | ✅ | ✅ |
| **匿名沙箱** | xterm.js | asciinema v2 | — | — |

---

## 🏗️ 架构总览

```
                         ┌───────────────────────────────────────────────┐
                         │        浏览器 · Next.js 16 / React 19          │
                         │  xterm.js · WebRTC <video>/WebGPU · IronRDP    │
                         │  guacamole-js · Monaco · OnlyOffice · SSE      │
                         └───────────────┬───────────────────────────────┘
                          REST/SSE 走 Next 反代 │ WS 直连后端（JWT）
                         ┌───────────────▼───────────────────────────────┐
                         │              Gin HTTP / WebSocket 网关          │
                         │   /api/v1/*  ·  /api/v1/ws/*  ·  鉴权中间件     │
                         │   RBAC · 资产授权 · 审批门控 · 异步审计         │
                         └─┬─────┬──────┬──────┬──────┬──────┬──────┬─────┘
                           │     │      │      │      │      │      │
              ┌────────────▼┐ ┌──▼───┐ ┌▼────┐ ┌▼───┐ ┌▼────┐ ┌▼───┐ ┌▼──────────┐
              │ webssh      │ │telnet│ │desk-│ │ DB │ │ OSS │ │SFTP│ │ AI Runner  │
              │ SSH/沙箱    │ │      │ │ top │ │Stud│ │三云 │ │    │ │ 多Agent+工具│
              └──────┬──────┘ └──┬───┘ └─┬┬──┘ └─┬──┘ └──┬──┘ └─┬──┘ └─────┬──────┘
                     │           │       ││      │       │      │          │
                     │           │   ┌───▼▼──────────┐   │      │    ┌─────▼──────┐
                     │           │   │ freerdp-worker│   │      │    │OpenAI/Claude│
                     │           │   │ (CGO+libvpx/  │   │      │    │  /Gemini    │
                     │           │   │  libaom) ·    │   │      │    └────────────┘
                     │           │   │ IronRDP 网关  │   │      │
                     ▼           ▼   └──────┬────────┘   ▼      ▼
                  ┌────────────────────────────────────────────────────┐
                  │      ContextDialer 代理链（direct → SOCKS5 → SSH）   │
                  │              任意嵌套，逐级穿透到目标               │
                  └───────────────────────┬────────────────────────────┘
                                          ▼
            ┌──────────────── 目标：Linux · Windows · 网络设备 · 数据库 · 对象存储 ────────────────┐

   ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
   │ PostgreSQL   │  │   Redis      │  │ 异步审计     │  │ 审批工作流   │  │ KMS 信封加密 │
   │ (GORM)       │  │ 会话/锁/TTL  │  │ 批量落库     │  │ +签名账本    │  │ Vault/AWS/.. │
   └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

<details>
<summary><b>⚙️ 并发模型与运行时（点击展开）</b></summary>

<br/>

系统遵循 **「主线程绝不阻塞 I/O」** 原则，所有长生命周期任务通过 `errgroup.Group` + `context.Context` 编排，收到 `SIGINT/SIGTERM` 后优雅停机。

**每会话核心 goroutine**：WS reader（浏览器输入）、Backend reader（目标输出）、Heartbeat（ping/pong）、Recorder writer（录像落盘），外加协议特定 goroutine（SOCKS5 listener / TCP accept / docker exec / FreeRDP worker 帧泵）。

**全局后台 goroutine**（`cmd/wayfort/main.go` 的 errgroup）：审计 writer、SSH 池 watchdog、匿名容器 janitor、端口转发 manager、邮件 worker、AI janitor、审批 reconciler、桌面 worker bootstrap、Devolutions Gateway ensure。

**背压策略**：录像 chan 满则丢帧 + `lossy:N` 标记；审计 chan 满则丢命令级事件保连接级事件；WebSocket 写 10s 超时即断开。

</details>

---

## 🛠️ 技术栈

<table>
<tr><th>后端（Go 1.26）</th><th>前端（Next.js 16 / React 19）</th></tr>
<tr><td valign="top">

- **HTTP/WS** · Gin · coder/websocket
- **ORM/DB** · GORM · PostgreSQL / MySQL / SQLite / 达梦 / openGauss
- **缓存/锁** · go-redis v9
- **远程桌面** · pion/webrtc v4 · CGO + libfreerdp · libvpx / **libaom(AV1)** · IronRDP(Devolutions Gateway)
- **AI** · anthropic-sdk-go · openai-go · google genai(Gemini)
- **对象存储** · aliyun-oss · tencent-cos · aws-sdk-go-v2/s3
- **KMS** · HashiCorp Vault · AWS KMS · Azure Key Vault · GCP Cloud KMS
- **认证** · golang-jwt/v5 · go-webauthn(Passkey) · coreos/go-oidc · pquerna/otp(TOTP)
- **协议栈** · x/crypto/ssh · pkg/sftp · x/net/proxy(SOCKS5) · Apache Guacamole(guacd 旁路)
- **容器** · docker/docker client · panjf2000/ants(协程池)
- **其它** · viper(配置) · zap(日志) · go-mail(邮件) · MongoDB driver

</td><td valign="top">

- **框架** · Next.js 16 App Router · React 19 · TypeScript 6 · Tailwind CSS v4
- **UI** · shadcn/ui（Radix）· lucide-react · simple-icons · sonner · motion · cmdk · vaul
- **数据** · TanStack Query v5 · React Hook Form · zod · zustand · nuqs
- **终端** · @xterm/xterm v6（webgl / image / ligatures / search / unicode 等 addon）
- **图形桌面** · @devolutions/iron-remote-desktop(WASM) · guacamole-common-js · WebGPU · WebCodecs
- **编辑/预览** · @monaco-editor/react · pdfjs-dist + react-pdf · video.js · react-filerobot-image-editor · exifr · OnlyOffice
- **可视化** · recharts · @xyflow/react(代理链画布) · mermaid · katex
- **AI 输出** · react-markdown + remark-gfm + rehype-highlight/katex
- **录像/其它** · asciinema-player · i18next(中/英) · comlink(Worker) · idb-keyval

</td></tr>
</table>

---

## 🚀 快速开始

### 环境要求

- **Go 1.26+**、**Node 20+** + **pnpm**（前端）
- **PostgreSQL 14+**（主库；亦支持 MySQL / 达梦 / openGauss / SQLite）
- **Redis 6+**
- **Docker**（匿名沙箱 / 数据库 CLI / Guacamole / OnlyOffice）
- WebRDP `freerdp` 后端需 libfreerdp 3.x（见 `scripts/build-worker-*`）；默认 `ironrdp` 后端由内置 Devolutions Gateway 提供

### 一键起依赖 + 后端

```bash
# 1. 克隆
git clone https://github.com/MiChongs/wayfort.git
cd wayfort

# 2. 起依赖（PostgreSQL + Redis + 测试 SSHD + guacd）
docker compose -f deployments/docker-compose.yaml up -d postgres redis sshd-target guacd
# 需要在线 Office（SFTP/OSS 内编辑 docx/xlsx/pptx）时再起 onlyoffice：
#   docker compose -f deployments/docker-compose.yaml up -d onlyoffice

# 3. 配置
cp configs/config.example.yaml configs/config.yaml

# 4. 启动网关（首次自动建表 + 创建管理员）
go run ./cmd/wayfort --config configs/config.yaml
```

> 首次启动若未设置 `auth.bootstrap_password`，系统会生成 **20 位强随机密码并在控制台 banner 打印一次**——请立即记录。

### 启动前端控制台

```bash
cd web
cp .env.example .env.local   # 配置 BACKEND_HTTP_URL / NEXT_PUBLIC_BACKEND_WS_URL
corepack enable              # 启用 package.json 锁定的 pnpm 版本
pnpm install
pnpm dev                     # http://localhost:4001
```

> REST/SSE 走 Next.js 反向代理（`/api/proxy/...` → 后端，自动透传真实 IP）；**WebSocket 不走代理**，浏览器经 `NEXT_PUBLIC_BACKEND_WS_URL` 直连后端。生产建议前置 Nginx/Caddy 统一反代 + TLS。

---

## 🧩 功能详解

<details>
<summary><b>🖥️ WebRDP 远程桌面（FreeRDP / IronRDP 双后端）</b></summary>

<br/>

- **双后端**：`ironrdp`（默认，内置 Devolutions Gateway 子进程，零额外依赖）与 `freerdp`（自研 `cmd/freerdp-worker`，CGO 链接 libfreerdp 3.x，功能最全）。
- **WebRTC 视频流**：worker 用 libvpx 编 **VP8 / VP9**（屏幕内容模式）、用 libaom 编 **AV1**（同画质比 VP9 省 30–50% 流量），经 pion 视频 track 推给浏览器 `<video>` 硬解；GCC 带宽估计闭环动态调码率。
- **WebGPU 渲染**：位图回退路径用 `bgra8unorm` 纹理直传 GPU，跳过逐像素转换与 ImageBitmap 拷贝，显著降低浏览器 CPU/内存/发热；不支持时自动回退 Canvas 2D。
- **AVC444 4:4:4 全彩**：服务器侧 FreeRDP 解码，彩色文字最锐利。
- **动态分辨率（RDPEDISP）**：远端桌面跟随浏览器窗口实时改分辨率，始终 1:1 无缩放模糊；亦可切「智能缩放」。
- **高 DPI** 全链路缩放、**个人盘**双向文件重定向、**音频**回放、**会话录像**（`.dtr`，含输入/事件时间线，浏览器原地回放）。
- **连接选项全链路**：网络预设（LAN/WAN/移动）、bpp、压缩级别、连接类型、GFX 编解码偏好等，节点级可视化配置。

> 连接选项与编解码参数本机可通过 MSYS2 编译 worker 验证；运行时画质需在真实环境观测。

</details>

<details>
<summary><b>🗄️ DB Studio · 结构化数据库管理</b></summary>

<br/>

- **多引擎适配器**：MySQL / PostgreSQL / **达梦(DM)** / openGauss（安全的关系型适配器层，避免硬编码方言分支）；Redis / MongoDB 经容器化 DB CLI。
- **浏览**：库 / schema / 表 / 列（类型·默认值·约束）/ 索引 / 外键 / 触发器 / 表与列统计；schema 树带「最近」分区。
- **查询**：Monaco SQL 编辑器（收藏夹本机持久化）、分页行查询（搜索/过滤）、多语句脚本执行（尊重引号/美元引用）。
- **可视化**：**EXPLAIN 树形计划**（PG 计划解析为嵌套盒子）、列级数据分布摘要 popover（点表头看直方图）。
- **编辑**：行级 INSERT / UPDATE / DELETE，写操作走**审批门控**；运行中进程查看 + kill。
- **导出**：ResultGrid 多格式导出 **CSV / JSONL / SQL / Markdown / Excel**。

</details>

<details>
<summary><b>☁️ 对象存储跳板（OSS）</b></summary>

<br/>

- **多厂商原生 SDK**：阿里云 OSS、腾讯云 COS、AWS S3（及 S3 兼容如 MinIO/Ceph）。
- **账号级节点**可浏览该账号下的多个 bucket；列对象、prefix 过滤、分页。
- **完整读写**：上传 / 下载 / 删除 / 复制 / 建目录；在线**预览**文本 / 图片 / PDF / Office。
- 凭据走 `access_key` 类型托管（KMS 加密）；写操作可走审批；可视化 workspace 操作。

</details>

<details>
<summary><b>📁 SFTP 高级文件中心</b></summary>

<br/>

- 列目录 / stat / mkdir / rm / chmod / rename / copy / 搜索 / 打包下载（tar/zip）/ 文本读写。
- **在线预览**：Office（OnlyOffice）、PDF、图片（缩略图 + EXIF）、音视频（video.js）、文本（语法高亮）。
- **在线编辑**：OnlyOffice 文档协同编辑（签名回调）、纯文本编辑、图片编辑器（filerobot/Photopea）。
- 并发上传队列 + 拖拽 + 底部传输坞；按授权控制、单文件/目录访问限制。

</details>

<details>
<summary><b>✅ 审批工作流</b></summary>

<br/>

- **连接前申请**：需审批的资源在工作台弹申请面板，SSE 实时推送审批结果，通过后自动连接。
- **审批人侧**：收件箱、待我处理、批量决策、转交；审批时可调整授予时长。
- **授权管理**：我的授权清单、自助提前释放、管理员撤销；时限授权自动过期。
- **治理**：审批模板、订阅规则、统计（状态/风险/SLA）、KMS 签名事件链（防篡改）、可选 S3 Object Lock(WORM) 归档。
- **门控范围**：WebSSH / SFTP / RDP/VNC / DB Studio / DB CLI / TCP 转发 / 桌面 / 凭据解密统一接入。

</details>

<details>
<summary><b>🤖 AI 运维助手</b></summary>

<br/>

- **Provider**：OpenAI、Anthropic Claude、Google Gemini，以及任意 **OpenAI 兼容网关**（NewAPI / 硅基流动 / DeepSeek / Moonshot / 通义）；管理员全局 + 用户个人级。
- **Agent**：全局 + 个人 Agent，可加载工具子集；首次启动可种入默认 SRE/巡检/日志/安全/成本等 Agent 与子 Agent。
- **权限模式**（参考 Claude Code）：`plan`（写操作 dry-run）/ `normal`（高危工具弹确认）/ `bypass`（直接执行，仅受本人资产授权拦截）。
- **工具集**：`list_nodes`/`health_check`/`ssh_exec_readonly`（白名单可配）/`ssh_exec`/`sftp_*`/`session_list`/`audit_query`/`portforward_*`/`call_subagent`（多 Agent 协作，深度上限）。
- **交互**：SSE 流式输出、工具 invocation 审核面板、消息编辑、对话搜索 / 导出 Markdown、会话 TTL 自动清理。

</details>

<details>
<summary><b>🔐 身份、凭据与安全</b></summary>

<br/>

- **KMS 信封加密**：每条凭据一个 DEK，KEK 托管于外部 KMS（Vault/OpenBao Transit、AWS/Azure/GCP KMS 或本地）；运行时可注册、测试、提升主 provider 并 rewrap 历史凭据，密钥不落 YAML/环境变量。
- **MFA**：TOTP（Google Authenticator 等）+ 邮箱 OTP + 一次性恢复码，多设备。
- **Passkey / WebAuthn**：无密码登录、二因子两免（FIDO2 / Touch ID / Windows Hello）。
- **OIDC 单点登录**：Keycloak / Auth0 / Google / Azure AD / 飞书等，PKCE + nonce。
- **会话安全**：登录失败锁定、JWT 主动撤销（Redis 黑名单）、异常登录检测 + 邮件告警、强制下线。
- **加固**：bcrypt 密码哈希、known_hosts TOFU、容器 `--read-only`+tmpfs+网络/资源限额、GORM 参数化、输入校验。

</details>

<details>
<summary><b>👥 组织、授权与可观测</b></summary>

<br/>

- **RBAC + 组织**：角色权限 + 部门树 + 用户组树（支持跨部门、用户多部门），授权沿树继承。
- **资产授权**：`grantee（用户/角色/组）× subject（节点/资产组/标签）× action` 三维矩阵，支持「某人能访问什么 / 某资产谁能访问」双向穿透透视。
- **统一标签/图标**：受管彩色标签 + 标签组、节点/智能体可自定义图标（lucide/simple-icons/emoji/text）。
- **系统遥测（Insights）**：SSH 页直接看目标 CPU/内存/磁盘/进程/网络，按需轮询 + 网关去重缓存。
- **运维面板**：防火墙（iptables/ufw/firewalld）与 Docker（容器 list/logs/start/stop/rm）管理。
- **会话审计**：真实命令审计、在线监看 + 强制下线、会话统计/详情/审计时间线。
- **设置中心**：DB 持久化、注册表驱动、schema 驱动前端、热加载、集成探针（SMTP/KMS 等），仅超管。
- **通知中心** · 异步邮件 + 站内实时推送。

</details>

---

## ⚙️ 配置参考

完整示例见 [`configs/config.example.yaml`](configs/config.example.yaml)，主要配置节：

| 配置节 | 说明 |
| --- | --- |
| `server` / `db` / `redis` | 监听、PostgreSQL DSN、Redis |
| `auth` | JWT、引导管理员、`lockout` 锁定、`mfa`、`passkey`、`anomaly` 异常登录 |
| `crypto` | **KMS 信封加密**：`unseal_passphrase_file` 引导解封口令；KMS provider 存 DB 表 |
| `ai` | 开关、默认权限模式、最大迭代/子 Agent 深度、`ssh_exec_readonly_allow` 白名单、种子 Agent |
| `desktop` | `default_backend`(ironrdp/freerdp/dummy)、`recording`、`drive` 个人盘、`webrtc`(codec/bitrate/ICE)、`devolutions_gateway` |
| `protocols` | `guacamole` / `dbcli` / `tcpfwd` / `telnet` 各自开关 |
| `office` | OnlyOffice 在线编辑（document_server_url / jwt_secret / callback） |
| `insights` | 系统遥测开关与缓存 TTL |
| `anonymous` | 匿名沙箱镜像、TTL、CPU/内存/PID 限额、网络隔离 |
| `recorder` / `audit` / `webssh` / `sshpool` / `notify` / `storage` | 录像/审计背压、WS 缓冲、SSH 池、邮件、会话目录 |

所有配置均可用 `WAYFORT_` 前缀环境变量覆盖（`.`→`_`），例如 `WAYFORT_DB_DSN`、`WAYFORT_REDIS_ADDR`。

---

## 📡 API 概览

后端全部挂在 `/api/v1`，鉴权三选一（按优先级）：HTTP Header `Authorization: Bearer <token>` · Query `?token=` · WS 子协议 `bearer.<token>`。

<details>
<summary><b>认证 / 自助 / SSH 工具</b></summary>

- `auth/*`：login、login/totp、login/email-otp、login/recovery、login/passkey/{begin,finish}、refresh、logout、anonymous、providers、oidc/:p/{login,callback}
- `me/*`：profile、password、mfa（totp/恢复码）、passkeys、favorites、recent-nodes、login-history、nodes、access
- `me/*`（终端增强）：snippets、command-history、terminal-profile、ssh-keys、known-hosts、bulk-runs

</details>

<details>
<summary><b>用户 / 组织 / 授权</b></summary>

- `users`（CRUD、stats、bulk、reset-password、unlock、force-logout、roles、tags）
- `roles` · `permissions` · `departments`(+tree/parent/members) · `groups`(+parent/members)
- `nodes`(+test) · `credentials`(+usage/test) · `proxies`(+chains/validate、chains/test、chain-templates)
- `asset-groups`(+nodes/parent) · `tags` · `tag-groups` · `asset-grants`(+batch) · `access/by-{grantee,subject}` · `oidc-clients`

</details>

<details>
<summary><b>会话 / 文件 / 运维 / 桌面</b></summary>

- `sessions`(+stats/:id/audit/terminate/recording/cast)
- `nodes/:id/sftp/*`（ls/stat/mkdir/rm/upload/download/rename/chmod/read/write/search/copy/archive/office）
- `nodes/:id/oss/*`（buckets/objects/stat/download/preview/upload/mkdir/copy/office）· `oss/discover`
- `nodes/:id/insights/*`（system/processes/network）· `nodes/:id/firewall/*` · `nodes/:id/docker/*`
- `desktop/sessions`(+stats/bootstrap) · `desktop/drive/*`（list/upload/download/mkdir/rename）

</details>

<details>
<summary><b>DB Studio / 审批 / AI / 设置 / KMS</b></summary>

- `nodes/:id/db/*`：capabilities、ping、databases、schema、columns、indexes、foreign_keys、triggers、stats、ddl、rows、column_stats、export、query、query-multi、exec、explain、row/{insert,update,delete}、processes、kill
- `approvals/*`：创建/列表/preflight/overview/stats/stream、tasks(inbox/me/bulk/:id/{approve,reject,delegate})、grants(mine/check/release/revoke)、templates、subscriptions、audit
- `ai/*`：providers(+test/models)、agents、tools、conversations(+search/stream/cancel/export.md)、conversations/:id/messages、invocations/:id/{approve,reject,answer}
- `settings/*`：schema、update、reset、integrations(+test)、audits · `setup/kms/*`：status、CRUD、test、promote、rewrap

</details>

<details>
<summary><b>WebSocket 端点</b></summary>

| 路径 | 说明 |
| --- | --- |
| `/api/v1/ws/ssh/:node_id` | SSH 终端（`webssh.v1`） |
| `/api/v1/ws/telnet/:node_id` | Telnet 终端 |
| `/api/v1/ws/rdp/:node_id` · `/ws/vnc/:node_id` | Guacamole 图形（启用时） |
| `/api/v1/ws/v2/desktop/:session_id` | WebRDP 新栈数据通道（二进制帧 + WebRTC 信令） |
| `/api/v1/ws/dbcli/:node_id` | 数据库 CLI |
| `/api/v1/ws/tcp/:node_id` | TCP 二进制隧道 |
| `/api/v1/ws/ssh/anonymous` | 匿名沙箱 |

</details>

---

## 📂 项目结构

```
wayfort/
├── cmd/
│   ├── wayfort/                # 主网关：DI 装配、errgroup、信号、引导管理员
│   └── freerdp-worker/         # WebRDP worker（CGO + libfreerdp + libvpx/libaom + WebRTC 编码）
├── internal/
│   ├── server/                 # Gin engine、路由(routes.go)、中间件、优雅停机
│   ├── auth/                   # JWT、Local/OIDC、MFA、Passkey、RBAC resolver、黑名单、锁定
│   ├── secrets/                # KMS 信封加密：bootstrap、provider、DEK 轮转、审计
│   ├── asset/                  # 资产授权三维矩阵 + 双向穿透
│   ├── approval/               # 审批工作流引擎、策略、签名账本、S3 归档
│   ├── ai/                     # AI 助手：provider/handler/runner/tools/bridge
│   ├── desktop/                # WebRDP：freerdp/ironrdp 后端、WebRTC、录像、个人盘
│   ├── dbquery/                # DB Studio：适配器、introspection、EXPLAIN、导出
│   ├── protocols/{guacamole,dbcli,tcpfwd,telnet,oss}/   # 各协议适配
│   ├── webssh/                 # WebSocket SSH/Telnet 网关 + 命令审计 + 增强
│   ├── sftp/ · office/         # SFTP + 高级预览 / OnlyOffice 集成
│   ├── insights/ · firewall/ · docker/ · dockerx/      # 遥测与运维面板
│   ├── anonymous/ · socks5/ · sshpool/ · dialer/ · ssh/ # 沙箱、SOCKS5、SSH 池、代理链
│   ├── settings/ · notify/ · mfa/ · passkey/ · anomaly/ # 设置中心、通知、安全
│   ├── audit/ · model/ · repo/ · cache/ · config/      # 审计、模型、仓储、缓存、配置
│   └── api/                    # REST handlers
├── web/                        # Next.js 16 控制台（App Router）
├── deployments/                # Dockerfile · docker-compose.yaml
├── scripts/                    # build-worker-*（freerdp）· install-devolutions-gateway-*
└── configs/config.example.yaml
```

---

## 🐳 部署

### Docker Compose（开发/演示）

```bash
docker compose -f deployments/docker-compose.yaml up -d
```

包含：**PostgreSQL 16** · **Redis 7** · 测试 OpenSSH（`testuser/testpass` @2222）· **Guacamole guacd 1.5.5** · **OnlyOffice Document Server**（在线 Office，JWT 默认开启，密钥须与 `office.jwt_secret` 一致）· 应用本身（:8080）。

### 二进制部署

```bash
# 后端
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o wayfort ./cmd/wayfort
./wayfort --config /etc/wayfort/config.yaml

# WebRDP freerdp worker（需 libfreerdp 3.x，按平台选脚本）
bash scripts/build-worker-linux.sh        # Linux
bash scripts/build-worker-darwin.sh       # macOS
pwsh scripts/build-worker-windows.ps1     # Windows（MSYS2 ucrt64）

# 前端
docker build -t wayfort-web ./web
docker run -d -p 3000:3000 -e BACKEND_HTTP_URL=http://app:8080 \
  -e NEXT_PUBLIC_BACKEND_WS_URL=wss://your.domain wayfort-web
```

### 生产注意事项

| 事项 | 建议 |
| --- | --- |
| JWT 密钥 | `openssl rand -base64 48` |
| 凭据加密 | 用真实 KMS（Vault/AWS/Azure/GCP），妥善备份 `unseal_passphrase_file` |
| TLS / 反代 | 前置 Nginx/Caddy/Traefik，`proxy_read_timeout ≥ 1h`（WS 长连） |
| WebRTC | NAT 环境配 `desktop.webrtc.{stun_urls,turn_url,public_ip}` |
| 日志 | zap 输出 JSON，接 Loki/ELK |
| 录像 | 长期归档建议对象存储（S3/OSS） |

---

## 🧪 测试

```bash
go test ./...                         # 全部
go test ./internal/desktop/... -v     # 单包（如 RDP 连接选项/录像）
cd web && pnpm typecheck              # 前端类型检查（tsc）
```

代表性测试：`internal/desktop`（连接选项预设、录像背压、二进制帧）、`internal/protocols/{guacamole,tcpfwd,telnet}`、`internal/settings`（编解码）、`internal/socks5` 等。

---

## 🤝 贡献指南

欢迎 Issue 与 PR！提交前请

```bash
go fmt ./... && go vet ./... && go test ./... -count 1
cd web && pnpm typecheck
```

提交信息遵循 Conventional Commits：`feat:` / `fix:` / `refactor:` / `docs:` / `test:` / `chore:`。

---

## 📜 License

[MIT](LICENSE) © Wayfort contributors

## 🙏 致谢

[Gin](https://github.com/gin-gonic/gin) · [GORM](https://gorm.io/) · [pion/webrtc](https://github.com/pion/webrtc) · [FreeRDP](https://www.freerdp.com/) · [IronRDP / Devolutions Gateway](https://github.com/Devolutions/IronRDP) · [Apache Guacamole](https://guacamole.apache.org/) · [Next.js](https://nextjs.org/) · [shadcn/ui](https://ui.shadcn.com/) · [xterm.js](https://xtermjs.org/) · [OnlyOffice](https://www.onlyoffice.com/) · [JumpServer](https://github.com/jumpserver/jumpserver)（设计思路参考）

<div align="center">

**🌐 官网 · [wayfort.karpov.cn](https://wayfort.karpov.cn/)**
**💬 社区 · [Linux.do](https://linux.do/)**

如果 Wayfort 对你有帮助，欢迎点一个 ⭐ Star！欢迎到 [Linux.do 社区](https://linux.do/) 交流讨论！

</div>
