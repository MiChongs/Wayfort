// Pure client-side export for the asset tree's "导出" action — no backend round
// trip. Turns a node selection into a downloadable CSV or JSON file.

import type { Node } from "@/lib/api/types"

const COLUMNS: { key: string; header: string; get: (n: Node) => string }[] = [
  { key: "id", header: "ID", get: (n) => String(n.id) },
  { key: "name", header: "名称", get: (n) => n.name },
  { key: "protocol", header: "协议", get: (n) => n.protocol },
  { key: "host", header: "主机", get: (n) => n.host },
  { key: "port", header: "端口", get: (n) => String(n.port) },
  { key: "region", header: "区域", get: (n) => n.region ?? "" },
  { key: "tags", header: "标签", get: (n) => n.tags ?? "" },
  { key: "disabled", header: "停用", get: (n) => (n.disabled ? "是" : "否") },
  { key: "description", header: "描述", get: (n) => n.description ?? "" },
]

function csvCell(v: string): string {
  // Quote when the value contains a comma, quote, or newline (RFC 4180).
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

export function nodesToCSV(nodes: Node[]): string {
  const header = COLUMNS.map((c) => c.header).join(",")
  const rows = nodes.map((n) => COLUMNS.map((c) => csvCell(c.get(n))).join(","))
  // Prepend a UTF-8 BOM so Excel opens Chinese headers without mojibake.
  return "﻿" + [header, ...rows].join("\r\n")
}

export function nodesToJSON(nodes: Node[]): string {
  return JSON.stringify(
    nodes.map((n) => ({
      id: n.id,
      name: n.name,
      protocol: n.protocol,
      host: n.host,
      port: n.port,
      region: n.region ?? "",
      tags: n.tags ?? "",
      disabled: !!n.disabled,
      description: n.description ?? "",
    })),
    null,
    2,
  )
}

function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick so the click has a chance to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function exportNodes(nodes: Node[], format: "csv" | "json", stamp: string) {
  if (format === "csv") {
    triggerDownload(nodesToCSV(nodes), `assets-${stamp}.csv`, "text/csv;charset=utf-8")
  } else {
    triggerDownload(nodesToJSON(nodes), `assets-${stamp}.json`, "application/json")
  }
}
