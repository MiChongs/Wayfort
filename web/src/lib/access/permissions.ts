// 权限动作的人话标签与预设套餐。后端仍以动作码（connect/sftp_read/…）存储与
// 鉴权；这里只负责把它们翻译成人能读懂的标签和常用套餐，避免界面上全是代码。

export const ALL_ACTIONS = [
  "connect",
  "sftp_read",
  "sftp_write",
  "port_forward",
  "upload",
  "download",
] as const

export const ACTION_LABELS: Record<string, string> = {
  connect: "连接",
  sftp_read: "SFTP 读取",
  sftp_write: "SFTP 写入",
  port_forward: "端口转发",
  upload: "文件上传",
  download: "文件下载",
  "*": "全部权限",
}

export function actionLabel(code: string): string {
  return ACTION_LABELS[code] ?? code
}

export interface Preset {
  key: string
  label: string
  desc: string
  actions: string[]
}

// 常用套餐。"自定义" 在 UI 里单独处理，不在此列。套餐内容可按组织需要调整。
export const PRESETS: Preset[] = [
  { key: "readonly", label: "只读运维", desc: "连接 + 读取文件", actions: ["connect", "sftp_read"] },
  { key: "operate", label: "运维操作", desc: "连接 + 读写文件 + 端口转发", actions: ["connect", "sftp_read", "sftp_write", "port_forward"] },
  { key: "files", label: "仅文件传输", desc: "上传 / 下载 / 读写文件", actions: ["sftp_read", "sftp_write", "upload", "download"] },
  { key: "full", label: "完全访问", desc: "该资产的所有权限", actions: ["*"] },
]

const norm = (a: string[]) => [...new Set(a)].sort().join(",")

// matchPreset 找出与给定动作集合完全一致的套餐 key（用于回显），找不到返回 null。
export function matchPreset(actions: string[]): string | null {
  const key = norm(actions)
  for (const p of PRESETS) if (norm(p.actions) === key) return p.key
  return null
}

// 把一组动作渲染成简短中文摘要：含 * 直接显示「全部权限」。
export function summarizeActions(actions: string[]): string {
  if (actions.includes("*")) return "全部权限"
  const labels = actions.map(actionLabel)
  if (labels.length <= 3) return labels.join("、")
  return `${labels.slice(0, 3).join("、")} 等 ${labels.length} 项`
}
