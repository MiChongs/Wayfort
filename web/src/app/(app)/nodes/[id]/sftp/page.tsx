"use client"

import * as React from "react"
import Link from "next/link"
import { use } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Server, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import { nodeService, sftpService, type SftpEntry } from "@/lib/api/services"
import { SftpBrowser } from "@/components/sftp/SftpBrowser"
import {
  SftpContextMenu,
  useSftpContextMenu,
  type SftpContextActions,
} from "@/components/sftp/SftpContextMenu"
import { SftpStatusBar } from "@/components/sftp/SftpStatusBar"
import { SftpToolbar, type SortDir, type SortKey } from "@/components/sftp/SftpToolbar"
import { SftpUploadDrawer } from "@/components/sftp/SftpUploadDrawer"
import { SftpCreateDialog } from "@/components/sftp/SftpCreateDialog"
import { SftpPreviewModal } from "@/components/sftp/SftpPreviewModal"
import { SftpEditorModal } from "@/components/sftp/SftpEditorModal"
import { SftpChmodDialog } from "@/components/sftp/SftpChmodDialog"
import { SftpPropertiesDialog } from "@/components/sftp/SftpPropertiesDialog"
import { useSftpKeyboard } from "@/components/sftp/useSftpKeyboard"
import { useSftpSelection } from "@/components/sftp/useSftpSelection"
import { useSftpUploadQueue } from "@/components/sftp/useSftpUploadQueue"
import { isEditable, isLikelyText, isPreviewableImage } from "@/components/sftp/fileIcons"
import { basename, join, normalize, parent as parentPath } from "@/components/sftp/pathUtil"

// Files that look like reasonable initial content for `New file`. Anything
// else still works — this just keeps it from being empty bytes.
const NEW_FILE_HINT = ""

type CreateKind = "folder" | "file" | null

export default function SFTPPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const nodeId = Number(id)
  const qc = useQueryClient()

  const [path, setPath] = React.useState("/")
  const [search, setSearch] = React.useState("")
  const [showHidden, setShowHidden] = React.useState(false)
  const [sortKey, setSortKey] = React.useState<SortKey>("name")
  const [sortDir, setSortDir] = React.useState<SortDir>("asc")
  const [renamingPath, setRenamingPath] = React.useState<string | null>(null)
  const [previewEntry, setPreviewEntry] = React.useState<SftpEntry | null>(null)
  const [editorEntry, setEditorEntry] = React.useState<SftpEntry | null>(null)
  const [chmodEntry, setChmodEntry] = React.useState<SftpEntry | null>(null)
  const [propsEntry, setPropsEntry] = React.useState<SftpEntry | null>(null)
  const [createKind, setCreateKind] = React.useState<CreateKind>(null)
  const [creating, setCreating] = React.useState(false)

  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const folderInputRef = React.useRef<HTMLInputElement>(null)
  const pathInputRef = React.useRef<HTMLInputElement>(null)

  // ---- queries -----------------------------------------------------------
  const node = useQuery({
    queryKey: ["node", nodeId],
    queryFn: () => nodeService.get(nodeId),
    enabled: Number.isFinite(nodeId),
  })
  const listing = useQuery({
    queryKey: ["sftp", nodeId, path],
    queryFn: () => sftpService.list(nodeId, path),
    enabled: Number.isFinite(nodeId),
  })
  const listError = listing.error
    ? ((listing.error as { message?: string }).message || "未知错误")
    : null

  const refresh = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["sftp", nodeId, path] })
  }, [nodeId, path, qc])

  // ---- derived: filter + sort -------------------------------------------
  const rawEntries: SftpEntry[] = React.useMemo(
    () => listing.data?.entries ?? [],
    [listing.data?.entries],
  )

  const entries = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    let arr = rawEntries
    if (!showHidden) arr = arr.filter((e) => !e.name.startsWith("."))
    if (q) arr = arr.filter((e) => e.name.toLowerCase().includes(q))
    const cmp = (a: SftpEntry, b: SftpEntry) => {
      // Directories always sort to the top regardless of sort direction —
      // standard file-manager convention.
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
      let r = 0
      switch (sortKey) {
        case "name":
          r = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
          break
        case "size":
          r = a.size - b.size
          break
        case "mtime":
          r = new Date(a.mod_time).getTime() - new Date(b.mod_time).getTime()
          break
        case "type":
          r = (a.mode_octal || a.mode).localeCompare(b.mode_octal || b.mode)
          break
      }
      return sortDir === "asc" ? r : -r
    }
    return [...arr].sort(cmp)
  }, [rawEntries, search, showHidden, sortKey, sortDir])

  // ---- selection + uploads ----------------------------------------------
  const sel = useSftpSelection(entries)
  const uploads = useSftpUploadQueue(nodeId, { onFileDone: refresh })

  // ---- mutations (inline, since each is single-call) --------------------
  const runMkdir = async (name: string) => {
    setCreating(true)
    try {
      await sftpService.mkdir(nodeId, join(path, name))
      toast.success("已创建目录", { description: name })
      setCreateKind(null)
      refresh()
    } catch (e) {
      const err = e as { message?: string }
      toast.error("创建失败", { description: err?.message || String(e) })
    } finally {
      setCreating(false)
    }
  }
  const runCreateFile = async (name: string) => {
    setCreating(true)
    try {
      await sftpService.writeText(nodeId, join(path, name), NEW_FILE_HINT)
      toast.success("已创建文件", { description: name })
      setCreateKind(null)
      refresh()
    } catch (e) {
      const err = e as { message?: string }
      toast.error("创建失败", { description: err?.message || String(e) })
    } finally {
      setCreating(false)
    }
  }
  const runRename = async (entry: SftpEntry, newName: string) => {
    setRenamingPath(null)
    if (newName === entry.name) return
    const dest = join(parentPath(entry.path), newName)
    try {
      await sftpService.rename(nodeId, entry.path, dest)
      toast.success("已重命名", { description: `${entry.name} → ${newName}` })
      refresh()
    } catch (e) {
      const err = e as { message?: string }
      toast.error("重命名失败", { description: err?.message || String(e) })
    }
  }
  const runDelete = async (paths: string[]) => {
    if (paths.length === 0) return
    const label =
      paths.length === 1 ? `删除 "${basename(paths[0])}"？` : `删除选中的 ${paths.length} 项？`
    if (!confirm(`${label}\n\n此操作不可撤销，目录将连同子项一并删除。`)) return
    let ok = 0
    let fail = 0
    for (const p of paths) {
      try {
        await sftpService.remove(nodeId, p)
        ok++
      } catch (e) {
        fail++
        const err = e as { message?: string }
        toast.error(`删除失败: ${basename(p)}`, { description: err?.message || String(e) })
      }
    }
    if (ok > 0) toast.success(`已删除 ${ok} 项${fail ? `，${fail} 项失败` : ""}`)
    sel.clear()
    refresh()
  }

  // ---- navigation --------------------------------------------------------
  const navigate = React.useCallback((to: string) => {
    setPath(normalize(to))
    setSearch("")
    setRenamingPath(null)
  }, [])
  const goUp = React.useCallback(() => navigate(parentPath(path)), [navigate, path])

  // ---- row interaction handlers -----------------------------------------
  const onRowClick = (entry: SftpEntry, index: number, ev: React.MouseEvent) => {
    if (renamingPath) return
    if (ev.shiftKey) sel.select(entry, index, "range")
    else if (ev.ctrlKey || ev.metaKey) sel.select(entry, index, "toggle")
    else sel.select(entry, index, "set")
  }
  const onRowDoubleClick = (entry: SftpEntry) => {
    if (entry.is_dir) {
      navigate(entry.path)
      return
    }
    if (isPreviewableImage(entry) || isLikelyText(entry)) setPreviewEntry(entry)
    else triggerDownload(entry)
  }

  // ---- context menu ------------------------------------------------------
  const menu = useSftpContextMenu()
  const openContext = (entry: SftpEntry, ev: React.MouseEvent) => {
    if (!sel.isSelected(entry.path)) {
      const idx = entries.indexOf(entry)
      sel.select(entry, idx, "set")
    }
    menu.open(entry, ev)
  }

  const triggerDownload = (entry: SftpEntry) => {
    const a = document.createElement("a")
    a.href = sftpService.downloadURL(nodeId, entry.path)
    a.rel = "noreferrer"
    // We can't set `download` reliably for cross-origin URLs, but the backend
    // sends Content-Disposition: attachment so the browser will download.
    a.style.display = "none"
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
  const downloadSelected = async () => {
    const files = sel.selectedEntries.filter((e) => !e.is_dir)
    if (files.length === 0) {
      toast.info("没有可下载的文件")
      return
    }
    // Stagger slightly so browsers don't reject as popup spam.
    for (let i = 0; i < files.length; i++) {
      triggerDownload(files[i])
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 250))
    }
  }
  const copyPath = (entry: SftpEntry) => {
    void navigator.clipboard?.writeText(entry.path)
    toast.success("已复制路径", { description: entry.path })
  }
  const actions: SftpContextActions = {
    onOpen: (e) => onRowDoubleClick(e),
    onDownload: triggerDownload,
    onPreview: (e) => setPreviewEntry(e),
    onEdit: (e) => {
      if (isEditable(e)) setEditorEntry(e)
      else toast.info("此文件不支持内嵌编辑", { description: "请下载到本地编辑" })
    },
    onRename: (e) => setRenamingPath(e.path),
    onChmod: (e) => setChmodEntry(e),
    onProperties: (e) => setPropsEntry(e),
    onDelete: (e) => {
      const targets = sel.isSelected(e.path) && sel.count > 1 ? Array.from(sel.selected) : [e.path]
      void runDelete(targets)
    },
    onCopyPath: copyPath,
  }

  // ---- keyboard shortcuts ------------------------------------------------
  useSftpKeyboard(
    {
      onOpen: () => {
        const e = sel.selectedEntries[0]
        if (e) onRowDoubleClick(e)
      },
      onUp: () => goUp(),
      onDelete: () => {
        if (sel.count > 0) void runDelete(Array.from(sel.selected))
      },
      onRename: () => {
        const e = sel.selectedEntries[0]
        if (e) setRenamingPath(e.path)
      },
      onSelectAll: () => sel.selectAll(),
      onFocusPath: () => pathInputRef.current?.focus(),
      onRefresh: () => refresh(),
      onEscape: () => {
        if (renamingPath) setRenamingPath(null)
        else if (menu.state) menu.close()
        else if (sel.count > 0) sel.clear()
      },
    },
    !previewEntry && !editorEntry && !chmodEntry && !propsEntry && createKind == null,
  )

  // ---- upload triggers ---------------------------------------------------
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      uploads.enqueueMany(files, path)
      toast.info(`已加入 ${files.length} 个上传任务`)
    }
    e.currentTarget.value = ""
  }
  const onPickFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files && files.length > 0) {
      uploads.enqueueMany(files, path)
      toast.info(`已加入 ${files.length} 个上传任务（含子目录）`)
    }
    e.currentTarget.value = ""
  }
  const onDropFiles = (files: File[]) => {
    if (files.length === 0) return
    uploads.enqueueMany(files, path)
    toast.info(`已加入 ${files.length} 个上传任务`)
  }

  // ---- render ------------------------------------------------------------
  if (!Number.isFinite(nodeId)) {
    return (
      <div className="p-10 text-center text-destructive">无效的节点 ID</div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] min-h-[500px]">
      <NodeHeader nodeId={nodeId} node={node.data} loading={node.isLoading} />
      <SftpToolbar
        path={path}
        onNavigate={navigate}
        onUp={goUp}
        onRefresh={refresh}
        loading={listing.isFetching}
        search={search}
        onSearch={setSearch}
        showHidden={showHidden}
        onToggleHidden={() => setShowHidden((v) => !v)}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={(k, d) => {
          setSortKey(k)
          setSortDir(d)
        }}
        onNewFolder={() => setCreateKind("folder")}
        onNewFile={() => setCreateKind("file")}
        onUpload={() => fileInputRef.current?.click()}
        onUploadFolder={() => folderInputRef.current?.click()}
        onDeleteSelected={() => void runDelete(Array.from(sel.selected))}
        onDownloadSelected={() => void downloadSelected()}
        selectedCount={sel.count}
        pathInputRef={pathInputRef}
      />
      <SftpBrowser
        entries={entries}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={(k, d) => {
          setSortKey(k)
          setSortDir(d)
        }}
        loading={listing.isLoading}
        error={listError}
        isSelected={sel.isSelected}
        onRowClick={onRowClick}
        onRowDoubleClick={onRowDoubleClick}
        onContextMenu={openContext}
        renamingPath={renamingPath}
        onRenameSubmit={runRename}
        onRenameCancel={() => setRenamingPath(null)}
        onDropFiles={onDropFiles}
        onRetry={refresh}
      />
      <SftpStatusBar
        entries={entries}
        selectedCount={sel.count}
        selectedSize={sel.totalSize}
        loading={listing.isFetching && !listing.isLoading}
        error={listError}
        path={path}
      />

      {/* Hidden inputs for upload buttons */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onPickFiles}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onPickFolder}
        // webkitdirectory is non-standard but supported in Chromium and
        // Firefox; React's typings don't include it so we cast through any.
        {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
      />

      {/* Floating drawer */}
      <SftpUploadDrawer
        tasks={uploads.tasks}
        active={uploads.active}
        totalSent={uploads.totalSent}
        totalBytes={uploads.totalBytes}
        onCancel={uploads.cancel}
        onRetry={uploads.retry}
        onClearFinished={uploads.clearFinished}
      />

      {/* Context menu portal */}
      <SftpContextMenu state={menu.state} onClose={menu.close} actions={actions} />

      {/* Modals */}
      <SftpPreviewModal
        nodeId={nodeId}
        entry={previewEntry}
        onClose={() => setPreviewEntry(null)}
        onEdit={(e) => {
          setPreviewEntry(null)
          if (isEditable(e)) setEditorEntry(e)
        }}
      />
      <SftpEditorModal
        nodeId={nodeId}
        entry={editorEntry}
        onClose={() => setEditorEntry(null)}
        onSaved={refresh}
      />
      <SftpChmodDialog
        nodeId={nodeId}
        entry={chmodEntry}
        onClose={() => setChmodEntry(null)}
        onSaved={refresh}
      />
      <SftpPropertiesDialog
        nodeId={nodeId}
        entry={propsEntry}
        onClose={() => setPropsEntry(null)}
      />
      <SftpCreateDialog
        open={createKind != null}
        kind={createKind ?? "folder"}
        parentPath={path}
        busy={creating}
        onCancel={() => setCreateKind(null)}
        onSubmit={(name) => {
          if (createKind === "folder") void runMkdir(name)
          else void runCreateFile(name)
        }}
      />
    </div>
  )
}

function NodeHeader({
  nodeId,
  node,
  loading,
}: {
  nodeId: number
  node?: { id: number; name?: string; host?: string; port?: number; protocol?: string }
  loading?: boolean
}) {
  return (
    <div className="border-b bg-card px-4 py-2.5 flex items-center gap-3 shrink-0">
      <Link
        href={`/nodes/${nodeId}`}
        className="inline-flex items-center justify-center h-8 w-8 rounded-md hover:bg-accent text-muted-foreground"
        title="返回节点详情"
      >
        <ArrowLeft className="w-4 h-4" />
      </Link>
      <Server className="w-5 h-5 text-primary" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 min-w-0">
          <h1 className="text-sm font-semibold truncate">
            {loading ? "加载中…" : node?.name || `节点 #${nodeId}`}
          </h1>
          <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase">
            SFTP
          </span>
        </div>
        <p className="text-xs text-muted-foreground truncate font-mono">
          {node?.host}
          {node?.port ? `:${node.port}` : ""}
          {node?.protocol ? `  ·  ${node.protocol}` : ""}
        </p>
      </div>
      <div className="hidden md:flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
        <ShieldCheck className="w-3.5 h-3.5 text-emerald-500" />
        所有操作均会写入审计日志
      </div>
    </div>
  )
}
