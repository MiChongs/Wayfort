#!/usr/bin/env bash
# Wayfort 一键部署(Linux / macOS)。Windows 用 deploy.ps1。
#
#   ./deploy.sh [up|down|restart|logs|status|update|destroy] [--office] [--sandbox]
#
#   up       构建 + 启动整套(默认)。首次自动生成 deployments/.env 的随机密钥。
#   down     停止并移除容器(保留数据卷)。
#   restart  重启所有服务。
#   logs     跟踪日志:  ./deploy.sh logs            全部
#                        ./deploy.sh logs wayfort    指定服务
#   status   查看各服务状态。
#   update   拉取基础镜像 + 按当前源码重建应用镜像 + 滚动重启。
#   destroy  停止并**删除全部数据卷**(不可逆,需二次确认)。
#
#   --office   叠加在线 Office(OnlyOffice)。
#   --sandbox  叠加匿名沙箱 / DB CLI 容器(挂载 docker.sock,有安全权衡)。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$ROOT/deployments"
ENV_FILE="$DEPLOY_DIR/.env"
ENV_EXAMPLE="$DEPLOY_DIR/.env.example"
BASE_FILE="$DEPLOY_DIR/docker-compose.prod.yaml"
OFFICE_FILE="$DEPLOY_DIR/docker-compose.office.yaml"
SANDBOX_FILE="$DEPLOY_DIR/docker-compose.sandbox.yaml"
PROJECT="wayfort"

c_red()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
c_ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
c_bold() { printf '\033[1m%s\033[0m\n' "$*"; }
die()    { c_red "✗ $*"; exit 1; }

# ── 参数解析 ──────────────────────────────────────────────
COMMAND="up"; OFFICE=0; SANDBOX=0; LOG_SVC=""
first=1
for a in "$@"; do
  case "$a" in
    --office)  OFFICE=1 ;;
    --sandbox) SANDBOX=1 ;;
    -h|--help) COMMAND="help" ;;
    *)
      if [ "$first" = 1 ]; then COMMAND="$a"; else LOG_SVC="$a"; fi ;;
  esac
  first=0
done

# ── 前置检查 ──────────────────────────────────────────────
require_docker() {
  command -v docker >/dev/null 2>&1 || die "未找到 docker。请先安装 Docker:https://docs.docker.com/get-docker/"
  docker compose version >/dev/null 2>&1 || die "未找到 'docker compose'(v2)。请升级 Docker 到含 compose 插件的版本。"
  docker info >/dev/null 2>&1 || die "Docker 守护进程未运行或无权限。请启动 Docker(或将当前用户加入 docker 组)。"
}

# ── 随机密钥生成(openssl 优先,/dev/urandom 兜底,纯 hex 避免特殊字符)──
gen_hex() { # gen_hex <bytes>
  local n="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$n"
  else
    LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c "$((n*2))"
  fi
}

# ── 生成 / 补全 deployments/.env ──────────────────────────
ensure_env() {
  if [ ! -f "$ENV_FILE" ]; then
    [ -f "$ENV_EXAMPLE" ] || die "缺少 $ENV_EXAMPLE"
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    c_grn "✓ 已创建 deployments/.env(从 .env.example)"
  fi
  # 仅填充「值为空」的密钥项,重复运行不会轮换已有密钥。
  fill_secret JWT_SECRET       "$(gen_hex 32)"
  fill_secret POSTGRES_PASSWORD "$(gen_hex 24)"
  fill_secret ADMIN_PASSWORD    "$(gen_hex 12)"
  fill_secret OFFICE_JWT_SECRET "$(gen_hex 32)"
  chmod 600 "$ENV_FILE" 2>/dev/null || true   # 含明文密钥,收紧权限
  check_scheme_consistency
}

# 提醒:WS_SCHEME 与 PUBLIC_SCHEME 必须配套(ws↔http、wss↔https),否则浏览器侧
# WebSocket / ironrdp 网关会因协议(含 https 混合内容)不匹配而静默连不上。
check_scheme_consistency() {
  local ws ps
  ws="$(read_env WS_SCHEME)"; ps="$(read_env PUBLIC_SCHEME)"
  if { [ "$ps" = "https" ] && [ "$ws" != "wss" ]; } || { [ "$ps" = "http" ] && [ "$ws" != "ws" ]; }; then
    c_ylw "⚠ deployments/.env 协议不配套:PUBLIC_SCHEME=$ps 应搭配 WS_SCHEME=$([ "$ps" = "https" ] && echo wss || echo ws)(当前 WS_SCHEME=$ws)。WebSocket / ironrdp 可能连接失败。"
  fi
}

# 把「值为空」的 KEY= 行就地填上生成值;键不存在则追加。纯 bash 单遍重写,
# 不依赖 sed(规避 GNU/BSD/busybox 的 -i 方言差异),且只动恰好为 "KEY=" 的空行
# —— 已有值的行原样保留(幂等,重复运行不轮换)。
fill_secret() { # fill_secret <KEY> <value-if-empty>
  local key="$1" val="$2" tmp found=0 ln
  tmp="$(mktemp)"
  while IFS= read -r ln || [ -n "$ln" ]; do
    case "$ln" in
      "${key}=")                                   # 该键存在但值为空 → 填上生成值
        printf '%s=%s\n' "$key" "$val" >>"$tmp"; found=1 ;;
      "${key}="*)                                  # 该键已有值 → 原样保留(幂等,不轮换)
        printf '%s\n' "$ln" >>"$tmp"; found=1 ;;
      *)
        printf '%s\n' "$ln" >>"$tmp" ;;
    esac
  done <"$ENV_FILE"
  [ "$found" = 1 ] || printf '%s=%s\n' "$key" "$val" >>"$tmp"   # 键缺失才追加
  mv "$tmp" "$ENV_FILE"
}

read_env() { # read_env <KEY>  —— 取首个 = 之后的全部内容
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2- || true
}

# ── compose 包装(组合 -f override + 项目名 + env-file)──
compose() {
  local files=(-f "$BASE_FILE")
  [ "$OFFICE" = 1 ]  && files+=(-f "$OFFICE_FILE")
  [ "$SANDBOX" = 1 ] && files+=(-f "$SANDBOX_FILE")
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" "${files[@]}" "$@"
}

wait_health() {
  local cid status i=0
  cid="$(compose ps -q wayfort 2>/dev/null || true)"
  [ -n "$cid" ] || { c_ylw "⚠ 未找到 wayfort 容器,跳过健康等待。"; return 0; }
  printf '等待后端就绪(数据库迁移 + 引导)'
  while [ "$i" -lt 60 ]; do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo none)"
    case "$status" in
      healthy) printf '\n'; c_grn "✓ 后端已就绪"; return 0 ;;
      none)    printf '\n'; c_ylw "⚠ 后端无健康检查,假定已启动。"; return 0 ;;
      *)       printf '.'; sleep 3; i=$((i+1)) ;;
    esac
  done
  printf '\n'; c_ylw "⚠ 等待超时。可用 './deploy.sh logs wayfort' 查看启动日志。"
}

print_access() {
  local host port admin scheme
  host="$(read_env PUBLIC_HOST)"; host="${host:-localhost}"
  port="$(read_env WEB_PORT)";    port="${port:-8088}"
  admin="$(read_env ADMIN_PASSWORD)"
  scheme="http"; [ "$(read_env WS_SCHEME)" = "wss" ] && scheme="https"
  echo
  c_bold "════════════════════════════════════════════"
  c_grn  " Wayfort 已启动 🎉"
  echo   "   访问地址 : ${scheme}://${host}:${port}"
  if [ -n "$admin" ]; then
    echo "   管理员   : admin / ${admin}"
    c_ylw "   (该密码仅首次启动建账时生效;登录后请尽快修改)"
  else
    echo "   管理员   : admin / 见首启日志 banner(./deploy.sh logs wayfort)"
  fi
  c_bold "════════════════════════════════════════════"
}

usage() { sed -n '2,20p' "$ROOT/deploy.sh" | sed 's/^# \{0,1\}//'; }

# ── 命令分发 ──────────────────────────────────────────────
case "$COMMAND" in
  help) usage ;;
  up)
    require_docker; ensure_env
    [ "$SANDBOX" = 1 ] && c_ylw "⚠ 已启用 --sandbox:后端将挂载 docker.sock 并以 root 运行(≈宿主 root 权限)。"
    c_bold "→ 构建并启动 Wayfort …"
    compose up -d --build --remove-orphans || die "docker compose up 失败(退出码 $?)。可用 './deploy.sh logs' 排查。"
    wait_health
    print_access ;;
  down)
    require_docker
    c_bold "→ 停止并移除容器(保留数据卷)…"
    compose down --remove-orphans
    c_grn "✓ 已停止" ;;
  restart)
    require_docker
    compose restart
    c_grn "✓ 已重启" ;;
  logs)
    require_docker
    if [ -n "$LOG_SVC" ]; then compose logs -f --tail=200 "$LOG_SVC"; else compose logs -f --tail=200; fi ;;
  status|ps)
    require_docker; compose ps ;;
  update)
    require_docker; ensure_env
    c_bold "→ 拉取基础镜像 + 重建应用镜像 …"
    compose build --pull || die "镜像构建失败,已中止(旧容器未改动)。"
    compose up -d --remove-orphans || die "docker compose up 失败(退出码 $?)。"
    wait_health
    c_grn "✓ 已更新并重启" ;;
  destroy)
    require_docker
    c_red "⚠ 这会删除全部数据卷(数据库 / Redis / 会话 / 解封口令),不可逆!"
    printf '确认删除?输入大写 YES 继续:'
    read -r confirm
    [ "$confirm" = "YES" ] || { echo "已取消。"; exit 0; }
    compose down -v --remove-orphans
    c_grn "✓ 已销毁全部容器与数据卷" ;;
  *)
    die "未知命令:$COMMAND(用 ./deploy.sh --help 查看用法)" ;;
esac
