"use client"

import * as React from "react"
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Download,
  FolderOpen,
  Loader2,
  Pencil,
  Trash2,
  Upload,
} from "lucide-react"
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { fmtBytes, relTime, fullTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { SftpEntry, SftpSearchHit } from "@/lib/api/services"
import type { SortKey, SortDir } from "./SftpToolbar"
import { iconColorForEntry, iconForEntry } from "./fileIcons"
import { SftpRenameInline } from "./SftpRenameInline"
import { SftpRowContextMenu, type SftpContextActions } from "./SftpContextMenu"
import { readMovePayload, SFTP_MOVE_MIME } from "./sftpDnd"

type Props = {
  entries: (SftpEntry | SftpSearchHit)[]
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey, dir: SortDir) => void
  loading: boolean
  error?: string | null
  onRetry?: () => void
  isSelected: (path: string) => boolean
  selectedPaths: string[]
  allSelected: boolean
  onToggleAll: () => void
  onRowClick: (entry: SftpEntry, index: number, ev: React.MouseEvent) => void
  onRowDoubleClick: (entry: SftpEntry) => void
  onToggleRow: (entry: SftpEntry, index: number) => void
  contextActions: SftpContextActions
  onBeforeContextMenu?: (entry: SftpEntry) => void
  renamingPath: string | null
  onRenameSubmit: (entry: SftpEntry, newName: string) => void
  onRenameCancel: () => void
  onDropFiles: (files: File[]) => void
  onMove: (paths: string[], targetDir: string) => void
  canWrite: boolean
  showLocation?: boolean
}

const HEAD: { key: SortKey; label: string; cls: string }[] = [
  { key: "size", label: "大小", cls: "w-24 text-right hidden sm:table-cell" },
  { key: "type", label: "权限", cls: "w-28 hidden lg:table-cell" },
  { key: "mtime", label: "修改时间", cls: "w-44 hidden md:table-cell" },
]

export function SftpBrowser({
  entries,
  sortKey,
  sortDir,
  onSort,
  loading,
  error,
  onRetry,
  isSelected,
  selectedPaths,
  allSelected,
  onToggleAll,
  onRowClick,
  onRowDoubleClick,
  onToggleRow,
  contextActions,
  onBeforeContextMenu,
  renamingPath,
  onRenameSubmit,
  onRenameCancel,
  onDropFiles,
  onMove,
  canWrite,
  showLocation,
}: Props) {
  const [dragFiles, setDragFiles] = React.useState(false)
  const dragDepth = React.useRef(0)

  const onDragEnter = (ev: React.DragEvent) => {
    if (!ev.dataTransfer?.types.includes("Files")) return
    dragDepth.current++
    setDragFiles(true)
  }
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragFiles(false)
  }
  const onDragOver = (ev: React.DragEvent) => {
    if (ev.dataTransfer?.types.includes("Files")) ev.preventDefault()
  }
  const onDrop = (ev: React.DragEvent) => {
    if (!ev.dataTransfer?.types.includes("Files")) return
    ev.preventDefault()
    dragDepth.current = 0
    setDragFiles(false)
    const files = Array.from(ev.dataTransfer.files || [])
    if (files.length > 0) onDropFiles(files)
  }

  const sortArrow = (key: SortKey) =>
    key === sortKey ? (
      sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
    ) : null

  return (
    <div
      className="relative min-h-0 flex-1 overflow-auto"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <table className="w-full caption-bottom text-sm">
        <TableHeader className="sticky top-0 z-10 bg-card">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-11 pl-3">
              <Checkbox
                checked={allSelected && entries.length > 0}
                onCheckedChange={onToggleAll}
                aria-label="全选"
                disabled={entries.length === 0}
              />
            </TableHead>
            <TableHead>
              <SortButton label="名称" active={sortKey === "name"} onClick={() => onSort("name", sortKey === "name" && sortDir === "asc" ? "desc" : "asc")}>
                {sortArrow("name")}
              </SortButton>
            </TableHead>
            {HEAD.map((h) => (
              <TableHead key={h.label} className={h.cls}>
                <SortButton
                  label={h.label}
                  active={sortKey === h.key}
                  align={h.cls.includes("text-right") ? "right" : "left"}
                  onClick={() => onSort(h.key, sortKey === h.key && sortDir === "asc" ? "desc" : "asc")}
                >
                  {sortArrow(h.key)}
                </SortButton>
              </TableHead>
            ))}
            <TableHead className="w-[7.5rem]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {error ? null : entries.map((e, i) => (
            <Row
              key={(e as SftpSearchHit).dir ? `${(e as SftpSearchHit).dir}/${e.name}` : e.path}
              entry={e}
              index={i}
              selected={isSelected(e.path)}
              renaming={renamingPath === e.path}
              canWrite={canWrite}
              selectedPaths={selectedPaths}
              showLocation={showLocation}
              contextActions={contextActions}
              onBeforeContextMenu={onBeforeContextMenu}
              onRowClick={onRowClick}
              onRowDoubleClick={onRowDoubleClick}
              onToggleRow={onToggleRow}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              onMove={onMove}
            />
          ))}
        </TableBody>
      </table>

      {/* States */}
      {error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : loading && entries.length === 0 ? (
        <LoadingState />
      ) : entries.length === 0 ? (
        <EmptyState search={showLocation} />
      ) : null}

      {/* Upload overlay */}
      {dragFiles && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-primary/5 backdrop-blur-[1px]">
          <div className="flex flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-primary bg-card px-7 py-5 text-sm font-medium shadow-xl">
            <Upload className="h-6 w-6 text-primary" />
            放下文件以上传到当前目录
          </div>
        </div>
      )}
    </div>
  )
}

function Row({
  entry,
  index,
  selected,
  renaming,
  canWrite,
  selectedPaths,
  showLocation,
  contextActions,
  onBeforeContextMenu,
  onRowClick,
  onRowDoubleClick,
  onToggleRow,
  onRenameSubmit,
  onRenameCancel,
  onMove,
}: {
  entry: SftpEntry | SftpSearchHit
  index: number
  selected: boolean
  renaming: boolean
  canWrite: boolean
  selectedPaths: string[]
  showLocation?: boolean
  contextActions: SftpContextActions
  onBeforeContextMenu?: (e: SftpEntry) => void
  onRowClick: (e: SftpEntry, i: number, ev: React.MouseEvent) => void
  onRowDoubleClick: (e: SftpEntry) => void
  onToggleRow: (e: SftpEntry, index: number) => void
  onRenameSubmit: (e: SftpEntry, name: string) => void
  onRenameCancel: () => void
  onMove: (paths: string[], targetDir: string) => void
}) {
  const Icon = iconForEntry(entry)
  const [dropOver, setDropOver] = React.useState(false)
  const acceptsDrop = entry.is_dir && canWrite
  const dir = (entry as SftpSearchHit).dir

  return (
    <SftpRowContextMenu entry={entry} actions={contextActions} onBeforeOpen={onBeforeContextMenu}>
      <TableRow
        data-state={selected ? "selected" : undefined}
        draggable={canWrite && !renaming}
        onClick={(ev) => onRowClick(entry, index, ev)}
        onDoubleClick={() => !renaming && onRowDoubleClick(entry)}
        onDragStart={(ev) => {
          const paths = selected && selectedPaths.length > 1 ? selectedPaths : [entry.path]
          ev.dataTransfer.setData(SFTP_MOVE_MIME, JSON.stringify({ paths }))
          ev.dataTransfer.effectAllowed = "move"
        }}
        onDragOver={(ev) => {
          if (!acceptsDrop || !ev.dataTransfer.types.includes(SFTP_MOVE_MIME)) return
          ev.preventDefault()
          ev.dataTransfer.dropEffect = "move"
          setDropOver(true)
        }}
        onDragLeave={() => setDropOver(false)}
        onDrop={(ev) => {
          setDropOver(false)
          if (!acceptsDrop) return
          const paths = readMovePayload(ev.dataTransfer)
          if (!paths || paths.includes(entry.path)) return
          ev.preventDefault()
          ev.stopPropagation()
          onMove(paths, entry.path)
        }}
        className={cn(
          "group cursor-default",
          dropOver && "bg-primary/5 ring-1 ring-inset ring-primary",
        )}
      >
        <TableCell className="pl-3">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleRow(entry, index)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`选择 ${entry.name}`}
            className={cn(selected ? "opacity-100" : "opacity-0 transition-opacity group-hover:opacity-100")}
          />
        </TableCell>

        <TableCell className="max-w-0">
          <div className="flex items-center gap-2">
            <Icon className={cn("h-4 w-4 shrink-0", iconColorForEntry(entry))} />
            {renaming ? (
              <SftpRenameInline
                initial={entry.name}
                onSubmit={(v) => onRenameSubmit(entry, v)}
                onCancel={onRenameCancel}
              />
            ) : (
              <div className="min-w-0">
                <div className="flex items-center gap-1">
                  <span className={cn("truncate", entry.is_dir && "font-medium", entry.is_link && "italic")} title={entry.name}>
                    {entry.name}
                  </span>
                  {entry.is_link && entry.link_target && (
                    <span className="inline-flex shrink-0 items-center gap-0.5 truncate text-xs text-muted-foreground">
                      <ChevronRight className="h-3 w-3" /> {entry.link_target}
                    </span>
                  )}
                </div>
                {showLocation && dir && (
                  <span className="block truncate font-mono text-[11px] text-muted-foreground" title={dir}>
                    {dir}
                  </span>
                )}
              </div>
            )}
          </div>
        </TableCell>

        <TableCell className="hidden text-right tabular-nums text-muted-foreground sm:table-cell">
          {entry.is_dir ? "—" : fmtBytes(entry.size)}
        </TableCell>
        <TableCell className="hidden font-mono text-xs text-muted-foreground lg:table-cell">
          {entry.mode_octal || entry.mode}
        </TableCell>
        <TableCell className="hidden text-xs text-muted-foreground md:table-cell" title={fullTime(entry.mod_time)}>
          {relTime(entry.mod_time)}
        </TableCell>

        <TableCell className="py-0 pr-2">
          {!renaming && (
            <div className="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
              {!entry.is_dir && (
                <RowAction icon={Download} label="下载" onClick={() => contextActions.onDownload(entry)} />
              )}
              {canWrite && (
                <RowAction icon={Pencil} label="重命名" onClick={() => contextActions.onRename(entry)} />
              )}
              {canWrite && (
                <RowAction
                  icon={Trash2}
                  label="删除"
                  danger
                  onClick={() => contextActions.onDelete(entry)}
                />
              )}
            </div>
          )}
        </TableCell>
      </TableRow>
    </SftpRowContextMenu>
  )
}

function RowAction({
  icon: Icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <Button
      size="icon"
      variant="ghost"
      className={cn("h-7 w-7 text-muted-foreground", danger ? "hover:bg-destructive/10 hover:text-destructive" : "hover:text-foreground")}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      aria-label={label}
      title={label}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  )
}

function SortButton({
  label,
  active,
  onClick,
  align = "left",
  children,
}: {
  label: string
  active: boolean
  onClick: () => void
  align?: "left" | "right"
  children?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium transition-colors hover:text-foreground",
        active ? "text-foreground" : "text-muted-foreground",
        align === "right" && "flex-row-reverse",
      )}
    >
      {label}
      {children}
    </button>
  )
}

function LoadingState() {
  return (
    <div className="divide-y">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-3 py-2.5">
          <span className="h-4 w-4 shrink-0 animate-pulse rounded bg-muted" />
          <span className="h-3.5 max-w-[50%] flex-1 animate-pulse rounded bg-muted" />
          <span className="hidden h-3 w-12 animate-pulse rounded bg-muted sm:block" />
          <span className="hidden h-3 w-32 animate-pulse rounded bg-muted md:block" />
        </div>
      ))}
    </div>
  )
}

function EmptyState({ search }: { search?: boolean }) {
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 p-10 text-center">
      <FolderOpen className="h-10 w-10 text-muted-foreground/40" />
      <div className="text-sm font-medium">{search ? "没有匹配的文件" : "这个目录是空的"}</div>
      {!search && (
        <div className="text-xs text-muted-foreground">把文件拖到这里上传，或用工具栏新建目录、文件</div>
      )}
    </div>
  )
}

function ErrorState({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1.5 p-10 text-center">
      <div className="text-sm font-medium text-destructive">无法读取目录</div>
      <div className="max-w-md break-words text-xs text-muted-foreground">{error}</div>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
          重试
        </Button>
      )}
    </div>
  )
}
