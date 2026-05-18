"use client"

import * as React from "react"
import {
  ArrowUp,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  FilePlus,
  FolderPlus,
  Home,
  RefreshCw,
  Search,
  Trash2,
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
import { cn } from "@/lib/utils"
import { segments } from "./pathUtil"

export type SortKey = "name" | "size" | "mtime" | "type"
export type SortDir = "asc" | "desc"

type Props = {
  path: string
  onNavigate: (path: string) => void
  onUp: () => void
  onRefresh: () => void
  loading?: boolean
  search: string
  onSearch: (q: string) => void
  showHidden: boolean
  onToggleHidden: () => void
  sortKey: SortKey
  sortDir: SortDir
  onSort: (key: SortKey, dir: SortDir) => void
  onNewFolder: () => void
  onNewFile: () => void
  onUpload: () => void
  onUploadFolder: () => void
  onDeleteSelected: () => void
  onDownloadSelected: () => void
  selectedCount: number
  pathInputRef?: React.Ref<HTMLInputElement>
}

export function SftpToolbar({
  path,
  onNavigate,
  onUp,
  onRefresh,
  loading,
  search,
  onSearch,
  showHidden,
  onToggleHidden,
  sortKey,
  sortDir,
  onSort,
  onNewFolder,
  onNewFile,
  onUpload,
  onUploadFolder,
  onDeleteSelected,
  onDownloadSelected,
  selectedCount,
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
    <div className="border-b bg-card">
      {/* Row 1 — breadcrumbs + path input */}
      <div className="flex items-center gap-1 px-3 py-2">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => onNavigate("/")}
          disabled={atRoot}
          title="根目录"
        >
          <Home className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onUp}
          disabled={atRoot}
          title="上级目录 (Backspace)"
        >
          <ArrowUp className="w-4 h-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onRefresh}
          title="刷新 (F5)"
        >
          <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
        </Button>

        <div className="flex-1 flex items-center gap-1 min-w-0 px-2">
          {/* Breadcrumbs */}
          <div className="hidden md:flex items-center gap-0.5 text-sm min-w-0 overflow-hidden flex-1">
            <button
              type="button"
              className="hover:text-foreground text-muted-foreground shrink-0 px-1"
              onClick={() => onNavigate("/")}
            >
              /
            </button>
            {segs.map((s, i) => {
              const target = "/" + segs.slice(0, i + 1).join("/")
              const last = i === segs.length - 1
              return (
                <React.Fragment key={target}>
                  <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
                  <button
                    type="button"
                    className={cn(
                      "hover:text-foreground px-1 truncate max-w-[10rem]",
                      last ? "text-foreground font-medium" : "text-muted-foreground",
                    )}
                    onClick={() => onNavigate(target)}
                    title={target}
                  >
                    {s}
                  </button>
                </React.Fragment>
              )
            })}
          </div>
          {/* Path input — also serves as the small-screen path display */}
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
            className="md:hidden h-8 font-mono text-xs"
          />
        </div>

        {/* Path go-to input on desktop too, as a power-user input */}
        <div className="hidden md:flex items-center gap-1 shrink-0">
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
            placeholder="输入路径并回车…"
            className="h-8 w-64 font-mono text-xs"
          />
        </div>
      </div>

      {/* Row 2 — actions */}
      <div className="flex items-center gap-1.5 px-3 pb-2 flex-wrap">
        <Button variant="outline" size="sm" className="h-8" onClick={onUpload} title="上传文件">
          <Upload className="w-4 h-4" /> 上传
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={onUploadFolder}
          title="上传文件夹（保留目录结构）"
        >
          <Upload className="w-4 h-4" /> 上传文件夹
        </Button>
        <Button variant="outline" size="sm" className="h-8" onClick={onNewFolder} title="新建目录">
          <FolderPlus className="w-4 h-4" /> 新建目录
        </Button>
        <Button variant="outline" size="sm" className="h-8" onClick={onNewFile} title="新建空文件">
          <FilePlus className="w-4 h-4" /> 新建文件
        </Button>

        <span className="h-6 w-px bg-border mx-1" />

        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="过滤当前目录…"
            className="h-8 w-44 pl-7 pr-7 text-xs"
          />
          {search && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => onSearch("")}
              title="清空"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="h-8"
          onClick={onToggleHidden}
          title={showHidden ? "隐藏以点开头的文件" : "显示隐藏文件"}
        >
          {showHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          {showHidden ? "隐藏 ." : "显示 ."}
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              排序：{sortLabel(sortKey)} {sortDir === "asc" ? "↑" : "↓"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>排序字段</DropdownMenuLabel>
            {(["name", "size", "mtime", "type"] as SortKey[]).map((k) => (
              <DropdownMenuItem key={k} onClick={() => onSort(k, sortDir)}>
                {sortLabel(k)} {k === sortKey && "✓"}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onSort(sortKey, sortDir === "asc" ? "desc" : "asc")}>
              切换 {sortDir === "asc" ? "降序 ↓" : "升序 ↑"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex-1" />

        {selectedCount > 0 && (
          <>
            <span className="text-xs text-muted-foreground">已选 {selectedCount} 项</span>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={onDownloadSelected}
              title="批量下载"
            >
              <Download className="w-4 h-4" /> 下载
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-destructive hover:text-destructive"
              onClick={onDeleteSelected}
              title="删除选中（Delete）"
            >
              <Trash2 className="w-4 h-4" /> 删除
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function sortLabel(k: SortKey): string {
  switch (k) {
    case "name":
      return "名称"
    case "size":
      return "大小"
    case "mtime":
      return "修改时间"
    case "type":
      return "类型"
  }
}
