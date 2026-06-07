// Tiny formatting helpers shared by the insights tabs. Co-located so each tab
// stays focused on layout.

export function formatBytes(kb: number): string {
  if (!Number.isFinite(kb) || kb <= 0) return "0"
  const bytes = kb * 1024
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${units[i]}`
}

export function formatBps(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0B/s"
  const units = ["B/s", "KB/s", "MB/s", "GB/s"]
  let i = 0
  let v = bps
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)}${units[i]}`
}

export function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0s"
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const parts: string[] = []
  if (d > 0) parts.push(`${d}天`)
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0 && d === 0) parts.push(`${m}分`)
  if (parts.length === 0) parts.push(`${Math.floor(sec)}秒`)
  return parts.join(" ")
}

export function relativeTime(iso: string | undefined): string {
  if (!iso) return ""
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return "刚刚"
  const s = Math.floor(ms / 1000)
  if (s < 5) return "刚刚"
  if (s < 60) return `${s}秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分前`
  const h = Math.floor(m / 60)
  return `${h}小时前`
}

// Threshold-coloured tone class for "used percentage" indicators. Warm
// semantic palette per DESIGN.md — sage / amber-gold / brick, never cool
// emerald/amber.
export function usagePctTone(pct: number): string {
  if (pct >= 90) return "text-destructive"
  if (pct >= 70) return "text-warning"
  return "text-success"
}

export function usagePctBg(pct: number): string {
  if (pct >= 90) return "bg-destructive"
  if (pct >= 70) return "bg-warning"
  return "bg-success"
}
