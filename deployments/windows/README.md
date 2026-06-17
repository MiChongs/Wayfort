# Wayfort 原生 Windows 部署(无 Docker)

把整套系统作为**本地进程**跑在 Windows 上,不依赖 Docker。分两阶段推进:

- **Phase 1**:构建 + 组装 + 以后台进程跑起来,先验证原生栈能跑通。
- **Phase 2(已就绪)**:用 WinSW(GitHub 托管的服务包装器)把各进程注册成 **Windows 服务**,
  用 **Inno Setup** 打成 `WayfortSetup.exe`(开始菜单/桌面快捷方式、首启 initdb+密钥、注册并启动服务、卸载)。

> ⚠️ 这是首版脚手架,**需在你的 Windows 机器上迭代**(我无法在此远程构建/测试 Windows 安装)。
> 脚本顶部的版本号/下载地址、freerdp DLL 收集、Redis 选型等都可能要按你的环境调整。

## 拓扑(全部本地进程,单一入口)

```
浏览器 ─▶ Caddy :18080 ┬ /api/v1/* ─▶ wayfort.exe 127.0.0.1:8080  (后端 / WebSocket / freerdp)
        (唯一对外)     ├ /jet/*    ─▶ devolutions-gateway.exe :7171 (ironrdp)
                       └ 其余       ─▶ Next.js (node) 127.0.0.1:3000
   wayfort.exe ─▶ PostgreSQL :5432 / Redis :6379 / freerdp-worker.exe(按需拉起)
```

## 前置要求(构建机)

- **Go**(编译 `wayfort.exe`)、**Node + pnpm/corepack**(构建前端)。
- **MSYS2 + ucrt64 的 libfreerdp**(编译 `freerdp-worker.exe`;见 `scripts/build-worker-windows.ps1`)。
  没有它则 freerdp 后端不可用,但 SSH/SFTP/DB/ironrdp 等仍可用。
- 联网(下载 Node/Caddy/PostgreSQL/Redis/Devolutions Gateway 运行时)。

## 用法

```powershell
# 一步到位(构建 + 初始化 + 启动)
./scripts/wayfort-windows.ps1 all

# 或分步
./scripts/wayfort-windows.ps1 build    # 编译 + 下载组装到 dist\windows\
./scripts/wayfort-windows.ps1 init     # 初始化 Postgres 数据目录 + 生成密钥/配置(幂等)
./scripts/wayfort-windows.ps1 start    # 启动整套
./scripts/wayfort-windows.ps1 status   # 看进程
./scripts/wayfort-windows.ps1 stop     # 停止
```

启动后打开 **http://localhost:18080**,用 `admin` + `dist\windows\.env` 里的 `ADMIN_PASSWORD` 登录。

## 组装产物(`dist\windows\`)

| 组件 | 来源 | 说明 |
|---|---|---|
| `wayfort.exe` | `go build`(纯 Go) | 后端网关 |
| `freerdp-worker.exe` (+ DLL) | `build-worker-windows.ps1` + MSYS2 ucrt64 | freerdp WebRDP;DLL 由 `Collect-WorkerDlls` 收集 |
| `devolutions-gateway\*.exe` | `install-devolutions-gateway-windows.ps1` | ironrdp WebRDP |
| `web\` (+ `node\`) | `pnpm build`(**standalone** 产物)+ 便携 Node | Next.js 生产服务,`node server.js` 启动 |
| `caddy\caddy.exe` | 官方 release | 单一入口反代 |
| `pgsql\` | EDB 免安装二进制 zip | PostgreSQL |
| `redis\` | 社区 redis-windows(默认 Redis 5.x) | 见下「Redis 选型」 |
| `configs\config.yaml` | `config.windows.yaml` | 后端配置(WAYFORT_* 注入密钥/地址) |
| `.env` | `init` 生成 | 密钥 + 端口(本地,勿提交) |

## 需要在你机器上确认/迭代的点

1. **下载地址/版本**:脚本顶部 `$NodeVersion/$NodeUrl/$CaddyUrl/$PgUrl/$RedisUrl/$DgwVersion` 按当前实际核对(上游 URL 会变)。
2. **freerdp-worker 的 DLL**:`Collect-WorkerDlls` 从 `C:\msys64\ucrt64\bin`(或 `$env:MSYS2_ROOT`)全量拷常见依赖。
   若 `freerdp-worker.exe` 启动报缺 DLL,用 [Dependencies](https://github.com/lucasg/Dependencies) 查漏后补拷。
3. **Redis 选型**:默认社区 `redis-windows`(tporadowski,Redis 5.x,足够 wayfort 用)。
   生产建议换 **Memurai**(Redis 兼容、Windows 原生、有免费 Developer 版,注意其许可)。改 `$RedisUrl` 即可。
4. **端口**:默认 `18080`(避开 Windows 保留段 ~7999–8098)。改端口需重新 `build`(WS 地址在前端构建期烤入)。
5. **Postgres 路径**:EDB zip 解出多一层 `pgsql\`,脚本已兼容 `pgsql\pgsql\bin` 与 `pgsql\bin`。

## 与 Docker 版的差异

- **guacamole/guacd 关闭**(Windows 无 guacd):RDP/VNC 走新版 WebRDP(freerdp / ironrdp)。
- **匿名沙箱 / DB CLI 容器关闭**(需 Docker)。
- 服务地址全部 `127.0.0.1`;路径相对 `dist\windows\`(运行时工作目录)。

## Phase 2:打成 `WayfortSetup.exe`(已就绪)

前置:本机装 [Inno Setup 6](https://jrsoftware.org/isdl.php)(提供 `ISCC.exe`)。

```powershell
./scripts/wayfort-windows.ps1 build       # 先组装 dist\windows\(含 winsw.exe)
./scripts/wayfort-windows.ps1 installer   # 用 Inno Setup 编译 → dist\WayfortSetup.exe
# 或一步:
./scripts/wayfort-windows.ps1 package
```

把 `dist\WayfortSetup.exe` 拷到目标机器双击安装(需管理员):

- 释放到 `C:\Program Files\Wayfort`;
- 调 `install\setup-windows-service.ps1 -Install`:`initdb` + 生成密钥(`.env`)+ 用 **WinSW** 注册 5 个
  自启服务(`WayfortPostgres → WayfortRedis → WayfortGateway → WayfortWeb → WayfortCaddy`,崩溃自动重启,
  以 `NetworkService` 运行并对 `var\` 授权)+ 建库 + 启动;
- 建开始菜单/桌面快捷方式(打开 http://localhost:18080);
- **卸载**:停止并移除服务;`var\`(数据库/会话/密钥)与 `.env` 默认保留,需彻底清除请手动删安装目录。

服务管理:`sc query WayfortGateway`、`sc stop/start WayfortGateway`(或 `{安装目录}\svc\WayfortGateway.exe restart`);
日志在 `{安装目录}\var\logs\` 与 `{安装目录}\svc\<服务>.out.log`。

> ⚠️ Phase 2 同样需在真机迭代,最易踩坑:**Postgres 以服务运行的账户/权限**(本实现统一用
> `NetworkService` + 对 `var\` 授 icacls);服务启动**时序**(wayfort 早于 Postgres 就绪时会崩溃重启,
> 由 WinSW 自动拉起直到建库完成);PowerShell 兼容性(安装脚本已按 **5.1** 写,免装 pwsh7)。

## 可选简化(未做)

把前端 `go:embed` 进 `wayfort.exe`(静态导出 + 把 `/api/proxy` 转发搬进 Go),即可去掉 Node + Caddy
两个服务,Windows 服务从 5 个减到 3 个(Postgres / Redis / Wayfort),安装包更小更稳。属一次重构。
