<#
  Wayfort 原生 Windows 部署(无 Docker)—— Phase 1:构建 + 组装 + 本地进程跑起来。
  Phase 2(Windows 服务化 + Inno Setup 安装包)在此之上再做。

    ./scripts/wayfort-windows.ps1 build     # 编译 wayfort.exe / freerdp-worker.exe / web,下载并组装依赖到 dist\windows\
    ./scripts/wayfort-windows.ps1 init      # 初始化 Postgres 数据目录 + 生成密钥/配置(幂等)
    ./scripts/wayfort-windows.ps1 start     # 启动 postgres/redis/wayfort/web/caddy(后台进程)
    ./scripts/wayfort-windows.ps1 stop      # 停止上述进程
    ./scripts/wayfort-windows.ps1 status    # 查看状态
    ./scripts/wayfort-windows.ps1 all       # build + init + start

  ⚠️ 这是首版脚手架,需在你的 Windows 机器上迭代:
     · 顶部「可配置版本/下载地址」请按当前实际版本核对(上游 URL 会变)。
     · freerdp-worker.exe 依赖 MSYS2 ucrt64 的 libfreerdp 等 DLL —— build 会调用现有
       scripts/build-worker-windows.ps1 编译,并尝试把 ucrt64\bin 下的依赖 DLL 收集到
       dist\windows\(用 ldd/objdump 或直接全量拷贝运行时 DLL;见 collect-worker-dlls)。
     · Redis 无官方 Windows 版:默认用社区 redis-windows(tporadowski,Redis 5.x,足够 wayfort 用);
       生产可换 Memurai。见 $RedisUrl。
#>
#Requires -Version 7.0
$ErrorActionPreference = 'Stop'

# ───────────────────────── 可配置:版本 / 下载地址(按需核对/调整)─────────────────────────
$NodeVersion   = '22.22.3'
$NodeUrl       = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$CaddyVersion  = '2.8.4'
$CaddyUrl      = "https://github.com/caddyserver/caddy/releases/download/v$CaddyVersion/caddy_${CaddyVersion}_windows_amd64.zip"
$PgVersion     = '16.4-1'   # EDB 免安装二进制 zip
$PgUrl         = "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip"
$RedisUrl      = 'https://github.com/tporadowski/redis/releases/download/v5.0.14.1/Redis-x64-5.0.14.1.zip'
$DgwVersion    = '2026.2.2'  # Devolutions Gateway,与 docker 版默认一致
# 服务包装器(Phase 2):用 WinSW(GitHub 托管,可靠)而非 nssm.cc(长期不稳,常 503)。
$WinswUrl      = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe'

# ───────────────────────── 路径 / 端口 ─────────────────────────
$Root      = Split-Path -Parent $PSScriptRoot               # 仓库根
$Dist      = Join-Path $Root 'dist\windows'                 # 组装产物根(= 运行时工作目录)
$WinDir    = Join-Path $Root 'deployments\windows'          # 配置模板所在
$EnvFile   = Join-Path $Dist '.env'
$WebPort   = if ($env:WAYFORT_WEB_PORT) { $env:WAYFORT_WEB_PORT } else { '18080' }  # 避开 Windows 保留段
$PublicHost= 'localhost'
$WsScheme  = 'ws'
$PubScheme = 'http'

function Die($m)  { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }
function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Step($m) { Write-Host "→ $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "⚠ $m" -ForegroundColor Yellow }

function New-HexSecret([int]$Bytes) {
  # Create().GetBytes([byte[]]) 绑定可靠;Fill 取 Span<byte>,PowerShell 无法从 byte[] 绑定。
  $b = [byte[]]::new($Bytes)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  -join ($b | ForEach-Object { $_.ToString('x2') })
}

# 下载并解压一个 zip 到目标目录(若已存在则跳过,加 -Force 重下)。
function Get-Zip([string]$Url, [string]$DestDir, [switch]$Force) {
  if ((Test-Path $DestDir) -and -not $Force) { Write-Host "  (已存在,跳过) $DestDir"; return }
  $tmp = New-TemporaryFile
  Step "下载 $Url"
  Invoke-WebRequest -Uri $Url -OutFile $tmp -UseBasicParsing -MaximumRetryCount 4 -RetryIntervalSec 3
  if (Test-Path $DestDir) { Remove-Item -Recurse -Force $DestDir }
  New-Item -ItemType Directory -Force $DestDir | Out-Null
  Expand-Archive -Path $tmp -DestinationPath $DestDir -Force
  Remove-Item $tmp -Force
}

# robocopy 包装:稳健递归复制(处理深目录 / 长路径,Copy-Item -Recurse 在这两点上不可靠)。
# robocopy 成功退出码是 0-7,>=8 才是真失败;复制完把 LASTEXITCODE 归零,避免污染后续判断。
function Robo([string]$Src, [string]$Dst, [string[]]$Flags) {
  $ra = @($Src, $Dst) + $Flags + @('/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1')
  & robocopy @ra | Out-Null
  if ($LASTEXITCODE -ge 8) { Die "robocopy 失败($Src → $Dst,退出码 $LASTEXITCODE)" }
  $global:LASTEXITCODE = 0
}
function Copy-Tree([string]$Src, [string]$Dst)   { Robo $Src $Dst @('/E') }    # 追加复制
function Mirror-Tree([string]$Src, [string]$Dst) { Robo $Src $Dst @('/MIR') }  # 镜像(清旧 + 复制)

# 定位 GNU tar(git-for-windows / MSYS2 自带)。必须用 GNU tar:它的 -h 能**完整**跟随符号
# 链接落成真实文件;Windows 自带的 bsdtar(System32\tar.exe)只部分解引用,会残留目录符号链接。
function Find-GnuTar {
  $c = @()
  $git = (Get-Command git -ErrorAction SilentlyContinue).Source
  if ($git) { $c += (Join-Path (Split-Path (Split-Path $git)) 'usr\bin\tar.exe') }
  $c += "$env:ProgramFiles\Git\usr\bin\tar.exe", "${env:ProgramFiles(x86)}\Git\usr\bin\tar.exe"
  if ($env:MSYS2_ROOT) { $c += (Join-Path $env:MSYS2_ROOT 'usr\bin\tar.exe') }
  $c += 'C:\msys64\usr\bin\tar.exe'
  $c | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

# ───────────────────────── build:编译 + 组装 ─────────────────────────
function Invoke-Build {
  New-Item -ItemType Directory -Force $Dist | Out-Null
  # 上次 build 的二进制若还在运行,会锁住 wayfort.exe 等,导致 go build -o / 覆盖失败 → 先停。
  if (Test-Path (Join-Path $Dist 'wayfort.exe')) { Invoke-Stop }

  Step '编译后端 wayfort.exe(纯 Go)'
  & go build -trimpath -ldflags='-s -w' -o (Join-Path $Dist 'wayfort.exe') ./cmd/wayfort
  if ($LASTEXITCODE -ne 0) { Die 'go build wayfort 失败' }

  Step '编译 freerdp-worker.exe(CGO + MSYS2 libfreerdp)'
  # 复用现有脚本:把 worker 装到 dist 根,与 wayfort.exe 同目录(bootstrap_paths 会发现它)。
  & "$PSScriptRoot\build-worker-windows.ps1" -InstallDir $Dist
  if ($LASTEXITCODE -ne 0) { Warn 'freerdp-worker 构建失败 —— 见 scripts/build-worker-windows.ps1(需 MSYS2 ucrt64)。freerdp 后端将不可用,但其余功能不受影响。' }
  Collect-WorkerDlls

  Step '内置 Devolutions Gateway(ironrdp)'
  & "$PSScriptRoot\install-devolutions-gateway-windows.ps1" -InstallPrefix (Join-Path $Dist 'devolutions-gateway') -Version $DgwVersion
  if ($LASTEXITCODE -ne 0) { Warn 'Devolutions Gateway 安装失败 —— ironrdp 后端将不可用;freerdp 仍可用。' }

  Step '构建前端(Next.js,生产)'
  Push-Location (Join-Path $Root 'web')
  try {
    & corepack enable
    # 用 hoisted 链接器装依赖:isolated 下 Next standalone 的 .pnpm 符号链接链较深,tar 解引用
    # 时可能踩到未随包的目标而失败;hoisted 让 standalone 的符号链接干净、可被 tar --dereference
    # 解引用成真实文件。pnpm 11 不读 .npmrc 的 node-linker,故用 --config.node-linker=hoisted
    # (仅本次调用,不写配置 → Docker 构建不受影响)。pnpm 对已存在的 isolated node_modules 会判
    # 「已最新」而不重链,所以先把 isolated 的清空。
    $nm = Join-Path $Root 'web\node_modules'
    $react = Join-Path $nm 'react'
    if ((Test-Path $react) -and (((Get-Item -LiteralPath $react -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      Step '现有 node_modules 为 isolated(符号链接)→ 清空,改用 hoisted 重装'
      $empty = Join-Path ([System.IO.Path]::GetTempPath()) ("wf_empty_" + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Force $empty | Out-Null
      Mirror-Tree $empty $nm
      Remove-Item -Recurse -Force $nm -ErrorAction SilentlyContinue
      Remove-Item -Recurse -Force $empty -ErrorAction SilentlyContinue
    }
    & pnpm install --frozen-lockfile --config.node-linker=hoisted
    if ($LASTEXITCODE -ne 0) { Die 'pnpm install 失败' }
    $env:NEXT_PUBLIC_BACKEND_WS_URL = "$WsScheme`://$PublicHost`:$WebPort"
    $env:NEXT_PUBLIC_APP_VERSION = 'windows'
    $env:NEXT_TELEMETRY_DISABLED = '1'
    & pnpm run build
    if ($LASTEXITCODE -ne 0) { Die 'pnpm build 失败' }
  } finally { Pop-Location }
  # 组装 web:用 Next standalone 产物(自带精简 node_modules + server.js),体积远小于完整
  # node_modules(~100-200MB vs ~1.1GB),避免安装包超 Inno 4.2GB 上限。standalone 不含
  # static / public,需手动并入。
  $webDst = Join-Path $Dist 'web'
  if (Test-Path $webDst) { Remove-Item -Recurse -Force $webDst -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Force $webDst | Out-Null
  $standalone = Join-Path $Root 'web\.next\standalone'
  if (-not (Test-Path (Join-Path $standalone 'server.js'))) {
    Die '未找到 web\.next\standalone\server.js —— 确认 next.config 已设 output: "standalone" 且 build 成功。'
  }
  # standalone 的 node_modules 含 Next 生成的符号链接;Windows 直接复制需「创建符号链接」特权,
  # 非管理员会 ERROR 5 拒绝访问(robocopy 与 Copy-Item 都会失败)。改用 tar -h 解引用复制:
  # 把符号链接落成真实文件,得到自包含真实文件树(实测约 48MB、0 符号链接)。tar(bsdtar)
  # 随 Windows 10+ 内置。
  $gnuTar = Find-GnuTar
  if (-not $gnuTar) {
    Die "未找到 GNU tar。需要它来解引用 Next standalone 的符号链接(Windows 自带 bsdtar 解引用不完整)。请安装 Git for Windows(自带 usr\bin\tar.exe)或 MSYS2 后重试。"
  }
  $tarTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("wf_sa_" + [guid]::NewGuid().ToString('N') + ".tar")
  # GNU tar -h 完整跟随符号链接 → 落成真实文件;--force-local 让它把 C:\... 当本地路径
  # (否则 GNU tar 会把盘符冒号误判为远程主机 host:path)。
  & $gnuTar --force-local -c -h -f $tarTmp -C $standalone .
  if ($LASTEXITCODE -ne 0) { Die 'GNU tar 打包 standalone 失败' }
  & $gnuTar --force-local -x -f $tarTmp -C $webDst
  if ($LASTEXITCODE -ne 0) { Die 'GNU tar 解包 standalone 失败' }
  Remove-Item -Force $tarTmp -ErrorAction SilentlyContinue
  # standalone 不含 static / public,需并入(均为真实文件,robocopy 即可)。
  New-Item -ItemType Directory -Force (Join-Path $webDst '.next') | Out-Null
  Copy-Tree (Join-Path $Root 'web\.next\static') (Join-Path $webDst '.next\static')
  if (Test-Path (Join-Path $Root 'web\public')) { Copy-Tree (Join-Path $Root 'web\public') (Join-Path $webDst 'public') }

  # Next standalone 的 NFT 文件跟踪会漏拷部分带 exports 子路径 / 动态 require 的包(实测:
  # @swc/helpers、@next/env、sharp 及其 @img 原生子包、client-only、detect-libc),standalone
  # 里只剩一个 package.json → 运行时报 Cannot find module '.../cjs/_interop_require_default.cjs'。
  # 用完整安装(hoisted 的 web\node_modules)把这些「顶层只剩 package.json」的包补全。
  # 只查顶层包目录(node_modules\pkg 与 \@scope\pkg),避开 @swc/helpers\_ 下的合法重定向 stub
  # (那些本就只有 package.json,内容指向 ../../cjs|esm)。
  Step 'standalone 漏拷修复:用完整安装补全被 NFT 漏掉的包'
  $dstNm = Join-Path $webDst 'node_modules'
  $srcNm = Join-Path $Root 'web\node_modules'
  $topPkgs = @()
  Get-ChildItem -LiteralPath $dstNm -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -like '@*') { Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue | ForEach-Object { $topPkgs += $_.FullName } }
    else { $topPkgs += $_.FullName }
  }
  $fixed = 0
  foreach ($pkgDir in $topPkgs) {
    $kids = Get-ChildItem -LiteralPath $pkgDir -Force -ErrorAction SilentlyContinue
    if ($kids.Count -eq 1 -and $kids[0].Name -eq 'package.json') {
      $rel  = $pkgDir.Substring($dstNm.Length).TrimStart('\')
      $full = Join-Path $srcNm $rel
      if ((Test-Path $full) -and ((Get-ChildItem -LiteralPath $full -Force -ErrorAction SilentlyContinue).Count -gt 1)) {
        Copy-Tree $full $pkgDir
        Step "  补全 $rel"
        $fixed++
      }
    }
  }
  Step "standalone 漏拷修复完成:补全 $fixed 个包"

  Step '下载并组装运行时依赖(Node / Caddy / Postgres / Redis / WinSW)'
  Get-Zip $NodeUrl  (Join-Path $Dist 'node')
  Get-Zip $CaddyUrl (Join-Path $Dist 'caddy')
  Get-Zip $PgUrl    (Join-Path $Dist 'pgsql')
  # 瘦身 Postgres:删运行时用不到的头文件 / 文档 / 调试符号。
  foreach ($d in 'include','doc','symbols') {
    Get-ChildItem -Path (Join-Path $Dist 'pgsql') -Filter $d -Recurse -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
  }
  Get-Zip $RedisUrl (Join-Path $Dist 'redis')
  # WinSW(Phase 2 服务化用):单个 exe,直接下到 dist 根。
  $winsw = Join-Path $Dist 'winsw.exe'
  if (Test-Path $winsw) { Write-Host '  (已存在,跳过) winsw.exe' }
  else {
    Step "下载 WinSW $WinswUrl"
    Invoke-WebRequest -Uri $WinswUrl -OutFile $winsw -UseBasicParsing -MaximumRetryCount 4 -RetryIntervalSec 3
  }

  Step '拷入配置模板'
  New-Item -ItemType Directory -Force (Join-Path $Dist 'configs') | Out-Null
  Copy-Item -Force (Join-Path $WinDir 'config.windows.yaml') (Join-Path $Dist 'configs\config.yaml')
  Copy-Item -Force (Join-Path $WinDir 'Caddyfile') (Join-Path $Dist 'Caddyfile')

  Ok "组装完成 → $Dist"
}

# freerdp-worker.exe 的运行时 DLL(libfreerdp3 / winpr3 / libvpx / libaom / turbojpeg 及其
# 传递依赖)从 MSYS2 ucrt64\bin 收集到 dist 根,使 worker 脱离 MSYS2 也能跑。
function Collect-WorkerDlls {
  $ucrt = if ($env:MSYS2_ROOT) { Join-Path $env:MSYS2_ROOT 'ucrt64\bin' } else { 'C:\msys64\ucrt64\bin' }
  if (-not (Test-Path $ucrt)) { Warn "未找到 MSYS2 ucrt64\bin($ucrt);freerdp-worker.exe 可能缺 DLL。设 MSYS2_ROOT 或手动拷 DLL。"; return }
  $worker = Join-Path $Dist 'freerdp-worker.exe'
  if (-not (Test-Path $worker)) { return }
  # 简化:把 worker 直接/间接依赖的常见库前缀全量拷过去(libfreerdp/libwinpr/libvpx/libaom/
  # libturbojpeg/zlib/libcrypto/libssl/libcjson/libwinpr-tools 及 gcc/iconv 运行时)。
  $patterns = 'libfreerdp*','libwinpr*','libvpx*','libaom*','libturbojpeg*','libjpeg*','zlib*','libcrypto*','libssl*','libcjson*','libusb*','libssh2*','libwinpr-tools*','libgcc_s_seh*','libstdc++*','libwinpthread*','libiconv*','libintl*','libcairo*','libpng*','libffi*','libfontconfig*','libfreetype*','libgcrypt*','libgpg-error*','libxml2*','liblzma*','libbz2*','libbrotli*','libzstd*','libsdl2*','libavutil*','libavcodec*','libswscale*'
  foreach ($p in $patterns) {
    Get-ChildItem -Path $ucrt -Filter "$p.dll" -ErrorAction SilentlyContinue |
      ForEach-Object { Copy-Item -Force $_.FullName $Dist }
  }
  Ok '已收集 freerdp-worker 运行时 DLL(若启动仍报缺 DLL,用 Dependencies/ldd 查漏)'
}

# ───────────────────────── init:数据目录 + 密钥 + 配置 ─────────────────────────
function Get-EnvValue([string]$Key) {
  if (-not (Test-Path $EnvFile)) { return '' }
  $m = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match "^$Key=" } | Select-Object -First 1
  if ($m) { return $m.Substring($Key.Length + 1) }
  return ''
}

function Invoke-Init {
  if (-not (Test-Path (Join-Path $Dist 'wayfort.exe'))) { Die '请先 build。' }
  New-Item -ItemType Directory -Force (Join-Path $Dist 'var\sessions') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $Dist 'var\devolutions-gateway') | Out-Null

  # 生成 .env(密钥 + 端口);已存在则保留(幂等,不轮换密钥)。
  if (-not (Test-Path $EnvFile)) {
    $pgPw = New-HexSecret 24
    @(
      "WEB_PORT=$WebPort"
      "PUBLIC_HOST=$PublicHost"
      "WS_SCHEME=$WsScheme"
      "PUBLIC_SCHEME=$PubScheme"
      "JWT_SECRET=$(New-HexSecret 32)"
      "POSTGRES_PASSWORD=$pgPw"
      "ADMIN_PASSWORD=$(New-HexSecret 12)"
      "OFFICE_JWT_SECRET=$(New-HexSecret 32)"
    ) | Set-Content -LiteralPath $EnvFile -Encoding utf8NoBOM
    Ok '已生成 dist\windows\.env(随机密钥)'
  }
  $pgPw = Get-EnvValue 'POSTGRES_PASSWORD'

  # 初始化 Postgres 数据目录(首次)。
  $pgData = Join-Path $Dist 'var\pgdata'
  $initdb = Join-Path $Dist 'pgsql\pgsql\bin\initdb.exe'   # EDB zip 解出多一层 pgsql\
  if (-not (Test-Path $initdb)) { $initdb = Join-Path $Dist 'pgsql\bin\initdb.exe' }
  if (-not (Test-Path $pgData)) {
    Step '初始化 PostgreSQL 数据目录'
    $pwFile = New-TemporaryFile
    Set-Content -LiteralPath $pwFile -Value $pgPw -NoNewline -Encoding ascii
    & $initdb -D $pgData -U wayfort -A scram-sha-256 --pwfile=$pwFile -E UTF8 --locale=C
    Remove-Item $pwFile -Force
    if ($LASTEXITCODE -ne 0) { Die 'initdb 失败' }
    # 监听 127.0.0.1 默认即可(本地);wayfort 用 wayfort 超级用户连。建库:
    Ok 'initdb 完成(库 wayfort 将在首次 start 后由下面的 createdb 建立)'
  }
  Ok 'init 完成。运行 start 启动整套。'
}

# ───────────────────────── start / stop / status ─────────────────────────
function Get-PgBin([string]$exe) {
  $a = Join-Path $Dist "pgsql\pgsql\bin\$exe"; if (Test-Path $a) { return $a }
  return Join-Path $Dist "pgsql\bin\$exe"
}

function Invoke-Start {
  if (-not (Test-Path $EnvFile)) { Die '请先 init。' }
  $pgData = Join-Path $Dist 'var\pgdata'
  $pgPw   = Get-EnvValue 'POSTGRES_PASSWORD'
  $jwt    = Get-EnvValue 'JWT_SECRET'
  $admin  = Get-EnvValue 'ADMIN_PASSWORD'
  $officeJwt = Get-EnvValue 'OFFICE_JWT_SECRET'

  Step '启动 PostgreSQL'
  & (Get-PgBin 'pg_ctl.exe') -D $pgData -l (Join-Path $Dist 'var\pg.log') -o '-p 5432' start
  # 确保库 wayfort 存在(幂等)。
  $env:PGPASSWORD = $pgPw
  & (Get-PgBin 'psql.exe') -h 127.0.0.1 -U wayfort -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='wayfort'" 2>$null | Out-String | ForEach-Object {
    if ($_ -notmatch '1') { & (Get-PgBin 'createdb.exe') -h 127.0.0.1 -U wayfort wayfort }
  }

  Step '启动 Redis'
  $redisExe = Get-ChildItem -Path (Join-Path $Dist 'redis') -Filter 'redis-server.exe' -Recurse | Select-Object -First 1
  Start-Process -FilePath $redisExe.FullName -ArgumentList '--port','6379','--appendonly','yes','--dir',(Join-Path $Dist 'var') -WindowStyle Hidden

  Step '启动后端 wayfort.exe'
  $env:WAYFORT_DB_DSN = "host=127.0.0.1 user=wayfort password=$pgPw dbname=wayfort port=5432 sslmode=disable"
  $env:WAYFORT_REDIS_ADDR = '127.0.0.1:6379'
  $env:WAYFORT_AUTH_JWT_SECRET = $jwt
  $env:WAYFORT_AUTH_BOOTSTRAP_PASSWORD = $admin
  $env:WAYFORT_OFFICE_JWT_SECRET = $officeJwt
  $env:WAYFORT_DESKTOP_DEVOLUTIONS_GATEWAY_ADVERTISED_URL = "$WsScheme`://$PublicHost`:$WebPort/jet/rdp"
  $env:WAYFORT_DESKTOP_DEVOLUTIONS_GATEWAY_EXTERNAL_URL    = "$PubScheme`://$PublicHost`:$WebPort"
  Start-Process -FilePath (Join-Path $Dist 'wayfort.exe') -ArgumentList '--config','configs\config.yaml' -WorkingDirectory $Dist -WindowStyle Hidden

  Step '启动前端(Next.js)'
  $node = Get-ChildItem -Path (Join-Path $Dist 'node') -Filter 'node.exe' -Recurse | Select-Object -First 1
  $env:BACKEND_HTTP_URL = 'http://127.0.0.1:8080'
  $env:NODE_ENV = 'production'
  $env:PORT = '3000'
  $env:HOSTNAME = '127.0.0.1'
  # Next standalone:直接 node server.js(端口/主机经 PORT/HOSTNAME 环境变量)。
  Start-Process -FilePath $node.FullName -ArgumentList 'server.js' -WorkingDirectory (Join-Path $Dist 'web') -WindowStyle Hidden

  Step '启动 Caddy 单一入口'
  $caddy = Get-ChildItem -Path (Join-Path $Dist 'caddy') -Filter 'caddy.exe' -Recurse | Select-Object -First 1
  $env:WAYFORT_SITE = ":$WebPort"
  Start-Process -FilePath $caddy.FullName -ArgumentList 'run','--config','Caddyfile','--adapter','caddyfile' -WorkingDirectory $Dist -WindowStyle Hidden

  Write-Host ''
  Ok "Wayfort 已启动 → http://$PublicHost`:$WebPort   (admin / $admin)"
  Warn '首启需等后端完成数据库迁移与引导(看 dist\windows\var\*.log)。'
}

function Invoke-Stop {
  Step '停止从 dist\windows 启动的进程'
  # 仅停可执行文件位于 $Dist 之下的进程,避免误杀机器上无关的 node/redis 等。
  $names = 'wayfort','caddy','redis-server','node','freerdp-worker','devolutions-gateway'
  Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.StartsWith($Dist, [System.StringComparison]::OrdinalIgnoreCase) } catch { $false }
  } | ForEach-Object { try { $_.Kill() } catch {} }
  # Postgres 由 pg_ctl 优雅停(Phase 1 用 pg_ctl 起的)。
  $pgData = Join-Path $Dist 'var\pgdata'
  if (Test-Path $pgData) { & (Get-PgBin 'pg_ctl.exe') -D $pgData stop -m fast 2>$null | Out-Null }
  Ok '已停止 dist\windows 下的进程'
}

function Invoke-Status {
  Get-Process -Name 'wayfort','caddy','redis-server','postgres','node','freerdp-worker','devolutions-gateway' -ErrorAction SilentlyContinue |
    Select-Object Name, Id, StartTime | Format-Table -AutoSize
}

# ───────────────────────── installer:用 Inno Setup 打成 WayfortSetup.exe ─────────────────────────
function Invoke-Installer {
  if (-not (Test-Path (Join-Path $Dist 'wayfort.exe'))) { Die '请先 build(dist\windows 未组装)。' }
  if (-not (Test-Path (Join-Path $Dist 'winsw.exe')))  { Warn 'dist\windows\winsw.exe 缺失 → 安装包内服务化会失败,建议先重跑 build。' }
  # 先停掉从 dist\windows 启动的进程,否则 ISCC 读取被占用的 exe 会报「文件正被占用」。
  Invoke-Stop
  Start-Sleep -Seconds 1   # 等文件句柄释放
  # 找 ISCC.exe(Inno Setup 6 编译器)。
  $iscc = (Get-Command iscc -ErrorAction SilentlyContinue)?.Source
  if (-not $iscc) {
    foreach ($p in @("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe")) {
      if (Test-Path $p) { $iscc = $p; break }
    }
  }
  if (-not $iscc) { Die '未找到 Inno Setup 的 ISCC.exe。请安装 Inno Setup 6:https://jrsoftware.org/isdl.php' }
  Step '编译安装包(Inno Setup)'
  $ver = (Get-Date -Format 'yyyy.MM.dd')
  & $iscc "/DMyAppVersion=$ver" (Join-Path $Root 'installer\wayfort.iss')
  if ($LASTEXITCODE -ne 0) { Die 'iscc 编译失败' }
  Ok "安装包已生成 → $(Join-Path $Root 'dist\WayfortSetup.exe')"
}

# ───────────────────────── dispatch ─────────────────────────
$cmd = if ($args.Count -ge 1) { $args[0] } else { 'all' }
switch ($cmd) {
  'build'     { Invoke-Build }
  'init'      { Invoke-Init }
  'start'     { Invoke-Start }
  'stop'      { Invoke-Stop }
  'status'    { Invoke-Status }
  'installer' { Invoke-Installer }                 # build 之后:打成 WayfortSetup.exe
  'package'   { Invoke-Build; Invoke-Installer }    # 一步:组装 + 打安装包
  'all'       { Invoke-Build; Invoke-Init; Invoke-Start }
  default     { Die "未知命令:$cmd(build|init|start|stop|status|installer|package|all)" }
}
