<#
  Wayfort 一键部署(Windows / PowerShell 7+)。Linux/macOS 用 deploy.sh。

    ./deploy.ps1 [up|down|restart|logs|status|update|destroy] [--office] [--sandbox]

    up       构建 + 启动整套(默认)。首次自动生成 deployments\.env 的随机密钥。
    down     停止并移除容器(保留数据卷)。
    restart  重启所有服务。
    logs     跟踪日志:  ./deploy.ps1 logs            全部
                         ./deploy.ps1 logs wayfort    指定服务
    status   查看各服务状态。
    update   拉取基础镜像 + 按当前源码重建应用镜像 + 滚动重启。
    destroy  停止并删除全部数据卷(不可逆,需二次确认)。

    --office / -Office     叠加在线 Office(OnlyOffice)。
    --sandbox / -Sandbox   叠加匿名沙箱 / DB CLI 容器(挂载 docker.sock,有安全权衡)。
#>
#Requires -Version 7.0
$ErrorActionPreference = 'Stop'

$Root        = $PSScriptRoot
$DeployDir   = Join-Path $Root 'deployments'
$EnvFile     = Join-Path $DeployDir '.env'
$EnvExample  = Join-Path $DeployDir '.env.example'
$BaseFile    = Join-Path $DeployDir 'docker-compose.prod.yaml'
$OfficeFile  = Join-Path $DeployDir 'docker-compose.office.yaml'
$SandboxFile = Join-Path $DeployDir 'docker-compose.sandbox.yaml'
$Project     = 'wayfort'

function Die($m)  { Write-Host "✗ $m" -ForegroundColor Red;    exit 1 }
function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "⚠ $m" -ForegroundColor Yellow }
function Step($m) { Write-Host $m     -ForegroundColor Cyan }

# ── 参数解析(兼容 --office / -Office)──────────────────────
$cmd = 'up'; $svc = ''; $office = $false; $sandbox = $false; $pos = 0
foreach ($a in $args) {
  if     ($a -ieq '--office'  -or $a -ieq '-Office')  { $office  = $true }
  elseif ($a -ieq '--sandbox' -or $a -ieq '-Sandbox') { $sandbox = $true }
  elseif ($a -ieq '-h' -or $a -ieq '--help' -or $a -ieq '-Help') { $cmd = 'help' }
  elseif ($pos -eq 0) { $cmd = $a; $pos++ }
  else                { $svc = $a; $pos++ }
}

function Require-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Die "未找到 docker。请先安装 Docker Desktop:https://docs.docker.com/get-docker/"
  }
  & docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { Die "未找到 'docker compose'(v2)。请升级 Docker Desktop。" }
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) { Die "Docker 未运行。请启动 Docker Desktop 后重试。" }
}

function New-HexSecret([int]$Bytes) {
  $b = [byte[]]::new($Bytes)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($b)
  -join ($b | ForEach-Object { $_.ToString('x2') })
}

function Set-EnvSecret([string]$Key, [string]$Value) {
  # 仅在「键缺失」或「值为空」时写入,重复运行不轮换已有密钥。
  $lines = @(Get-Content -LiteralPath $EnvFile)
  $found = $false
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "^$Key=(.*)$") {
      $found = $true
      if ($Matches[1] -eq '') { $lines[$i] = "$Key=$Value" }
      break
    }
  }
  if (-not $found) { $lines += "$Key=$Value" }
  Set-Content -LiteralPath $EnvFile -Value $lines -Encoding utf8NoBOM
}

function Get-EnvValue([string]$Key) {
  $m = Get-Content -LiteralPath $EnvFile | Where-Object { $_ -match "^$Key=" } | Select-Object -First 1
  if ($m) { return $m.Substring($Key.Length + 1) }
  return ''
}

function Ensure-Env {
  if (-not (Test-Path -LiteralPath $EnvFile)) {
    if (-not (Test-Path -LiteralPath $EnvExample)) { Die "缺少 $EnvExample" }
    Copy-Item -LiteralPath $EnvExample -Destination $EnvFile
    Ok "已创建 deployments\.env(从 .env.example)"
  }
  Set-EnvSecret 'JWT_SECRET'        (New-HexSecret 32)
  Set-EnvSecret 'POSTGRES_PASSWORD' (New-HexSecret 24)
  Set-EnvSecret 'ADMIN_PASSWORD'    (New-HexSecret 12)
  Set-EnvSecret 'OFFICE_JWT_SECRET' (New-HexSecret 32)
  Test-SchemeConsistency
}

# 提醒:WS_SCHEME 与 PUBLIC_SCHEME 必须配套(ws↔http、wss↔https),否则浏览器侧
# WebSocket / ironrdp 网关会因协议不匹配而静默连不上。
function Test-SchemeConsistency {
  $ws = Get-EnvValue 'WS_SCHEME'; $ps = Get-EnvValue 'PUBLIC_SCHEME'
  if ((($ps -eq 'https') -and ($ws -ne 'wss')) -or (($ps -eq 'http') -and ($ws -ne 'ws'))) {
    $want = if ($ps -eq 'https') { 'wss' } else { 'ws' }
    Warn "deployments\.env 协议不配套:PUBLIC_SCHEME=$ps 应搭配 WS_SCHEME=$want(当前 WS_SCHEME=$ws)。WebSocket / ironrdp 可能连接失败。"
  }
}

function Compose-Args {
  $files = @('-f', $BaseFile)
  if ($office)  { $files += @('-f', $OfficeFile) }
  if ($sandbox) { $files += @('-f', $SandboxFile) }
  return @('compose', '-p', $Project, '--env-file', $EnvFile) + $files
}

# 跑 docker 并在失败时立即退出 —— PowerShell 没有 bash 的 `set -e`,原生命令
# 失败不会自动中止脚本,必须显式检查 $LASTEXITCODE,否则会误报成功。
function Invoke-Docker {
  & docker @args
  if ($LASTEXITCODE -ne 0) { Die "docker $($args -join ' ') 失败(退出码 $LASTEXITCODE)。" }
}

function Wait-Health {
  $ca = Compose-Args
  $cid = (& docker @ca ps -q wayfort 2>$null | Select-Object -First 1)
  if (-not $cid) { Warn "未找到 wayfort 容器,跳过健康等待。"; return }
  Write-Host -NoNewline "等待后端就绪(数据库迁移 + 引导)"
  for ($i = 0; $i -lt 60; $i++) {
    $status = (& docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $cid 2>$null)
    if ($status -eq 'healthy') { Write-Host ''; Ok "后端已就绪"; return }
    if ($status -eq 'none')    { Write-Host ''; Warn "后端无健康检查,假定已启动。"; return }
    Write-Host -NoNewline '.'; Start-Sleep -Seconds 3
  }
  Write-Host ''; Warn "等待超时。可用 './deploy.ps1 logs wayfort' 查看启动日志。"
}

function Print-Access {
  $host_ = Get-EnvValue 'PUBLIC_HOST'; if (-not $host_) { $host_ = 'localhost' }
  $port  = Get-EnvValue 'WEB_PORT';    if (-not $port)  { $port  = '8088' }
  $admin = Get-EnvValue 'ADMIN_PASSWORD'
  $scheme = if ((Get-EnvValue 'WS_SCHEME') -eq 'wss') { 'https' } else { 'http' }
  Write-Host ''
  Write-Host '════════════════════════════════════════════'
  Write-Host ' Wayfort 已启动 🎉' -ForegroundColor Green
  Write-Host "   访问地址 : ${scheme}://${host_}:${port}"
  if ($admin) {
    Write-Host "   管理员   : admin / $admin"
    Warn "  (该密码仅首次启动建账时生效;登录后请尽快修改)"
  } else {
    Write-Host "   管理员   : admin / 见首启日志 banner(./deploy.ps1 logs wayfort)"
  }
  Write-Host '════════════════════════════════════════════'
}

switch ($cmd) {
  'help' {
    Get-Content -LiteralPath (Join-Path $Root 'deploy.ps1') | Select-Object -Skip 1 -First 20 | ForEach-Object { $_ }
  }
  'up' {
    Require-Docker; Ensure-Env
    if ($sandbox) { Warn "已启用 --sandbox:后端将挂载 docker.sock 并以 root 运行(≈宿主 root 权限)。" }
    Step "→ 构建并启动 Wayfort …"
    $ca = Compose-Args; Invoke-Docker @ca up -d --build --remove-orphans
    Wait-Health; Print-Access
  }
  'down' {
    Require-Docker
    Step "→ 停止并移除容器(保留数据卷)…"
    $ca = Compose-Args; Invoke-Docker @ca down --remove-orphans
    Ok "已停止"
  }
  'restart' {
    Require-Docker; $ca = Compose-Args; Invoke-Docker @ca restart; Ok "已重启"
  }
  'logs' {
    Require-Docker; $ca = Compose-Args
    # logs -f 由 Ctrl-C 结束(退出码非 0),故不经 Invoke-Docker 以免误报失败。
    if ($svc) { & docker @ca logs -f --tail=200 $svc } else { & docker @ca logs -f --tail=200 }
  }
  { $_ -in @('status','ps') } {
    Require-Docker; $ca = Compose-Args; & docker @ca ps
  }
  'update' {
    Require-Docker; Ensure-Env
    Step "→ 拉取基础镜像 + 重建应用镜像 …"
    $ca = Compose-Args
    Invoke-Docker @ca build --pull
    Invoke-Docker @ca up -d --remove-orphans
    Wait-Health; Ok "已更新并重启"
  }
  'destroy' {
    Require-Docker
    Write-Host "⚠ 这会删除全部数据卷(数据库 / Redis / 会话 / 解封口令),不可逆!" -ForegroundColor Red
    $confirm = Read-Host "确认删除?输入大写 YES 继续"
    if ($confirm -cne 'YES') { Write-Host "已取消。"; exit 0 }
    $ca = Compose-Args; Invoke-Docker @ca down -v --remove-orphans
    Ok "已销毁全部容器与数据卷"
  }
  default { Die "未知命令:$cmd(用 ./deploy.ps1 --help 查看用法)" }
}
