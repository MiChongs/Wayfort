"use client"

import * as React from "react"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ProxyChainCanvas } from "@/components/admin/proxy-chain-canvas"
import type { Proxy, ProxyChainTemplate } from "@/lib/api/types"

/**
 * TopologyTab renders a read-only node-graph of a chosen template's chain with
 * live health on the hop nodes (the canvas reads the page's health provider).
 * The canvas is locked (disabled) — this is a viewer, not an editor.
 */
export function TopologyTab({
  templates,
  proxies,
}: {
  templates: ProxyChainTemplate[]
  proxies: Proxy[]
}) {
  const [sel, setSel] = React.useState<string>(() => (templates[0] ? String(templates[0].id) : ""))
  const chain = templates.find((t) => String(t.id) === sel)?.chain ?? ""

  if (templates.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-12 text-center text-sm text-muted-foreground">
          先在「模板」标签里保存一条链路，这里就能看到它的拓扑总览。
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="eyebrow">查看模板</span>
        <Select value={sel} onValueChange={setSel}>
          <SelectTrigger className="h-9 w-64">
            <SelectValue placeholder="选择模板" />
          </SelectTrigger>
          <SelectContent>
            {templates.map((t) => (
              <SelectItem key={t.id} value={String(t.id)}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="h-[60vh] min-h-[360px] overflow-hidden rounded-xl border">
        {/* eslint-disable-next-line @typescript-eslint/no-empty-function */}
        <ProxyChainCanvas value={chain} onChange={() => {}} proxies={proxies} disabled />
      </div>
    </div>
  )
}
