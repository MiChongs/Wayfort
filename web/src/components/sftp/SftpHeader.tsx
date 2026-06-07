"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowLeft, FolderTree, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export type SftpHeaderNode = {
  id: number
  name?: string
  host?: string
  port?: number
  protocol?: string
}

// The standalone-page chrome: a back affordance, the host identity, and a quiet
// reminder that everything here is recorded. Embedded tabs skip this (the tab
// title already names the host).
export function SftpHeader({
  nodeId,
  node,
  loading,
}: {
  nodeId: number
  node?: SftpHeaderNode
  loading?: boolean
}) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b bg-card px-4 py-2.5">
      <Button asChild variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
        <Link href={`/nodes/${nodeId}`} aria-label="返回节点详情">
          <ArrowLeft className="h-4 w-4" />
        </Link>
      </Button>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
        <FolderTree className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-sm font-semibold">
            {loading ? "加载中…" : node?.name || `节点 #${nodeId}`}
          </h1>
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-medium uppercase tracking-wide">
            SFTP
          </Badge>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {node?.host}
          {node?.port ? `:${node.port}` : ""}
        </p>
      </div>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="hidden cursor-default items-center gap-1.5 text-xs text-muted-foreground md:inline-flex">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
              已审计
            </span>
          </TooltipTrigger>
          <TooltipContent>每一次文件操作都会记入审计日志</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </header>
  )
}
