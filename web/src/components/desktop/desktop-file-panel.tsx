"use client"

// Personal drive panel — the file space that's redirected into the RDP session
// as a drive in "This PC". Rebuilt around a real concurrent upload queue
// (useDriveTransfers), react-dropzone drag-and-drop (files + folders), inline
// rename, drag-to-move onto folders, multi-select batch ops, sort + search, and
// a bottom expandable transfer dock. The toolbar drive button mirrors live
// upload progress via the same store.

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useDropzone } from "react-dropzone"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { toast } from "@/components/ui/sonner"
import {
  ArrowUpDown,
  CheckCircle2,
  ChevronRight,
  ChevronUp,
  Download,
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  FolderUp,
  HardDrive,
  Home,
  Loader2,
  Pencil,
  RefreshCw,
  RotateCw,
  Search,
  Trash2,
  Upload,
  X,
  XCircle,
} from "lucide-react"
import { desktopDriveService } from "@/lib/api/services"
import type { DriveEntry, DriveInfo } from "@/lib/api/types"
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { fmtBytes, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { summarize, useDriveTransfers, type Transfer } from "./useDriveTransfers"

const MOVE_MIME = "application/x-drive-move"
const EASE = [0.22, 1, 0.36, 1] as const

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

function joinPath(base: string, name: string): string {
  return base ? `${base}/${name}` : name
}

type SortKey = "name" | "size" | "time"
type SortDir = "asc" | "desc"

export function DesktopFilePanel({ open, onOpenChange }: Props) {
  const info = useQuery({
    queryKey: ["drive", "info"],
    queryFn: desktopDriveService.info,
    enabled: open,
  })

  const driveName = info.data?.name || "个人文件"
  const disabled = info.data?.enabled === false

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-[480px] flex-col gap-0 p-0 sm:max-w-[480px]">
        <SheetHeader className="space-y-2 border-b px-4 py-3">
          <SheetTitle className="flex items-center gap-2.5 text-base">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/12 text-primary">
              <HardDrive className="h-4 w-4" />
            </span>
            {driveName}
          </SheetTitle>
          <SheetDescription className="text-[12px] leading-relaxed">
            这里的文件会出现在远程桌面「此电脑 › {driveName}」里；远程往这个盘放的东西也能在这下载回来。
          </SheetDescription>
          {info.data && info.data.max_total_mb > 0 && <UsageBar info={info.data} />}
        </SheetHeader>

        {disabled ? (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted-foreground">
            管理员未启用文件盘。
          </div>
        ) : (
          <DriveBrowser open={open} info={info.data} />
        )}

        <DriveTransferDock />
      </SheetContent>
    </Sheet>
  )
}

function UsageBar({ info }: { info: DriveInfo }) {
  const usedPct = info.max_total_mb > 0
    ? Math.min(100, (info.used_bytes / (info.max_total_mb * 1024 * 1024)) * 100)
    : 0
  const total = info.max_total_mb >= 1024 ? `${(info.max_total_mb / 1024).toFixed(0)} GB` : `${info.max_total_mb} MB`
  return (
    <div className="space-y-1 pt-0.5">
      <div className="flex justify-between text-[11px] text-muted-foreground">
        <span>已用 {fmtBytes(info.used_bytes)}</span>
        <span>共 {total}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", usedPct > 90 ? "bg-destructive" : "bg-primary")}
          style={{ width: `${usedPct}%` }}
        />
      </div>
    </div>
  )
}

// ----- File browser ----------------------------------------------------------

function DriveBrowser({ open, info }: { open: boolean; info?: DriveInfo }) {
  const qc = useQueryClient()
  const reduce = useReducedMotion()
  const [path, setPath] = React.useState("")
  const [newFolder, setNewFolder] = React.useState<string | null>(null)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const [sort, setSort] = React.useState<{ key: SortKey; dir: SortDir }>({ key: "name", dir: "asc" })
  const [searchOpen, setSearchOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const [dropTarget, setDropTarget] = React.useState<string | null>(null)
  const folderInput = React.useRef<HTMLInputElement | null>(null)
  const internalDrag = React.useRef(false)

  const canUpload = info?.allow_upload !== false
  const canDownload = info?.allow_download !== false

  const enqueue = useDriveTransfers((s) => s.enqueue)
  const doneCount = useDriveTransfers((s) => summarize(s.transfers).doneCount)

  const list = useQuery({
    queryKey: ["drive", "list", path],
    queryFn: () => desktopDriveService.list(path),
    enabled: open && info?.enabled !== false,
  })

  const refresh = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["drive", "list"] })
    qc.invalidateQueries({ queryKey: ["drive", "info"] })
  }, [qc])

  // Refresh the listing whenever an upload lands.
  const prevDone = React.useRef(doneCount)
  React.useEffect(() => {
    if (doneCount > prevDone.current) refresh()
    prevDone.current = doneCount
  }, [doneCount, refresh])

  // Selection + rename reset on navigation.
  React.useEffect(() => {
    setSelected(new Set())
    setRenaming(null)
  }, [path])

  const entries = list.data?.entries ?? []
  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
    const sign = sort.dir === "asc" ? 1 : -1
    return [...base].sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1 // folders first, always
      if (sort.key === "size") return sign * (a.size - b.size)
      if (sort.key === "time") return sign * (new Date(a.mod_time).getTime() - new Date(b.mod_time).getTime())
      return sign * a.name.localeCompare(b.name)
    })
  }, [entries, query, sort])

  const { getRootProps, getInputProps, isDragActive, open: openPicker } = useDropzone({
    onDrop: (accepted) => {
      if (!canUpload || accepted.length === 0) return
      const n = enqueue(accepted, path)
      if (n > 0) toast.success(n > 1 ? `已加入 ${n} 个文件到上传队列` : "已加入上传队列")
    },
    noClick: true,
    noKeyboard: true,
    disabled: !canUpload,
  })

  const del = useMutation({
    mutationFn: (name: string) => desktopDriveService.remove(joinPath(path, name)),
    onSuccess: () => refresh(),
    onError: (e: { message?: string }) => toast.error(e.message || "删除失败"),
  })

  const mkdir = useMutation({
    mutationFn: (name: string) => desktopDriveService.mkdir(joinPath(path, name)),
    onSuccess: () => { setNewFolder(null); refresh() },
    onError: (e: { message?: string }) => toast.error(e.message || "新建失败"),
  })

  async function doRename(oldName: string, nextName: string) {
    const trimmed = nextName.trim()
    setRenaming(null)
    if (!trimmed || trimmed === oldName || trimmed.includes("/")) return
    try {
      await desktopDriveService.rename(joinPath(path, oldName), joinPath(path, trimmed))
      refresh()
    } catch (e) {
      toast.error((e as { message?: string }).message || "重命名失败")
    }
  }

  async function moveInto(names: string[], targetDir: string) {
    const moving = names.filter((n) => joinPath(path, n) !== joinPath(targetDir, n) && targetDir !== joinPath(path, n))
    if (moving.length === 0) return
    let ok = 0
    for (const name of moving) {
      try {
        await desktopDriveService.rename(joinPath(path, name), joinPath(targetDir, name))
        ok++
      } catch (e) {
        toast.error(`${name}：${(e as { message?: string }).message || "移动失败"}`)
      }
    }
    if (ok > 0) {
      toast.success(ok > 1 ? `已移动 ${ok} 项` : "已移动")
      setSelected(new Set())
      refresh()
    }
  }

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  async function batchDelete() {
    const names = [...selected]
    setSelected(new Set())
    await Promise.allSettled(names.map((n) => desktopDriveService.remove(joinPath(path, n))))
    toast.success(`已删除 ${names.length} 项`)
    refresh()
  }

  function batchDownload() {
    const files = filtered.filter((e) => !e.is_dir && selected.has(e.name))
    files.forEach((e, i) => {
      window.setTimeout(() => {
        const a = document.createElement("a")
        a.href = desktopDriveService.downloadURL(joinPath(path, e.name))
        a.download = e.name
        document.body.appendChild(a)
        a.click()
        a.remove()
      }, i * 350)
    })
    setSelected(new Set())
  }

  const segments = path ? path.split("/") : []
  const selectedCount = selected.size

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        {canUpload && (
          <Button size="sm" className="h-8" onClick={openPicker}>
            <Upload className="h-3.5 w-3.5" /> 上传
          </Button>
        )}
        {canUpload && (
          <Button size="sm" variant="outline" className="h-8 px-2.5" onClick={() => folderInput.current?.click()} title="上传文件夹">
            <FolderUp className="h-3.5 w-3.5" />
          </Button>
        )}
        {canUpload && (
          <Button size="sm" variant="outline" className="h-8 px-2.5" onClick={() => setNewFolder("")} title="新建文件夹">
            <FolderPlus className="h-3.5 w-3.5" />
          </Button>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setSearchOpen((v) => !v)} title="搜索">
            <Search className={cn("h-3.5 w-3.5", searchOpen && "text-primary")} />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon" variant="ghost" className="h-8 w-8" title="排序">
                <ArrowUpDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuLabel className="text-[11px]">排序方式</DropdownMenuLabel>
              {(["name", "time", "size"] as SortKey[]).map((k) => (
                <DropdownMenuItem
                  key={k}
                  className="text-xs"
                  onSelect={() => setSort((s) => ({ key: k, dir: s.key === k && s.dir === "asc" ? "desc" : "asc" }))}
                >
                  {k === "name" ? "名称" : k === "time" ? "修改时间" : "大小"}
                  {sort.key === k && <span className="ml-auto text-muted-foreground">{sort.dir === "asc" ? "↑" : "↓"}</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="icon" variant="ghost" className="h-8 w-8" onClick={refresh} title="刷新">
            <RefreshCw className={cn("h-3.5 w-3.5", list.isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Search */}
      <AnimatePresence initial={false}>
        {searchOpen && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="overflow-hidden border-b"
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="在当前文件夹搜索…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                onKeyDown={(e) => { if (e.key === "Escape") { setQuery(""); setSearchOpen(false) } }}
              />
              {query && (
                <button onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Breadcrumb */}
      <div className="flex items-center gap-0.5 overflow-x-auto border-b px-3 py-2 text-xs no-scrollbar">
        <Crumb
          label="根目录"
          icon
          active={!path}
          onClick={() => setPath("")}
          onDropMove={(names) => moveInto(names, "")}
          dropTargetSet={dropTarget === " root"}
          onDropTarget={(v) => setDropTarget(v ? " root" : null)}
        />
        {segments.map((seg, i) => {
          const segPath = segments.slice(0, i + 1).join("/")
          return (
            <React.Fragment key={i}>
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              <Crumb
                label={seg}
                active={i === segments.length - 1}
                onClick={() => setPath(segPath)}
                onDropMove={(names) => moveInto(names, segPath)}
                dropTargetSet={dropTarget === segPath}
                onDropTarget={(v) => setDropTarget(v ? segPath : null)}
              />
            </React.Fragment>
          )
        })}
      </div>

      {/* New folder */}
      {newFolder !== null && (
        <form
          className="flex items-center gap-2 border-b bg-accent/30 px-3 py-2"
          onSubmit={(e) => { e.preventDefault(); if (newFolder.trim()) mkdir.mutate(newFolder.trim()) }}
        >
          <Folder className="h-4 w-4 text-muted-foreground" />
          <Input
            autoFocus
            value={newFolder}
            onChange={(e) => setNewFolder(e.target.value)}
            placeholder="文件夹名称"
            className="h-8 flex-1"
            onKeyDown={(e) => { if (e.key === "Escape") setNewFolder(null) }}
          />
          <Button type="submit" size="sm" className="h-8" disabled={!newFolder.trim() || mkdir.isPending}>创建</Button>
          <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => setNewFolder(null)}>取消</Button>
        </form>
      )}

      {/* Batch bar */}
      <AnimatePresence initial={false}>
        {selectedCount > 0 && (
          <motion.div
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? undefined : { height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: EASE }}
            className="overflow-hidden border-b bg-primary/[0.06]"
          >
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="font-medium text-foreground">已选 {selectedCount} 项</span>
              <div className="ml-auto flex items-center gap-1">
                {canDownload && (
                  <Button size="sm" variant="ghost" className="h-7" onClick={batchDownload}>
                    <Download className="h-3.5 w-3.5" /> 下载
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="h-7 text-destructive hover:text-destructive" onClick={batchDelete}>
                  <Trash2 className="h-3.5 w-3.5" /> 删除
                </Button>
                <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelected(new Set())}>取消</Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* List + dropzone */}
      <div {...getRootProps({ className: "relative min-h-0 flex-1 overflow-y-auto" })}>
        <input {...getInputProps()} />
        <input
          ref={folderInput}
          type="file"
          multiple
          className="hidden"
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(e) => {
            if (e.target.files?.length) {
              const n = enqueue(Array.from(e.target.files), path)
              if (n > 0) toast.success(`已加入 ${n} 个文件到上传队列`)
            }
            e.target.value = ""
          }}
        />

        {isDragActive && !internalDrag.current && canUpload && (
          <div className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-xl border-2 border-dashed border-primary bg-primary/5 text-sm font-medium text-primary">
            <span className="flex flex-col items-center gap-1.5">
              <Upload className="h-6 w-6" />
              松手上传到「{path ? segments[segments.length - 1] : "根目录"}」
            </span>
          </div>
        )}

        {list.isLoading ? (
          <div className="space-y-1 p-3">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-11 animate-pulse rounded-md bg-muted/50" />)}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState query={query} canUpload={canUpload} onPick={openPicker} />
        ) : (
          <ul className="p-1.5">
            {filtered.map((e) => (
              <DriveRow
                key={e.name}
                entry={e}
                path={path}
                selected={selected.has(e.name)}
                renaming={renaming === e.name}
                canDownload={canDownload}
                canUpload={canUpload}
                isDropTarget={dropTarget === e.name}
                onToggleSelect={() => toggleSelect(e.name)}
                onOpen={() => e.is_dir && setPath(joinPath(path, e.name))}
                onStartRename={() => setRenaming(e.name)}
                onRename={(v) => doRename(e.name, v)}
                onCancelRename={() => setRenaming(null)}
                onDelete={() => del.mutate(e.name)}
                deleting={del.isPending && del.variables === e.name}
                onDragStartRow={(ev) => {
                  internalDrag.current = true
                  const names = selected.has(e.name) ? [...selected] : [e.name]
                  ev.dataTransfer.setData(MOVE_MIME, JSON.stringify(names))
                  ev.dataTransfer.effectAllowed = "move"
                }}
                onDragEndRow={() => { internalDrag.current = false; setDropTarget(null) }}
                onDropMove={(names) => moveInto(names, joinPath(path, e.name))}
                onDropTarget={(v) => setDropTarget(v ? e.name : null)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function EmptyState({ query, canUpload, onPick }: { query: string; canUpload: boolean; onPick: () => void }) {
  if (query) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
        <Search className="h-7 w-7 opacity-40" />
        没有匹配「{query}」的文件
      </div>
    )
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm text-muted-foreground">
      <Folder className="h-8 w-8 opacity-40" />
      这个文件夹是空的
      {canUpload && (
        <button onClick={onPick} className="text-xs text-primary hover:underline">
          把文件拖进来，或点这里选择
        </button>
      )}
    </div>
  )
}

// ----- Row -------------------------------------------------------------------

function DriveRow({
  entry, path, selected, renaming, canDownload, canUpload, isDropTarget, deleting,
  onToggleSelect, onOpen, onStartRename, onRename, onCancelRename, onDelete,
  onDragStartRow, onDragEndRow, onDropMove, onDropTarget,
}: {
  entry: DriveEntry
  path: string
  selected: boolean
  renaming: boolean
  canDownload: boolean
  canUpload: boolean
  isDropTarget: boolean
  deleting: boolean
  onToggleSelect: () => void
  onOpen: () => void
  onStartRename: () => void
  onRename: (v: string) => void
  onCancelRename: () => void
  onDelete: () => void
  onDragStartRow: (e: React.DragEvent) => void
  onDragEndRow: () => void
  onDropMove: (names: string[]) => void
  onDropTarget: (v: boolean) => void
}) {
  const [value, setValue] = React.useState(entry.name)
  // Enter submits the form AND blurs the input — guard so the rename fires once,
  // not twice (the second would target the already-renamed, now-missing name).
  const committedRef = React.useRef(false)
  React.useEffect(() => {
    if (renaming) { setValue(entry.name); committedRef.current = false }
  }, [renaming, entry.name])
  const commitRename = () => {
    if (committedRef.current) return
    committedRef.current = true
    onRename(value)
  }

  const Icon = entry.is_dir ? Folder : iconForFile(entry.name)
  const acceptsDrop = entry.is_dir && canUpload

  return (
    <li
      draggable={canUpload && !renaming}
      onDragStart={onDragStartRow}
      onDragEnd={onDragEndRow}
      onDragOver={(e) => {
        if (!acceptsDrop || !e.dataTransfer.types.includes(MOVE_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "move"
        onDropTarget(true)
      }}
      onDragLeave={() => acceptsDrop && onDropTarget(false)}
      onDrop={(e) => {
        if (!acceptsDrop || !e.dataTransfer.types.includes(MOVE_MIME)) return
        e.preventDefault()
        e.stopPropagation()
        onDropTarget(false)
        try {
          const names = JSON.parse(e.dataTransfer.getData(MOVE_MIME)) as string[]
          if (Array.isArray(names) && !names.includes(entry.name)) onDropMove(names)
        } catch { /* ignore malformed payload */ }
      }}
      className={cn(
        "group flex items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors",
        selected ? "bg-primary/[0.07]" : "hover:bg-accent/40",
        isDropTarget && "ring-2 ring-primary ring-inset bg-primary/5",
      )}
    >
      <span className={cn("grid w-5 shrink-0 place-items-center", selected ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
        <Checkbox checked={selected} onCheckedChange={onToggleSelect} className="h-4 w-4" />
      </span>

      <span className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-md",
        entry.is_dir ? "bg-[#e8a55a]/14 text-[#c2862c] dark:text-[#e8a55a]" : "bg-muted text-muted-foreground",
      )}>
        <Icon className="h-4 w-4" />
      </span>

      {renaming ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-1.5"
          onSubmit={(e) => { e.preventDefault(); commitRename() }}
        >
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => { if (e.key === "Escape") { committedRef.current = true; onCancelRename() } }}
            className="h-7 flex-1 text-sm"
          />
        </form>
      ) : (
        <button
          className="min-w-0 flex-1 text-left"
          onClick={onOpen}
          disabled={!entry.is_dir}
        >
          <span className={cn("block truncate text-sm", entry.is_dir && "cursor-pointer group-hover:underline")}>{entry.name}</span>
          <span className="block text-[11px] text-muted-foreground">
            {entry.is_dir ? "文件夹" : fmtBytes(entry.size)} · {relTime(entry.mod_time)}
          </span>
        </button>
      )}

      {!renaming && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          {canUpload && (
            <RowBtn icon={Pencil} title="重命名" onClick={onStartRename} />
          )}
          {!entry.is_dir && canDownload && (
            <a
              href={desktopDriveService.downloadURL(joinPath(path, entry.name))}
              download={entry.name}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="下载"
            >
              <Download className="h-3.5 w-3.5" />
            </a>
          )}
          <button
            onClick={onDelete}
            disabled={deleting}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            title="删除"
          >
            {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      )}
    </li>
  )
}

function RowBtn({ icon: Icon, title, onClick }: { icon: React.ComponentType<{ className?: string }>; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

function Crumb({
  label, icon, active, onClick, onDropMove, dropTargetSet, onDropTarget,
}: {
  label: string
  icon?: boolean
  active: boolean
  onClick: () => void
  onDropMove: (names: string[]) => void
  dropTargetSet: boolean
  onDropTarget: (v: boolean) => void
}) {
  return (
    <button
      onClick={onClick}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(MOVE_MIME)) return
        e.preventDefault()
        onDropTarget(true)
      }}
      onDragLeave={() => onDropTarget(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(MOVE_MIME)) return
        e.preventDefault()
        e.stopPropagation()
        onDropTarget(false)
        try {
          const names = JSON.parse(e.dataTransfer.getData(MOVE_MIME)) as string[]
          if (Array.isArray(names)) onDropMove(names)
        } catch { /* ignore */ }
      }}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 truncate rounded px-1.5 py-0.5 transition-colors hover:bg-accent",
        active && "text-foreground",
        dropTargetSet && "bg-primary/15 text-primary ring-1 ring-primary",
      )}
    >
      {icon && <Home className="h-3 w-3" />}
      {label}
    </button>
  )
}

// ----- Transfer dock ---------------------------------------------------------

function DriveTransferDock() {
  const transfers = useDriveTransfers((s) => s.transfers)
  const cancel = useDriveTransfers((s) => s.cancel)
  const cancelAll = useDriveTransfers((s) => s.cancelAll)
  const retry = useDriveTransfers((s) => s.retry)
  const retryFailed = useDriveTransfers((s) => s.retryFailed)
  const clearFinished = useDriveTransfers((s) => s.clearFinished)
  const reduce = useReducedMotion()
  const [expanded, setExpanded] = React.useState(false)

  const s = summarize(transfers)
  if (transfers.length === 0) return null

  const barText = s.hasActive
    ? `上传中 ${s.uploadingCount || s.activeCount} 个 · ${s.pct}%`
    : `${s.doneCount} 个已完成${s.failedCount ? ` · ${s.failedCount} 个失败` : ""}`

  return (
    <div className="relative shrink-0 border-t bg-card">
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: 8 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="absolute bottom-full left-0 right-0 flex max-h-[340px] flex-col border-t bg-card shadow-[0_-8px_24px_-12px_rgba(20,20,19,0.25)]"
          >
            <div className="flex items-center gap-2 border-b px-3 py-2 text-xs">
              <span className="font-medium">传输队列</span>
              <span className="text-muted-foreground">{transfers.length} 项</span>
              <div className="ml-auto flex items-center gap-1">
                {s.failedCount > 0 && (
                  <Button size="sm" variant="ghost" className="h-7" onClick={retryFailed}>
                    <RotateCw className="h-3.5 w-3.5" /> 重试失败
                  </Button>
                )}
                {s.hasActive && (
                  <Button size="sm" variant="ghost" className="h-7" onClick={cancelAll}>全部取消</Button>
                )}
                <Button size="sm" variant="ghost" className="h-7" onClick={clearFinished} disabled={s.hasActive && s.doneCount + s.failedCount + s.canceledCount === 0}>
                  清除已完成
                </Button>
              </div>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
              {transfers.map((t) => (
                <TransferRow key={t.id} t={t} onCancel={() => cancel(t.id)} onRetry={() => retry(t.id)} />
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left"
      >
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary/12 text-primary">
          {s.hasActive ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : s.failedCount ? <XCircle className="h-3.5 w-3.5 text-destructive" /> : <CheckCircle2 className="h-3.5 w-3.5 text-[#5db872]" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium text-foreground">{barText}</span>
          </div>
          {s.hasActive && (
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${s.pct}%` }} />
            </div>
          )}
        </div>
        <ChevronUp className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-180")} />
      </button>
    </div>
  )
}

const STATUS_META: Record<Transfer["status"], { label: string; tone: string }> = {
  queued: { label: "排队中", tone: "text-muted-foreground" },
  uploading: { label: "上传中", tone: "text-primary" },
  done: { label: "完成", tone: "text-[#5db872]" },
  error: { label: "失败", tone: "text-destructive" },
  canceled: { label: "已取消", tone: "text-muted-foreground" },
}

function TransferRow({ t, onCancel, onRetry }: { t: Transfer; onCancel: () => void; onRetry: () => void }) {
  const meta = STATUS_META[t.status]
  const pct = t.size > 0 ? Math.round((t.sent / t.size) * 100) : t.status === "done" ? 100 : 0
  const Icon = iconForFile(t.name)
  const active = t.status === "uploading" || t.status === "queued"
  return (
    <li className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px]">{t.name}</span>
          <span className={cn("shrink-0 text-[10px] font-medium", meta.tone)}>{meta.label}</span>
        </div>
        {t.status === "error" ? (
          <span className="block truncate text-[11px] text-destructive">{t.error || "上传失败"}</span>
        ) : (
          <div className="mt-1 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={cn("h-full rounded-full transition-[width] duration-200", t.status === "done" ? "bg-[#5db872]" : t.status === "canceled" ? "bg-muted-foreground/40" : "bg-primary")}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
              {t.status === "uploading" ? `${fmtBytes(t.sent)} / ${fmtBytes(t.size)}` : fmtBytes(t.size)}
            </span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {active ? (
          <RowBtn icon={X} title="取消" onClick={onCancel} />
        ) : t.status === "error" ? (
          <RowBtn icon={RotateCw} title="重试" onClick={onRetry} />
        ) : (
          <span className="grid h-7 w-7 place-items-center text-[#5db872]">
            {t.status === "done" ? <CheckCircle2 className="h-3.5 w-3.5" /> : null}
          </span>
        )}
      </div>
    </li>
  )
}

// ----- file-type icons -------------------------------------------------------

function iconForFile(name: string): React.ComponentType<{ className?: string }> {
  const ext = name.split(".").pop()?.toLowerCase() || ""
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "heic"].includes(ext)) return FileImage
  if (["mp4", "mkv", "mov", "avi", "webm", "flv", "wmv"].includes(ext)) return FileVideo
  if (["mp3", "wav", "flac", "aac", "ogg", "m4a"].includes(ext)) return FileAudio
  if (["zip", "rar", "7z", "tar", "gz", "bz2", "xz"].includes(ext)) return FileArchive
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return FileSpreadsheet
  if (["js", "ts", "tsx", "jsx", "go", "py", "java", "c", "cpp", "rs", "sh", "json", "yaml", "yml", "html", "css", "sql"].includes(ext)) return FileCode2
  if (["txt", "md", "doc", "docx", "pdf", "rtf", "log"].includes(ext)) return FileText
  return FileIcon
}
