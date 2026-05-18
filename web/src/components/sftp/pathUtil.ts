// Posix-style path helpers. SFTP paths on the wire are always forward-slash
// regardless of the gateway's host OS, so we deliberately don't reuse the
// `path` Node module.

export function normalize(p: string): string {
  if (!p) return "/"
  const isAbs = p.startsWith("/")
  const out: string[] = []
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      if (out.length) out.pop()
      continue
    }
    out.push(seg)
  }
  const joined = (isAbs ? "/" : "") + out.join("/")
  return joined || "/"
}

export function join(...parts: string[]): string {
  const merged = parts.filter(Boolean).join("/")
  return normalize(merged.startsWith("/") ? merged : "/" + merged)
}

export function parent(p: string): string {
  const n = normalize(p)
  if (n === "/") return "/"
  const i = n.lastIndexOf("/")
  if (i <= 0) return "/"
  return n.slice(0, i)
}

export function basename(p: string): string {
  const n = normalize(p)
  if (n === "/") return "/"
  const i = n.lastIndexOf("/")
  return i < 0 ? n : n.slice(i + 1)
}

export function segments(p: string): string[] {
  return normalize(p).split("/").filter(Boolean)
}

export function extension(name: string): string {
  const dot = name.lastIndexOf(".")
  if (dot <= 0 || dot === name.length - 1) return ""
  return name.slice(dot + 1).toLowerCase()
}
