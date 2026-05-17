// Guacamole error status codes — friendly Chinese messages + suggested next
// step. The full list lives in `Guacamole.Status.Code` at runtime but we
// only translate the codes a typical RDP / VNC session actually hits.
//
// Reference: https://guacamole.apache.org/doc/gug/protocol-reference.html#status-codes

// Plan 13.D.7 — FriendlyError.action attaches an "actionable next step" link
// so the error overlay can guide the user toward a fix instead of just
// describing the symptom. e.g. auth failures → take user to credential edit.
export interface FriendlyError {
  title: string
  hint?: string
  action?: { label: string; href: string }
}

export function describeGuacError(code: number | undefined, raw?: string): FriendlyError {
  if (code == null) {
    return { title: raw || "未知错误" }
  }
  const map: Record<number, FriendlyError> = {
    0x0000: { title: "成功" },
    0x0100: { title: "服务器内部错误", hint: "查看 guacd 日志" },
    0x0101: { title: "操作不受支持" },
    0x0200: { title: "服务器资源不足" },
    0x0201: { title: "服务器已达最大连接数", hint: "等几分钟或重启 guacd" },
    0x0202: { title: "请求资源已被使用" },
    0x0203: { title: "请求资源忙" },
    0x0204: { title: "请求资源不可用" },
    0x0205: { title: "服务器超时" },
    0x0207: {
      title: "目标主机不可达",
      hint: "检查节点 host / port / 网络",
      action: { label: "去检查节点", href: "/admin/nodes" },
    },
    0x0208: {
      title: "目标主机超时",
      hint: "防火墙、网络抖动或目标过载",
      action: { label: "去检查节点", href: "/admin/nodes" },
    },
    0x0209: {
      title: "目标连接被中断",
      hint: "目标 RDP / VNC 服务可能崩溃或被防火墙关闭",
      action: { label: "去检查节点", href: "/admin/nodes" },
    },
    0x020A: { title: "目标连接被关闭" },
    0x020B: { title: "目标 SSL/TLS 握手失败", hint: "已默认 ignore-cert，仍失败可能是协议版本不匹配" },
    0x020D: { title: "客户端连接被中断" },
    0x020E: { title: "客户端连接超时" },
    0x0300: { title: "请求格式错误" },
    0x0301: {
      title: "未认证 / 凭据错误",
      hint: "检查节点凭据用户名 / 密码 / 域是否正确",
      action: { label: "去编辑凭据", href: "/admin/credentials" },
    },
    0x0303: { title: "拒绝访问", hint: "权限不足或目标禁止此账户" },
    0x0308: { title: "客户端请求超时" },
    0x031D: { title: "客户端禁用此功能" },
  }
  const m = map[code]
  if (m) return m
  return {
    title: `远程桌面错误 (code=0x${code.toString(16).toUpperCase()})`,
    hint: raw,
  }
}

// State code map for Guacamole.Client.STATE_*
// 0=IDLE 1=CONNECTING 2=WAITING 3=CONNECTED 4=DISCONNECTING 5=DISCONNECTED
export type GuacPhase =
  | "idle"
  | "loading-script"
  | "connecting"
  | "handshake"
  | "connected"
  | "disconnecting"
  | "disconnected"
  | "error"

export function phaseFromState(s: number): GuacPhase {
  switch (s) {
    case 0:
      return "idle"
    case 1:
      return "connecting"
    case 2:
      return "handshake"
    case 3:
      return "connected"
    case 4:
      return "disconnecting"
    case 5:
      return "disconnected"
    default:
      return "idle"
  }
}

export function phaseLabel(p: GuacPhase): string {
  switch (p) {
    case "idle":
      return "待命"
    case "loading-script":
      return "加载客户端…"
    case "connecting":
      return "连接 guacd…"
    case "handshake":
      return "协议握手…"
    case "connected":
      return "已连接"
    case "disconnecting":
      return "断开中…"
    case "disconnected":
      return "已断开"
    case "error":
      return "错误"
  }
}
