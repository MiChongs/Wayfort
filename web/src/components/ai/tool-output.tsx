"use client"

import * as React from "react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { Check, ChevronDown, ChevronRight, Copy, FileText, Folder } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

// Pretty-print a tool result. We try JSON first (most of our backend tools
// return JSON), fall back to a monospace block for plain text. Long output is
// collapsed by default; theme-aware backgrounds via design tokens.
export function ToolOutputView({ raw, danger }: { raw: string; danger?: boolean }) {
  const parsed = React.useMemo(() => {
    const trimmed = raw.trim()
    if (!trimmed) return null
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed)
      } catch {
        /* */
      }
    }
    return null
  }, [raw])

  const reduce = useReducedMotion()
  const [expanded, setExpanded] = React.useState(false)
  const longText = raw.length > 1200

  const content =
    parsed && typeof parsed === "object" && parsed !== null ? (
      <JsonValue value={parsed} />
    ) : (
      <ScrollArea
        className={cn(
          "rounded-md border max-h-[24rem]",
          danger
            ? "bg-zinc-900 text-zinc-50 border-zinc-700"
            : "bg-muted text-foreground border-border/60",
        )}
      >
        <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-words">
          {longText && !expanded ? (
            <>
              {raw.slice(0, 1200)}
              <button
                onClick={() => setExpanded(true)}
                className="block mt-2 text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded font-sans"
              >
                <ChevronDown className="inline w-3 h-3 mr-1" /> 展开剩余{" "}
                {raw.length - 1200} 字符
              </button>
            </>
          ) : (
            <AnimatePresence mode="wait">
              <motion.span
                key={expanded ? "full" : "preview"}
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={reduce ? { duration: 0 } : { duration: 0.18 }}
              >
                {raw}
              </motion.span>
            </AnimatePresence>
          )}
        </pre>
      </ScrollArea>
    )

  return (
    <div className="group/toolout relative">
      {raw.trim().length > 0 && <CopyOutputButton value={raw} />}
      {content}
    </div>
  )
}

// CopyOutputButton — a hover-revealed copy affordance for any tool result, so
// operators can grab command output without hand-selecting from a <pre>.
function CopyOutputButton({ value }: { value: string }) {
  const [done, setDone] = React.useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="absolute right-1.5 top-1.5 z-10 h-6 w-6 rounded-md border bg-background/90 opacity-0 shadow-sm backdrop-blur transition-opacity group-hover/toolout:opacity-100 focus-visible:opacity-100"
      aria-label="复制输出"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
          toast.success("已复制工具输出")
          setTimeout(() => setDone(false), 1500)
        } catch {
          toast.error("复制失败")
        }
      }}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  )
}

function JsonValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <JsonArray rows={value} />
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>
    if (Array.isArray(v.nodes))
      return <NodeTable nodes={v.nodes as Record<string, unknown>[]} />
    if (Array.isArray(v.sessions)) return <Pre value={v} />
    if (Array.isArray(v.entries))
      return (
        <FileTable
          entries={v.entries as Record<string, unknown>[]}
          pathLabel={String(v.path || "")}
        />
      )
  }
  return <Pre value={value} />
}

function Pre({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2)
  const isLong = text.length > 600
  if (!isLong) {
    return (
      <ScrollArea className="rounded-md border border-border/60 bg-muted max-h-[24rem]">
        <pre className="p-3 text-xs font-mono whitespace-pre-wrap text-foreground">
          {text}
        </pre>
      </ScrollArea>
    )
  }
  return (
    <Collapsible>
      <CollapsibleContent>
        <ScrollArea className="rounded-md border border-border/60 bg-muted max-h-[24rem]">
          <pre className="p-3 text-xs font-mono whitespace-pre-wrap text-foreground">
            {text}
          </pre>
        </ScrollArea>
      </CollapsibleContent>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="group mt-2 inline-flex items-center text-xs text-primary hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded"
        >
          <ChevronRight className="w-3 h-3 mr-1 transition-transform group-data-[state=open]:rotate-90" />
          <span className="group-data-[state=open]:hidden">展开 ({text.length} 字符)</span>
          <span className="group-data-[state=closed]:hidden">收起</span>
        </button>
      </CollapsibleTrigger>
    </Collapsible>
  )
}

function JsonArray({ rows }: { rows: unknown[] }) {
  if (rows.length === 0)
    return <div className="text-xs text-muted-foreground">空数组</div>
  return <Pre value={rows} />
}

function NodeTable({ nodes }: { nodes: Record<string, unknown>[] }) {
  if (nodes.length === 0)
    return <div className="text-xs text-muted-foreground">没有节点</div>
  return (
    <div className="rounded-md border border-border/60 bg-card overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">ID</TableHead>
            <TableHead>名称</TableHead>
            <TableHead className="w-20">协议</TableHead>
            <TableHead>地址</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {nodes.slice(0, 100).map((n, i) => (
            <TableRow key={i}>
              <TableCell className="font-mono text-xs py-1.5">
                {String(n.id ?? "")}
              </TableCell>
              <TableCell className="py-1.5">{String(n.name ?? "")}</TableCell>
              <TableCell className="py-1.5 text-xs">
                {String(n.protocol ?? "")}
              </TableCell>
              <TableCell className="py-1.5 font-mono text-xs">
                {String(n.host ?? "")}:{String(n.port ?? "")}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {nodes.length > 100 && (
        <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t">
          仅显示前 100 条，共 {nodes.length} 条
        </div>
      )}
    </div>
  )
}

function FileTable({
  entries,
  pathLabel,
}: {
  entries: Record<string, unknown>[]
  pathLabel: string
}) {
  return (
    <div>
      {pathLabel && (
        <div className="text-xs text-muted-foreground mb-1 font-mono px-1">
          {pathLabel}
        </div>
      )}
      <div className="rounded-md border border-border/60 bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead>
              <TableHead className="w-20 text-right">大小</TableHead>
              <TableHead className="w-24">权限</TableHead>
              <TableHead>修改时间</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.slice(0, 50).map((e, i) => (
              <TableRow key={i}>
                <TableCell className="py-1.5">
                  <span className="inline-flex items-center gap-1.5">
                    {Boolean(e.is_dir) ? (
                      <Folder className="w-3.5 h-3.5 text-sky-500" />
                    ) : (
                      <FileText className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                    {String(e.name ?? "")}
                  </span>
                </TableCell>
                <TableCell className="py-1.5 text-right font-mono text-xs">
                  {Number(e.size || 0)}
                </TableCell>
                <TableCell className="py-1.5 font-mono text-xs text-muted-foreground">
                  {String(e.mode ?? "")}
                </TableCell>
                <TableCell className="py-1.5 text-xs text-muted-foreground">
                  {String(e.mod_time ?? "").slice(0, 19)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {entries.length > 50 && (
          <div className="px-3 py-1.5 text-[10px] text-muted-foreground border-t">
            仅显示前 50 条，共 {entries.length} 项
          </div>
        )}
      </div>
    </div>
  )
}
