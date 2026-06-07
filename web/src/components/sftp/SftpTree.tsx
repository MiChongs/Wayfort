"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, Folder, FolderOpen, Home, Loader2, RefreshCw } from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { sftpService, type SftpEntry } from "@/lib/api/services"
import { readMovePayload, SFTP_MOVE_MIME } from "./sftpDnd"

// Persistent, lazy-loaded directory tree. It shares the ["sftp", nodeId, path]
// query key with the file list, so expanding a node the list already visited is
// instant, and a refresh anywhere keeps both in sync. Each node doubles as a
// drop target: dragging selected rows onto a folder moves them there.
export function SftpTree({
  nodeId,
  currentPath,
  onNavigate,
  canWrite,
  onMove,
  onRefresh,
}: {
  nodeId: number
  currentPath: string
  onNavigate: (path: string) => void
  canWrite: boolean
  onMove: (paths: string[], targetDir: string) => void
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set(["/"]))

  // Keep every ancestor of the current path open so navigating from the list,
  // breadcrumb, or search always reveals the active node in the tree.
  React.useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.add("/")
      let p = ""
      for (const seg of currentPath.split("/").filter(Boolean)) {
        p += "/" + seg
        next.add(p)
      }
      return next
    })
  }, [currentPath])

  const toggle = React.useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between border-b px-2.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">目录</span>
        <Button size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground" onClick={onRefresh} aria-label="刷新目录树">
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="p-1.5" role="tree" aria-label="目录树">
          <TreeNode
            nodeId={nodeId}
            path="/"
            name="根目录"
            depth={0}
            isRoot
            currentPath={currentPath}
            onNavigate={onNavigate}
            expanded={expanded}
            onToggle={toggle}
            canWrite={canWrite}
            onMove={onMove}
          />
        </div>
      </ScrollArea>
    </div>
  )
}

function TreeNode({
  nodeId,
  path,
  name,
  depth,
  isRoot,
  currentPath,
  onNavigate,
  expanded,
  onToggle,
  canWrite,
  onMove,
}: {
  nodeId: number
  path: string
  name: string
  depth: number
  isRoot?: boolean
  currentPath: string
  onNavigate: (p: string) => void
  expanded: Set<string>
  onToggle: (p: string) => void
  canWrite: boolean
  onMove: (paths: string[], targetDir: string) => void
}) {
  const isOpen = expanded.has(path)
  const active = currentPath === path
  const [dropOver, setDropOver] = React.useState(false)

  const childrenQ = useQuery({
    queryKey: ["sftp", nodeId, path],
    queryFn: () => sftpService.list(nodeId, path),
    enabled: isOpen,
  })

  const dirs = React.useMemo(() => {
    const entries: SftpEntry[] = childrenQ.data?.entries ?? []
    return entries
      .filter((e) => e.is_dir && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
  }, [childrenQ.data])

  const Icon = isOpen ? FolderOpen : isRoot ? Home : Folder

  return (
    <div>
      <div
        role="treeitem"
        aria-expanded={isOpen}
        aria-selected={active}
        onClick={() => onNavigate(path)}
        onDragOver={(e) => {
          if (!canWrite || !e.dataTransfer.types.includes(SFTP_MOVE_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = "move"
          setDropOver(true)
        }}
        onDragLeave={() => setDropOver(false)}
        onDrop={(e) => {
          setDropOver(false)
          if (!canWrite) return
          const paths = readMovePayload(e.dataTransfer)
          if (!paths) return
          e.preventDefault()
          e.stopPropagation()
          onMove(paths, path)
        }}
        style={{ paddingLeft: depth * 12 + 2 }}
        className={cn(
          "group flex h-7 cursor-pointer select-none items-center gap-1 rounded-md pr-1.5 text-sm transition-colors",
          active ? "bg-primary/10 font-medium text-primary" : "hover:bg-accent/50",
          dropOver && "bg-primary/5 ring-1 ring-inset ring-primary",
        )}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onToggle(path)
          }}
          className="grid h-4 w-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground"
          aria-label={isOpen ? "折叠" : "展开"}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform duration-150", isOpen && "rotate-90")} />
        </button>
        <Icon className={cn("h-4 w-4 shrink-0", isRoot || active ? "text-primary" : "text-sky-500 dark:text-sky-400")} />
        <span className="truncate">{name}</span>
      </div>

      {isOpen && (
        <div>
          {childrenQ.isLoading ? (
            <div
              style={{ paddingLeft: (depth + 1) * 12 + 8 }}
              className="inline-flex items-center gap-1.5 py-1 text-xs text-muted-foreground"
            >
              <Loader2 className="h-3 w-3 animate-spin" /> 读取中
            </div>
          ) : (
            dirs.map((d) => (
              <TreeNode
                key={d.path}
                nodeId={nodeId}
                path={d.path}
                name={d.name}
                depth={depth + 1}
                currentPath={currentPath}
                onNavigate={onNavigate}
                expanded={expanded}
                onToggle={onToggle}
                canWrite={canWrite}
                onMove={onMove}
              />
            ))
          )}
        </div>
      )}
    </div>
  )
}
