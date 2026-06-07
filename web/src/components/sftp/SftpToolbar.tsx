"use client"

import * as React from "react"
import {
  ArrowUp,
  ArrowUpDown,
  Check,
  FilePlus,
  FolderPlus,
  FolderUp,
  Home,
  LayoutGrid,
  List,
  RefreshCw,
  Search,
  SearchCode,
  Upload,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { segments } from "./pathUtil"
import { readMovePayload, SFTP_MOVE_MIME } from "./sftpDnd"

export type SortKey = "name" | "size" | "mtime" | "type"
export type SortDir = "asc" | "desc"
export type SftpView = "list" | "grid"

const SORT_FIELDS: { key: SortKey; label: string }[] = [
  { key: "name", label: "名称" },
  { key: "size", label: "大小" },
  { key: "mtime", label: "修改时间" },
  { key: "type", label: "类型 / 权限" },
]

type Props = {
  path: string
  onNavigate: (path: string) => void
  onUp: () => void
  onRefresh: () => void
  loading?: boolean
  filter: string
  onFilterChange: (q: string) => void
  onRecursiveSearch: (q: string) => void
  onClearSearch: () => void
  searching?: boolean
  view: SftpView
  onViewChange: (v: SftpView) => void
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey, dir: SortDir) => void
  showHidden: boolean
  onToggleHidden: () => void
  onUpload: () => void
  onUploadFolder: () => void
  onNewFolder: () => void
  onNewFile: () => void
  canWrite: boolean
  onMove: (paths: string[], targetDir: string) => void
  pathInputRef?: React.Ref<HTMLInputElement>
}

export function SftpToolbar({
  path,
  onNavigate,
  onUp,
  onRefresh,
  loading,
  filter,
  onFilterChange,
  onRecursiveSearch,
  onClearSearch,
  searching,
  view,
  onViewChange,
  sortKey,
  sortDir,
  onSort,
  showHidden,
  onToggleHidden,
  onUpload,
  onUploadFolder,
  onNewFolder,
  onNewFile,
  canWrite,
  onMove,
  pathInputRef,
}: Props) {
  const [pathDraft, setPathDraft] = React.useState(path)
  React.useEffect(() => setPathDraft(path), [path])

  const submitPath = () => {
    const v = pathDraft.trim() || "/"
    if (v !== path) onNavigate(v)
  }

  const segs = segments(path)
  const atRoot = path === "/"

  return (
    <TooltipProvider delayDuration={250}>
      <div className="shrink-0 border-b bg-card">
        {/* Row 1 — actions + view tools */}
        <div className="flex items-center gap-1.5 px-3 py-2">
          <Button size="sm" className="h-8" onClick={onUpload}>
            <Upload className="h-3.5 w-3.5" /> 上传
          </Button>
          <Tip label="上传文件夹（保留目录结构）">
            <Button size="icon" variant="outline" className="h-8 w-8" onClick={onUploadFolder}>
              <FolderUp className="h-3.5 w-3.5" />
            </Button>
          </Tip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" className="h-8">
                <FolderPlus className="h-3.5 w-3.5" /> 新建
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              <DropdownMenuItem onClick={onNewFolder}>
                <FolderPlus className="h-4 w-4" /> 新建目录
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onNewFile}>
                <FilePlus className="h-4 w-4" /> 新建文件
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ml-auto flex items-center gap-1.5">
            {/* Search */}
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => onFilterChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filter.trim()) onRecursiveSearch(filter)
                  if (e.key === "Escape") onClearSearch()
                }}
                placeholder="过滤当前目录…"
                className="h-8 w-40 pl-7 pr-7 text-xs lg:w-52"
              />
              {filter && (
                <button
                  type="button"
                  onClick={onClearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label="清空搜索"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <Tip label="在所有子目录中搜索（Enter）">
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                disabled={!filter.trim() || searching}
                onClick={() => onRecursiveSearch(filter)}
              >
                <SearchCode className={cn("h-3.5 w-3.5", searching && "animate-pulse text-primary")} />
              </Button>
            </Tip>

            {/* View switch */}
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(v) => v && onViewChange(v as SftpView)}
              className="h-8"
            >
              <ToggleGroupItem value="list" aria-label="列表视图" className="h-7 w-7 p-0 data-[state=on]:bg-background data-[state=on]:shadow-sm">
                <List className="h-3.5 w-3.5" />
              </ToggleGroupItem>
              <ToggleGroupItem value="grid" aria-label="网格视图" className="h-7 w-7 p-0 data-[state=on]:bg-background data-[state=on]:shadow-sm">
                <LayoutGrid className="h-3.5 w-3.5" />
              </ToggleGroupItem>
            </ToggleGroup>

            {/* Sort */}
            <DropdownMenu>
              <Tip label="排序方式">
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-8 w-8">
                    <ArrowUpDown className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </Tip>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuLabel className="text-[11px]">排序字段</DropdownMenuLabel>
                {SORT_FIELDS.map((s) => (
                  <DropdownMenuItem
                    key={s.key}
                    onClick={() => onSort(s.key, s.key === sortKey ? (sortDir === "asc" ? "desc" : "asc") : "asc")}
                  >
                    {s.label}
                    {s.key === sortKey && (
                      <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
                        {sortDir === "asc" ? "升序" : "降序"} <Check className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onToggleHidden}>
                  {showHidden ? "隐藏" : "显示"}以点开头的文件
                  {showHidden && <Check className="ml-auto h-3.5 w-3.5" />}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Tip label="刷新（F5）">
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onRefresh}>
                <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
              </Button>
            </Tip>
          </div>
        </div>

        {/* Row 2 — breadcrumb + jump-to-path */}
        <div className="flex items-center gap-2 border-t px-3 py-1.5">
          <Tip label="上级目录（Backspace）">
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onUp} disabled={atRoot}>
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
          </Tip>
          <Breadcrumb className="min-w-0 flex-1">
            <BreadcrumbList className="flex-nowrap gap-1 overflow-x-auto py-0.5 [&::-webkit-scrollbar]:hidden">
              <BreadcrumbItem>
                <Crumb
                  path="/"
                  active={atRoot}
                  onNavigate={onNavigate}
                  canWrite={canWrite}
                  onMove={onMove}
                  icon={<Home className="h-3.5 w-3.5" />}
                />
              </BreadcrumbItem>
              {segs.map((seg, i) => {
                const target = "/" + segs.slice(0, i + 1).join("/")
                const last = i === segs.length - 1
                return (
                  <React.Fragment key={target}>
                    <BreadcrumbSeparator />
                    <BreadcrumbItem>
                      <Crumb
                        path={target}
                        label={seg}
                        active={last}
                        onNavigate={onNavigate}
                        canWrite={canWrite}
                        onMove={onMove}
                      />
                    </BreadcrumbItem>
                  </React.Fragment>
                )
              })}
            </BreadcrumbList>
          </Breadcrumb>
          <Input
            ref={pathInputRef}
            value={pathDraft}
            onChange={(e) => setPathDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitPath()
              if (e.key === "Escape") setPathDraft(path)
            }}
            onBlur={submitPath}
            spellCheck={false}
            autoComplete="off"
            placeholder="跳转到路径…"
            className="hidden h-7 w-56 shrink-0 font-mono text-xs lg:block"
          />
        </div>
      </div>
    </TooltipProvider>
  )
}

function Tip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

// A breadcrumb segment that navigates on click and accepts dropped rows as a
// move target. Rendered inside shadcn BreadcrumbItem to keep the markup/aria
// consistent with the rest of the app.
function Crumb({
  path,
  label,
  active,
  onNavigate,
  canWrite,
  onMove,
  icon,
}: {
  path: string
  label?: string
  active: boolean
  onNavigate: (p: string) => void
  canWrite: boolean
  onMove: (paths: string[], targetDir: string) => void
  icon?: React.ReactNode
}) {
  const [over, setOver] = React.useState(false)
  return (
    <button
      type="button"
      onClick={() => onNavigate(path)}
      onDragOver={(e) => {
        if (!canWrite || !e.dataTransfer.types.includes(SFTP_MOVE_MIME)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = "move"
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (!canWrite) return
        const paths = readMovePayload(e.dataTransfer)
        if (!paths) return
        e.preventDefault()
        e.stopPropagation()
        onMove(paths, path)
      }}
      title={path}
      className={cn(
        "inline-flex max-w-[12rem] shrink-0 items-center gap-1 truncate rounded px-1.5 py-0.5 text-sm transition-colors hover:bg-accent",
        active ? "font-medium text-foreground" : "text-muted-foreground",
        over && "bg-primary/15 text-primary ring-1 ring-primary",
      )}
    >
      {icon}
      {label && <span className="truncate">{label}</span>}
    </button>
  )
}
