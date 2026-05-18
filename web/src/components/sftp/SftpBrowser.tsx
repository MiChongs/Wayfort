"use client"

import * as React from "react"
import { ArrowDown, ArrowUp, ChevronRight, Files, FolderOpen, Loader2, MousePointer2 } from "lucide-react"
import { fmtBytes, fullTime, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { SftpEntry } from "@/lib/api/services"
import type { SortKey, SortDir } from "./SftpToolbar"
import { iconColorForEntry, iconForEntry } from "./fileIcons"
import { SftpRenameInline } from "./SftpRenameInline"
import { SftpRowContextMenu, type SftpContextActions } from "./SftpContextMenu"

type Props = {
  entries: SftpEntry[]
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey, dir: SortDir) => void
  loading: boolean
  error?: string | null
  isSelected: (path: string) => boolean
  onRowClick: (entry: SftpEntry, index: number, ev: React.MouseEvent) => void
  onRowDoubleClick: (entry: SftpEntry) => void
  // Workspace v2 — actions for the shadcn ContextMenu wrapper. onBeforeContextMenu
  // lets the parent select the right-clicked row before any item fires.
  contextActions: SftpContextActions
  onBeforeContextMenu?: (entry: SftpEntry) => void
  renamingPath: string | null
  onRenameSubmit: (entry: SftpEntry, newName: string) => void
  onRenameCancel: () => void
  // The browser owns the drop-zone so dragging anywhere over the list
  // triggers the upload pipeline. Files are surfaced back to the caller.
  onDropFiles: (files: File[]) => void
  onRetry?: () => void
}

const COLS: { key: SortKey | "actions"; label: string; cls: string; sortable?: boolean }[] = [
  { key: "name", label: "名称", cls: "min-w-0 flex-1", sortable: true },
  { key: "size", label: "大小", cls: "w-20 hidden sm:flex justify-end", sortable: true },
  { key: "type", label: "权限", cls: "w-24 hidden lg:flex font-mono", sortable: true },
  { key: "type", label: "所有者", cls: "w-32 hidden xl:flex truncate" },
  { key: "mtime", label: "修改时间", cls: "w-44 hidden md:flex", sortable: true },
]

export function SftpBrowser({
  entries,
  sortKey,
  sortDir,
  onSort,
  loading,
  error,
  isSelected,
  onRowClick,
  onRowDoubleClick,
  contextActions,
  onBeforeContextMenu,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  onDropFiles,
  onRetry,
}: Props) {
  const [dragOver, setDragOver] = React.useState(false)
  const dragDepth = React.useRef(0)

  const onDragEnter = (ev: React.DragEvent) => {
    if (!ev.dataTransfer?.types.includes("Files")) return
    dragDepth.current++
    setDragOver(true)
  }
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
  }
  const onDragOver = (ev: React.DragEvent) => {
    if (ev.dataTransfer?.types.includes("Files")) ev.preventDefault()
  }
  const onDrop = (ev: React.DragEvent) => {
    ev.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    const files = Array.from(ev.dataTransfer?.files || [])
    if (files.length > 0) onDropFiles(files)
  }

  return (
    <div
      className={cn(
        "relative flex-1 min-h-0 overflow-auto",
        dragOver && "ring-2 ring-primary ring-offset-2 ring-offset-background rounded-md",
      )}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-card border-b text-xs text-muted-foreground select-none">
        <div className="flex items-center gap-2 px-3 py-2">
          <span className="w-6 shrink-0" />
          {COLS.map((c, i) => {
            const active = c.sortable && (c as { key: SortKey }).key === sortKey
            return (
              <span key={i} className={cn("flex items-center gap-1", c.cls)}>
                {c.sortable ? (
                  <button
                    type="button"
                    className={cn("hover:text-foreground inline-flex items-center gap-1", active && "text-foreground")}
                    onClick={() => {
                      const k = (c as { key: SortKey }).key
                      const dir = active ? (sortDir === "asc" ? "desc" : "asc") : "asc"
                      onSort(k, dir)
                    }}
                  >
                    {c.label}
                    {active && (sortDir === "asc" ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
                  </button>
                ) : (
                  c.label
                )}
              </span>
            )
          })}
        </div>
      </div>

      {/* Body */}
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : loading && entries.length === 0 ? (
        <LoadingState />
      ) : entries.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="divide-y">
          {entries.map((e, i) => {
            const Icon = iconForEntry(e)
            const sel = isSelected(e.path)
            const renaming = renamingPath === e.path
            return (
              <SftpRowContextMenu
                key={e.path}
                entry={e}
                actions={contextActions}
                onBeforeOpen={onBeforeContextMenu}
              >
              <li
                role="row"
                aria-selected={sel}
                className={cn(
                  "group flex items-center gap-2 px-3 py-1.5 text-sm cursor-default",
                  "hover:bg-accent/50",
                  sel && "bg-primary/10 hover:bg-primary/15",
                )}
                onClick={(ev) => onRowClick(e, i, ev)}
                onDoubleClick={() => !renaming && onRowDoubleClick(e)}
              >
                <span className="w-6 shrink-0 inline-flex items-center justify-center">
                  <Icon className={cn("w-4 h-4", iconColorForEntry(e))} />
                </span>
                <span className="min-w-0 flex-1 flex items-center gap-1">
                  {renaming ? (
                    <SftpRenameInline
                      initial={e.name}
                      onSubmit={(v) => onRenameSubmit(e, v)}
                      onCancel={onRenameCancel}
                    />
                  ) : (
                    <>
                      <span
                        className={cn(
                          "truncate",
                          e.is_dir && "text-foreground font-medium",
                          e.is_link && "italic",
                        )}
                        title={e.name}
                      >
                        {e.name}
                      </span>
                      {e.is_link && e.link_target && (
                        <span className="text-xs text-muted-foreground inline-flex items-center gap-0.5 truncate">
                          <ChevronRight className="w-3 h-3 shrink-0" /> {e.link_target}
                        </span>
                      )}
                    </>
                  )}
                </span>
                <span className="w-20 hidden sm:flex justify-end tabular-nums text-muted-foreground">
                  {e.is_dir ? "—" : fmtBytes(e.size)}
                </span>
                <span className="w-24 hidden lg:flex font-mono text-xs text-muted-foreground">
                  {e.mode_octal || e.mode}
                </span>
                <span className="w-32 hidden xl:flex truncate text-xs text-muted-foreground" title={`${e.owner}:${e.group}`}>
                  {e.owner || (e.uid != null ? String(e.uid) : "")}
                </span>
                <span
                  className="w-44 hidden md:flex flex-col text-xs text-muted-foreground"
                  title={fullTime(e.mod_time)}
                >
                  <span>{fullTime(e.mod_time)}</span>
                  <span className="opacity-70">{relTime(e.mod_time)}</span>
                </span>
              </li>
              </SftpRowContextMenu>
            )
          })}
        </ul>
      )}

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-primary/5 backdrop-blur-[1px]">
          <div className="rounded-lg border-2 border-dashed border-primary px-6 py-4 bg-card shadow-xl text-center">
            <FolderOpen className="w-8 h-8 text-primary mx-auto mb-1" />
            <div className="text-sm font-medium">放下文件以上传到此目录</div>
          </div>
        </div>
      )}
    </div>
  )
}

function LoadingState() {
  return (
    <ul className="divide-y">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="flex items-center gap-2 px-3 py-2">
          <span className="w-4 h-4 rounded bg-muted animate-pulse" />
          <span className="h-3 rounded bg-muted animate-pulse flex-1 max-w-[60%]" />
          <span className="h-3 rounded bg-muted animate-pulse w-12 hidden sm:block" />
          <span className="h-3 rounded bg-muted animate-pulse w-16 hidden lg:block" />
          <span className="h-3 rounded bg-muted animate-pulse w-32 hidden md:block" />
        </li>
      ))}
      <li className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2 justify-center">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中…
      </li>
    </ul>
  )
}

function EmptyState() {
  return (
    <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-muted-foreground p-10 text-center">
      <Files className="w-10 h-10 mb-2 opacity-50" />
      <div className="text-sm font-medium text-foreground">这个目录是空的</div>
      <div className="text-xs mt-1">把文件拖到这里上传，或使用工具栏新建目录 / 文件。</div>
      <div className="text-xs mt-3 inline-flex items-center gap-1 opacity-70">
        <MousePointer2 className="w-3 h-3" /> 右键空白处也能呼出动作
      </div>
    </div>
  )
}

function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="h-full min-h-[200px] flex flex-col items-center justify-center text-center p-10">
      <div className="text-sm font-medium text-destructive">无法读取目录</div>
      <div className="text-xs text-muted-foreground mt-1 max-w-md break-words">{error}</div>
      {onRetry && (
        <button
          type="button"
          className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          onClick={onRetry}
        >
          重试
        </button>
      )}
    </div>
  )
}
