<#
  Wayfort 原生 Windows —— Phase 2:把组装好的 bundle 注册成 Windows 服务并启动 / 卸载。
  由 Inno Setup 安装包在「安装后」与「卸载时」调用,也可手动运行做调试。

    setup-windows-service.ps1 -Install   -InstallDir "C:\Program Files\Wayfort"
    setup-windows-service.ps1 -Uninstall -InstallDir "C:\Program Files\Wayfort"

  用 WinSW(GitHub 托管的服务包装器,声明式 XML)把 5 个进程注册成自启服务(崩溃自动重启):
    WayfortPostgres → WayfortRedis → WayfortGateway → WayfortWeb → WayfortCaddy
  服务以 NT AUTHORITY\NetworkService(非管理员)运行 —— PostgreSQL 拒绝以管理员令牌启动,
  故统一用 NetworkService(WinSW 的 allowservicelogon 自动授权)。
  存储遵循 Windows 规范:二进制在 Program Files\Wayfort(只读),全部可变数据(数据库 /
  密钥 / 会话 / 日志 / 服务日志 / 生效配置)在 C:\ProgramData\Wayfort,并对其授 NetworkService 写权限。
  WinSW v2 约定:每个服务一份 <Id>.xml + 一个同名 <Id>.exe(WinSW 自身复制本)。

  ⚠️ 首版:服务账户/权限/时序是最易踩坑处(尤其 Postgres),需在真机上迭代。
  本脚本兼容 Windows PowerShell 5.1(安装机自带),不用 pwsh7 专属语法。
#>
[CmdletBinding()]
param(
  [switch]$Install,
  [switch]$Uninstall,
  [string]$InstallDir
)
$ErrorActionPreference = 'Stop'

if (-not $InstallDir) { $InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$App      = (Resolve-Path $InstallDir).Path   # 只读程序文件根(Program Files\Wayfort)
$Winsw    = Join-Path $App 'winsw.exe'
# Windows 规范:数据库 / 密钥 / 会话 / 日志 / 服务日志 / 生效配置 这些可变数据放 ProgramData,
# 绝不放 Program Files(只读、受保护)。运行时状态统一落在 $DataRoot 下。
$DataRoot   = Join-Path $env:ProgramData 'Wayfort'    # = C:\ProgramData\Wayfort
$SvcDir     = Join-Path $DataRoot 'svc'               # 每服务 <Id>.exe + <Id>.xml + WinSW 日志
$EnvFile    = Join-Path $DataRoot '.env'              # 随机密钥
$ConfigSrc  = Join-Path $App 'configs\config.yaml'    # 安装包内只读默认配置(模板)
$ConfigFile = Join-Path $DataRoot 'config.yaml'       # 生效配置(管理员可改,重装保留)
$VarDir     = Join-Path $DataRoot 'var'
$PgData     = Join-Path $VarDir 'pgdata'
$Account  = 'NT AUTHORITY\NetworkService'   # icacls 授权用完整名
# WinSW v2 的 <serviceaccount> 用 <domain>+<user> 两个元素(v3 才合并成 <username>)。
# 写错成 <username> 会被 v2 静默忽略 → 服务回落到默认 LocalSystem(管理员级)→
# postgres.exe 拒绝以管理员权限启动。故这里拆开。
$AccountDom  = 'NT AUTHORITY'
$AccountUser = 'NetworkService'
$WebPort  = '18080'
$Svc      = 'WayfortPostgres','WayfortRedis','WayfortGateway','WayfortWeb','WayfortCaddy'

function Log($m)  { Write-Host "[wayfort-setup] $m" }
function Die($m)  { Write-Host "[wayfort-setup] X $m" -ForegroundColor Red; exit 1 }
function Assert-Admin {
  # 安装/卸载要写 Program Files、initdb、注册 Windows 服务 —— 全都需要管理员令牌。
  # 非提权时 64 位 initdb 会硬报 "Permission denied"(64 位进程不走 UAC 文件虚拟化),
  # 这里提前拦截,给出可操作提示,而不是闷头跑到一半才崩。
  $p = New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die '需要管理员权限。请右键 PowerShell「以管理员身份运行」后重跑,或直接运行安装包 WayfortSetup.exe(会自动提权)。'
  }
}
function New-HexSecret([int]$n) {
  $b = New-Object 'byte[]' $n
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($b) } finally { $rng.Dispose() }
  -join ($b | ForEach-Object { $_.ToString('x2') })
}
function Find-Exe([string]$leaf, [string]$underRelDir) {
  $base = Join-Path $App $underRelDir
  if (-not (Test-Path $base)) { return $null }
  $f = Get-ChildItem -LiteralPath $base -Filter $leaf -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($f) { return $f.FullName }
  return $null
}
function Get-EnvValue([string]$k) {
  if (-not (Test-Path $EnvFile)) { return '' }
  $m = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match "^$k=" } | Select-Object -First 1
  if ($m) { return $m.Substring($k.Length + 1) }
  return ''
}
function Xml([string]$s) {
  if ($null -eq $s) { return '' }
  $s -replace '&','&amp;' -replace '<','&lt;' -replace '>','&gt;' -replace '"','&quot;'
}
function SvcExe([string]$name) { Join-Path $SvcDir "$name.exe" }

# PS 5.1 在 $ErrorActionPreference='Stop' 下,原生命令(WinSW/sc.exe)一旦写 stderr 就抛
# NativeCommandError 终止脚本 —— 而服务命令很容易写(stop 已停的、delete 不存在的都会)。
# 故服务相关原生调用统一走这里:临时降级 EAP、吞掉输出,只返回退出码。
function Invoke-Native([string]$file, [string[]]$argv) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'SilentlyContinue'
  try { & $file @argv 2>$null | Out-Null } finally { $ErrorActionPreference = $prev }
  return $LASTEXITCODE
}

# 停止并彻底删除全部 Wayfort 服务,且等 SCM 真正释放。重装前必须先做,否则:
#   · 旧服务可能以错误账户(如 LocalSystem)残留;
#   · WinSW install 撞上没删净的同名服务会报「服务已标记为删除」(error 1072)。
function Remove-AllServices {
  foreach ($name in ($Svc | Sort-Object -Descending)) {
    $exe = SvcExe $name
    if (Test-Path $exe) {
      [void](Invoke-Native $exe @('stop'))
      [void](Invoke-Native $exe @('uninstall'))
    }
    # 兜底:WinSW 副本缺失、或服务由旧 exe 注册时,按服务名用 sc.exe 再清一遍。
    if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
      [void](Invoke-Native 'sc.exe' @('stop', $name))
      [void](Invoke-Native 'sc.exe' @('delete', $name))
    }
    # 等服务从 SCM 彻底消失(最多 ~15s),否则随后的 install 可能撞上 1072。
    for ($i = 0; $i -lt 30; $i++) {
      if (-not (Get-Service -Name $name -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 500
    }
  }
}

# 生成 WinSW 服务配置(<Id>.xml)+ 放置同名 <Id>.exe(WinSW 复制本)。
function Register-WinswService($d) {
  $exe = SvcExe $d.Name
  # 旧服务已在 Do-Install 开头由 Remove-AllServices 统一停止并删除,这里直接放置 exe + 安装。
  Copy-Item -Force $Winsw $exe
  $envXml = (@($d.Env) | ForEach-Object {
    $i = $_.IndexOf('='); $k = $_.Substring(0, $i); $v = $_.Substring($i + 1)
    "  <env name=`"$(Xml $k)`" value=`"$(Xml $v)`" />"
  }) -join "`r`n"
  $depXml = (@($d.Dep) | ForEach-Object { "  <depend>$_</depend>" }) -join "`r`n"
  $xml = @"
<service>
  <id>$($d.Name)</id>
  <name>$($d.Name)</name>
  <description>Wayfort - $($d.Name)</description>
  <executable>$(Xml $d.Exe)</executable>
  <arguments>$(Xml $d.Args)</arguments>
  <workingdirectory>$(Xml $d.Dir)</workingdirectory>
  <serviceaccount>
    <domain>$AccountDom</domain>
    <user>$AccountUser</user>
    <allowservicelogon>true</allowservicelogon>
  </serviceaccount>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="5 sec" />
  <log mode="roll" />
$envXml
$depXml
</service>
"@
  # UTF-8 无 BOM。
  [System.IO.File]::WriteAllText((Join-Path $SvcDir "$($d.Name).xml"), $xml, [System.Text.UTF8Encoding]::new($false))
  $code = Invoke-Native $exe @('install')
  if ($code -ne 0) { Die "WinSW install $($d.Name) 失败(退出码 $code)" }
}

# ───────────────────────── Uninstall ─────────────────────────
function Do-Uninstall {
  Log '停止并移除服务...'
  Remove-AllServices
  Log "服务已移除(数据 $DataRoot 保留;如需彻底清除请手动删除该目录)。"
}

# ───────────────────────── Install ─────────────────────────
function Do-Install {
  if (-not (Test-Path $Winsw)) { Die "缺少 winsw.exe($Winsw)。请在 build 时下载并随包内置。" }
  # 重装前先把旧服务停掉并删干净(等 SCM 释放)—— 否则旧的 LocalSystem 残留或同名服务
  # 未删净会让随后的 WinSW install 失败(1072)。幂等:首次安装时无服务,这步是空跑。
  Log '清理旧服务(停止 + 删除,并等待 SCM 释放)...'
  Remove-AllServices
  # 数据根与子目录都在 ProgramData(可变数据),不在 Program Files(只读)。
  New-Item -ItemType Directory -Force $DataRoot | Out-Null
  New-Item -ItemType Directory -Force $SvcDir | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $VarDir 'sessions') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $VarDir 'devolutions-gateway') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $VarDir 'logs') | Out-Null
  New-Item -ItemType Directory -Force (Join-Path $VarDir 'caddy') | Out-Null

  # 1) 密钥(首次生成,幂等保留)
  if (-not (Test-Path $EnvFile)) {
    $lines = @(
      "WEB_PORT=$WebPort"; "PUBLIC_HOST=localhost"; "WS_SCHEME=ws"; "PUBLIC_SCHEME=http"
      "JWT_SECRET=$(New-HexSecret 32)"; "POSTGRES_PASSWORD=$(New-HexSecret 24)"
      "ADMIN_PASSWORD=$(New-HexSecret 12)"; "OFFICE_JWT_SECRET=$(New-HexSecret 32)"
    )
    [System.IO.File]::WriteAllLines($EnvFile, [string[]]$lines, [System.Text.UTF8Encoding]::new($false))
    Log '已生成 .env(随机密钥)'
  }
  $pgPw = Get-EnvValue 'POSTGRES_PASSWORD'
  if (-not $pgPw) { Die '.env 缺少 POSTGRES_PASSWORD(初始化失败)。删除 .env 重跑可重新生成。' }
  $port = Get-EnvValue 'WEB_PORT'; if (-not $port) { $port = $WebPort }

  # 1b) 生效配置:把安装包内只读默认配置拷到 ProgramData(首次)。之后管理员直接改这份,
  #     重装保留。网关以 ProgramData\Wayfort 为工作目录,配置里的 ./var/* 相对路径都落这里。
  if (-not (Test-Path $ConfigFile)) {
    if (-not (Test-Path $ConfigSrc)) { Die "缺少默认配置 $ConfigSrc(检查 build 是否完整)。" }
    Copy-Item -Force $ConfigSrc $ConfigFile
    Log "已生成生效配置 $ConfigFile"
  }

  # 2) 让 NetworkService 能读写整个数据根(pgdata/sessions/keystore/svc 日志/config 等都在下面)
  Log "授予 $Account 对 $DataRoot 的写权限"
  [void](Invoke-Native 'icacls' @($DataRoot, '/grant', "${Account}:(OI)(CI)F", '/T', '/Q'))

  # 3) 初始化 Postgres 数据目录(首次)
  $initdb   = Find-Exe 'initdb.exe'   'pgsql'
  $postgres = Find-Exe 'postgres.exe' 'pgsql'
  $createdb = Find-Exe 'createdb.exe' 'pgsql'
  $psql     = Find-Exe 'psql.exe'     'pgsql'
  if (-not $initdb -or -not $postgres) { Die '在 pgsql\ 下找不到 initdb.exe/postgres.exe' }
  if (-not (Test-Path $PgData)) {
    Log '初始化 PostgreSQL 数据目录'
    $pwFile = New-TemporaryFile
    Set-Content -LiteralPath $pwFile -Value $pgPw -NoNewline -Encoding ascii
    & $initdb -D $PgData -U wayfort -A scram-sha-256 --pwfile=$pwFile -E UTF8 --locale=C
    Remove-Item $pwFile -Force
    if ($LASTEXITCODE -ne 0) { Die 'initdb 失败' }
    [void](Invoke-Native 'icacls' @($PgData, '/grant', "${Account}:(OI)(CI)F", '/T', '/Q'))
  }

  # 4) 解析其余二进制
  $wayfort = Join-Path $App 'wayfort.exe'
  $node    = Find-Exe 'node.exe'         'node'
  $caddy   = Find-Exe 'caddy.exe'        'caddy'
  $redis   = Find-Exe 'redis-server.exe' 'redis'
  foreach ($p in @($wayfort,$node,$caddy,$redis)) { if (-not $p) { Die "缺少必要二进制(检查 build 是否完整):$p" } }

  # 5) 网关环境变量(密钥 + 地址)
  $gwEnv = @(
    "WAYFORT_DB_DSN=host=127.0.0.1 user=wayfort password=$pgPw dbname=wayfort port=5432 sslmode=disable"
    "WAYFORT_REDIS_ADDR=127.0.0.1:6379"
    "WAYFORT_AUTH_JWT_SECRET=$(Get-EnvValue 'JWT_SECRET')"
    "WAYFORT_AUTH_BOOTSTRAP_PASSWORD=$(Get-EnvValue 'ADMIN_PASSWORD')"
    "WAYFORT_OFFICE_JWT_SECRET=$(Get-EnvValue 'OFFICE_JWT_SECRET')"
    "WAYFORT_DESKTOP_DEVOLUTIONS_GATEWAY_ADVERTISED_URL=ws://localhost:$port/jet/rdp"
    "WAYFORT_DESKTOP_DEVOLUTIONS_GATEWAY_EXTERNAL_URL=http://localhost:$port"
    # 二进制只读(随包在 Program Files);配置/密钥/id 可变 → 落 ProgramData\var\devolutions-gateway。
    "WAYFORT_DESKTOP_DEVOLUTIONS_GATEWAY_BINARY_PATH=$App\devolutions-gateway\devolutions-gateway.exe"
    "WAYFORT_DESKTOP_DEVOLUTIONS_GATEWAY_INSTALL_PREFIX=$VarDir\devolutions-gateway"
  )

  # 6) 注册 5 个服务(WinSW)
  $defs = @(
    @{ Name='WayfortPostgres'; Exe=$postgres; Args="-D `"$PgData`" -p 5432"; Dir=$App; Dep=@(); Env=@() }
    @{ Name='WayfortRedis';    Exe=$redis;    Args="--port 6379 --appendonly yes --dir `"$VarDir`""; Dir=$App; Dep=@(); Env=@() }
    # 工作目录 = $DataRoot(ProgramData\Wayfort):配置里的 ./var/sessions、./var/keystore.unseal
    # 等相对路径按 CWD 解析,于是数据全落 ProgramData,而非 Program Files。配置走绝对路径。
    @{ Name='WayfortGateway';  Exe=$wayfort;  Args="--config `"$ConfigFile`""; Dir=$DataRoot; Dep=@('WayfortPostgres','WayfortRedis'); Env=$gwEnv }
    @{ Name='WayfortWeb';      Exe=$node;     Args="server.js"; Dir=(Join-Path $App 'web'); Dep=@('WayfortGateway'); Env=@('BACKEND_HTTP_URL=http://127.0.0.1:8080','NODE_ENV=production','PORT=3000','HOSTNAME=127.0.0.1') }
    # Caddy 的 Caddyfile 只读(在 $App),但其数据/自动保存配置经 XDG 指到 ProgramData,不写程序目录。
    @{ Name='WayfortCaddy';    Exe=$caddy;    Args="run --config Caddyfile --adapter caddyfile"; Dir=$App; Dep=@('WayfortWeb'); Env=@("WAYFORT_SITE=:$port", "XDG_DATA_HOME=$VarDir\caddy", "XDG_CONFIG_HOME=$VarDir\caddy") }
  )
  foreach ($d in $defs) { Register-WinswService $d }

  # 7) 启动:Postgres → 等就绪 → 建库 → 其余
  # PS 5.1 在 $ErrorActionPreference='Stop' 下,原生命令(psql/createdb/WinSW)一旦写 stderr
  # 就会抛 NativeCommandError 终止脚本 —— PG 尚未起监听时 psql 必报 "connection refused",
  # 会让下面的就绪重试在第一次探测就崩。故本段临时降级 EAP,只按退出码判定,末尾恢复。
  $eapSaved = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    Log '启动 PostgreSQL...'
    & (SvcExe 'WayfortPostgres') start | Out-Null
    $env:PGPASSWORD = $pgPw
    $ready = $false
    for ($i=0; $i -lt 60; $i++) {
      & $psql -h 127.0.0.1 -U wayfort -d postgres -tAc 'SELECT 1' 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) { $ready = $true; break }
      Start-Sleep -Seconds 1
    }
    if (-not $ready) {
      Write-Warning 'Postgres 未在 60s 内就绪;wayfort 会由 WinSW 自动重试直到可连接。'
      Write-Warning "若长期连不上,查日志:$SvcDir\WayfortPostgres.err.log 与 $PgData\log\(PG 启动失败原因都在这)。"
    } else {
      $exists = & $psql -h 127.0.0.1 -U wayfort -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='wayfort'" 2>$null
      if ("$exists".Trim() -ne '1') { & $createdb -h 127.0.0.1 -U wayfort wayfort 2>$null | Out-Null }
    }
    foreach ($s in 'WayfortRedis','WayfortGateway','WayfortWeb','WayfortCaddy') { Log "启动 $s..."; & (SvcExe $s) start | Out-Null }
  } finally {
    $ErrorActionPreference = $eapSaved
  }

  Write-Host ''
  Log "完成。访问 http://localhost:$port   管理员 admin / $(Get-EnvValue 'ADMIN_PASSWORD')"
  Log "数据在 $DataRoot;日志在 $VarDir\logs\ 与 $SvcDir\<服务>.out.log。首启后端需数十秒做迁移与引导。"
}

if ($Uninstall) { Assert-Admin; Do-Uninstall }
elseif ($Install) { Assert-Admin; Do-Install }
else { Die '需指定 -Install 或 -Uninstall' }
