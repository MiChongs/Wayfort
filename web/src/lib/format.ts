import { formatDistanceToNow, format } from "date-fns"
import { zhCN } from "date-fns/locale"

export function relTime(s?: string | null): string {
  if (!s) return ""
  try {
    const d = new Date(s)
    return formatDistanceToNow(d, { addSuffix: true, locale: zhCN })
  } catch {
    return s
  }
}

export function fullTime(s?: string | null): string {
  if (!s) return ""
  try {
    return format(new Date(s), "yyyy-MM-dd HH:mm:ss")
  } catch {
    return s
  }
}

const units = ["B", "KB", "MB", "GB", "TB"]
export function fmtBytes(n?: number | null): string {
  if (!n || n <= 0) return "0 B"
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`
}
