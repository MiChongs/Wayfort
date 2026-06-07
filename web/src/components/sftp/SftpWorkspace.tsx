"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Upload } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import {
  nodeService,
  sftpService,
  type SftpEntry,
  type SftpSearchResult,
} from "@/lib/api/services"
import { useConfirm } from "@/components/admin/use-confirm"
import { SftpHeader } from "./SftpHeader"
import { SftpTree } from "./SftpTree"
import { SftpToolbar, type SftpView, type SortDir, type SortKey } from "./SftpToolbar"
import { SftpSelectionBar } from "./SftpSelectionBar"
import { SftpBrowser } from "./SftpBrowser"
import { SftpGrid } from "./SftpGrid"
import { SftpStatusBar } from "./SftpStatusBar"
import { SftpTransferDock } from "./SftpTransferDock"
import { SftpApprovalBar } from "./SftpApprovalBar"
import { SftpApprovalSheet } from "./SftpApprovalSheet"
import { type SftpContextActions } from "./SftpContextMenu"
import { SftpCreateDialog } from "./SftpCreateDialog"
import { SftpPreviewModal } from "./SftpPreviewModal"
import { SftpEditorModal } from "./SftpEditorModal"
import { SftpChmodDialog } from "./SftpChmodDialog"
import { SftpPropertiesDialog } from "./SftpPropertiesDialog"
import { useSftpApproval } from "./useSftpApproval"
import { useSftpKeyboard } from "./useSftpKeyboard"
import { useSftpSelection } from "./useSftpSelection"
import { useSftpUploadQueue } from "./useSftpUploadQueue"
import { useFilesDropzone } from "./useFilesDropzone"
import { isEditable, isLikelyText } from "./fileIcons"
import { basename, join, normalize, parent as parentPath } from "./pathUtil"
import { FileViewer, isViewerSupported, type ViewerFile } from "@/components/viewers/FileViewer"
import { isPaintableImage, viewerKind } from "@/components/viewers/viewerKind"

type CreateKind = "folder" | "file" | null

export type SftpWorkspaceProps = {
  nodeId: number
  showNodeHeader?: boolean
  className?: string
}

export function SftpWorkspace({ nodeId, showNodeHeader = true, className }: SftpWorkspaceProps) {
  const qc = useQueryClient()
  const { confirm: confirmDialog, dialog: confirmDialogEl } = useConfirm()

  const [path, setPath] = React.useState("/")
  const [filter, setFilter] = React.useState("")
  const [showHidden, setShowHidden] = React.useState(false)
  const [sortKey, setSortKey] = React.useState<SortKey>("name")
  const [sortDir, setSortDir] = React.useState<SortDir>("asc")
  const [view, setView] = React.useState<SftpView>("list")
  const [renamingPath, setRenamingPath] = React.useState<string | null>(null)
  const [searchResult, setSearchResult] = React.useState<SftpSearchResult | null>(null)
  const [searching, setSearching] = React.useState(false)

  const [previewEntry, setPreviewEntry] = React.useState<SftpEntry | null>(null)
  const [editorEntry, setEditorEntry] = React.useState<SftpEntry | null>(null)
  const [chmodEntry, setChmodEntry] = React.useState<SftpEntry | null>(null)
  const [propsEntry, setPropsEntry] = React.useState<SftpEntry | null>(null)
  const [createKind, setCreateKind] = React.useState<CreateKind>(null)
  const [creating, setCreating] = React.useState(false)
  const [approvalOpen, setApprovalOpen] = React.useState(false)
  const [viewerFile, setViewerFile] = React.useState<ViewerFile | null>(null)

  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const folderInputRef = React.useRef<HTMLInputElement>(null)
  const pathInputRef = React.useRef<HTMLInputElement>(null)

  // ---- queries + machines ------------------------------------------------
  const node = useQuery({
    queryKey: ["node", nodeId],
    queryFn: () => nodeService.get(nodeId),
    enabled: Number.isFinite(nodeId),
  })
  const listing = useQuery({
    queryKey: ["sftp", nodeId, path],
    queryFn: () => sftpService.list(nodeId, path),
    enabled: Number.isFinite(nodeId) && !searchResult,
  })
  const listError = listing.error ? ((listing.error as { message?: string }).message || "未知错误") : null

  const approval = useSftpApproval(nodeId)

  const refresh = React.useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["sftp", nodeId] })
  }, [nodeId, qc])

  // ---- displayed entries -------------------------------------------------
  const rawEntries: SftpEntry[] = React.useMemo(
    () => listing.data?.entries ?? [],
    [listing.data?.entries],
  )

  const entries = React.useMemo(() => {
    if (searchResult) return searchResult.entries as SftpEntry[]
    const q = filter.trim().toLowerCase()
    let arr = rawEntries
    if (!showHidden) arr = arr.filter((e) => !e.name.startsWith("."))
    if (q) arr = arr.filter((e) => e.name.toLowerCase().includes(q))
    const cmp = (a: SftpEntry, b: SftpEntry) => {
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
  }, [rawEntries, searchResult, filter, showHidden, sortKey, sortDir])

  const sel = useSftpSelection(entries)
  const uploads = useSftpUploadQueue(nodeId, { onFileDone: refresh })
  const selectedPaths = React.useMemo(() => Array.from(sel.selected), [sel.selected])
  const imageGallery = React.useMemo<ViewerFile[]>(
    () =>
      entries
        .filter((e) => !e.is_dir && isPaintableImage(e.name))
        .map((e) => ({ name: e.name, url: sftpService.downloadURL(nodeId, e.path), ref: e.path, size: e.size })),
    [entries, nodeId],
  )
  const mediaGallery = React.useMemo<ViewerFile[]>(
    () =>
      entries
        .filter((e) => !e.is_dir && (viewerKind(e.name) === "video" || viewerKind(e.name) === "audio"))
        .map((e) => ({ name: e.name, url: sftpService.downloadURL(nodeId, e.path), ref: e.path, size: e.size })),
    [entries, nodeId],
  )

  // ---- write gate --------------------------------------------------------
  // Browsing is free; any transfer (write OR download) needs the grant. When
  // it's missing we open the request sheet instead of letting the call 403.
  const ensureWrite = React.useCallback((): boolean => {
    if (approval.canWrite) return true
    setApprovalOpen(true)
    toast.info("写入受审批保护", { description: "请先申请写入授权" })
    return false
  }, [approval.canWrite])

  // ---- navigation --------------------------------------------------------
  const navigate = React.useCallback((to: string) => {
    setPath(normalize(to))
    setFilter("")
    setSearchResult(null)
    setRenamingPath(null)
  }, [])
  const goUp = React.useCallback(() => navigate(parentPath(path)), [navigate, path])

  // ---- recursive search --------------------------------------------------
  const runRecursiveSearch = React.useCallback(
    async (q: string) => {
      const query = q.trim()
      if (!query) return
      setSearching(true)
      try {
        const r = await sftpService.search(nodeId, path, query, 500)
        setSearchResult(r)
        sel.clear()
      } catch (e) {
        toast.error("搜索失败", { description: (e as { message?: string })?.message || String(e) })
      } finally {
        setSearching(false)
      }
    },
    [nodeId, path, sel],
  )
  const clearSearch = React.useCallback(() => {
    setFilter("")
    setSearchResult(null)
  }, [])

  // ---- mutations ---------------------------------------------------------
  const runMkdir = async (name: string) => {
    setCreating(true)
    try {
      await sftpService.mkdir(nodeId, join(path, name))
      toast.success("已创建目录", { description: name })
      setCreateKind(null)
      refresh()
    } catch (e) {
      toast.error("创建失败", { description: (e as { message?: string })?.message || String(e) })
    } finally {
      setCreating(false)
    }
  }
  const runCreateFile = async (name: string) => {
    setCreating(true)
    try {
      await sftpService.writeText(nodeId, join(path, name), "")
      toast.success("已创建文件", { description: name })
      setCreateKind(null)
      refresh()
    } catch (e) {
      toast.error("创建失败", { description: (e as { message?: string })?.message || String(e) })
    } finally {
      setCreating(false)
    }
  }
  const runRename = async (entry: SftpEntry, newName: string) => {
    setRenamingPath(null)
    if (newName === entry.name || !newName.trim()) return
    try {
      await sftpService.rename(nodeId, entry.path, join(parentPath(entry.path), newName))
      toast.success("已重命名", { description: `${entry.name} → ${newName}` })
      refresh()
    } catch (e) {
      toast.error("重命名失败", { description: (e as { message?: string })?.message || String(e) })
    }
  }
  const runDelete = async (paths: string[]) => {
    if (paths.length === 0 || !ensureWrite()) return
    const targets = entries.filter((e) => paths.includes(e.path))
    const hasDir = targets.some((e) => e.is_dir)
    const confirmed = await confirmDialog({
      title: paths.length === 1 ? `删除「${basename(paths[0])}」？` : `删除选中的 ${paths.length} 项？`,
      description: hasDir
        ? "其中包含目录，会连同所有子项一并删除，且无法撤销。"
        : "删除后无法撤销。",
      confirmLabel: "删除",
    })
    if (!confirmed) return
    let ok = 0
    let fail = 0
    for (const p of paths) {
      try {
        await sftpService.remove(nodeId, p)
        ok++
      } catch (e) {
        fail++
        toast.error(`删除失败：${basename(p)}`, { description: (e as { message?: string })?.message || String(e) })
      }
    }
    if (ok > 0) toast.success(`已删除 ${ok} 项${fail ? `，${fail} 项失败` : ""}`)
    sel.clear()
    refresh()
  }
  const runMove = async (paths: string[], targetDir: string) => {
    if (!ensureWrite()) return
    const moving = paths.filter((p) => parentPath(p) !== targetDir && p !== targetDir)
    if (moving.length === 0) return
    let ok = 0
    for (const p of moving) {
      try {
        await sftpService.rename(nodeId, p, join(targetDir, basename(p)))
        ok++
      } catch (e) {
        toast.error(`移动失败：${basename(p)}`, { description: (e as { message?: string })?.message || String(e) })
      }
    }
    if (ok > 0) {
      toast.success(ok > 1 ? `已移动 ${ok} 项` : "已移动")
      sel.clear()
      refresh()
    }
  }
  const runDuplicate = async (targets: SftpEntry[]) => {
    if (targets.length === 0 || !ensureWrite()) return
    const taken = new Set(rawEntries.map((e) => e.name))
    let ok = 0
    for (const e of targets) {
      const dest = join(parentPath(e.path), copyName(e.name, taken))
      taken.add(basename(dest))
      try {
        await sftpService.copy(nodeId, e.path, dest)
        ok++
      } catch (err) {
        toast.error(`复制失败：${e.name}`, { description: (err as { message?: string })?.message || String(err) })
      }
    }
    if (ok > 0) toast.success(ok > 1 ? `已复制 ${ok} 项` : "已创建副本")
    refresh()
  }

  // ---- transfers ---------------------------------------------------------
  const triggerBrowserDownload = (href: string) => {
    const a = document.createElement("a")
    a.href = href
    a.rel = "noreferrer"
    a.style.display = "none"
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }
  const saveImage = async (file: ViewerFile, blob: Blob) => {
    if (!ensureWrite()) throw new Error("写入受审批保护")
    const ref = file.ref || ""
    await sftpService.upload(nodeId, parentPath(ref), blob, { name: basename(ref) })
    toast.success("已保存回原文件", { description: basename(ref) })
    refresh()
  }
  const downloadOne = (entry: SftpEntry) => {
    if (!ensureWrite()) return
    triggerBrowserDownload(sftpService.downloadURL(nodeId, entry.path))
  }
  const openFile = (entry: SftpEntry) => {
    if (isViewerSupported(entry.name)) {
      setViewerFile({
        name: entry.name,
        url: sftpService.downloadURL(nodeId, entry.path),
        ref: entry.path,
        size: entry.size,
      })
    } else if (isLikelyText(entry)) {
      setPreviewEntry(entry)
    } else {
      downloadOne(entry)
    }
  }
  const downloadSelected = async () => {
    if (!ensureWrite()) return
    const files = sel.selectedEntries.filter((e) => !e.is_dir)
    if (files.length === 0) {
      toast.info("没有可单独下载的文件，试试「打包下载」")
      return
    }
    for (let i = 0; i < files.length; i++) {
      triggerBrowserDownload(sftpService.downloadURL(nodeId, files[i].path))
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, 250))
    }
  }
  const archivePaths = (paths: string[]) => {
    if (paths.length === 0 || !ensureWrite()) return
    triggerBrowserDownload(sftpService.archiveURL(nodeId, paths))
  }

  // ---- uploads -----------------------------------------------------------
  const enqueueFiles = (files: FileList | File[], note: string) => {
    if (!ensureWrite()) return
    const arr = Array.from(files)
    if (arr.length === 0) return
    uploads.enqueueMany(arr, path)
    toast.info(note.replace("{n}", String(arr.length)))
  }
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) enqueueFiles(e.target.files, "已加入 {n} 个上传任务")
    e.currentTarget.value = ""
  }
  const onPickFolder = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) enqueueFiles(e.target.files, "已加入 {n} 个上传任务（含子目录）")
    e.currentTarget.value = ""
  }
  const onDropFiles = (files: File[]) => enqueueFiles(files, "已加入 {n} 个上传任务")
  const gridDrop = useFilesDropzone(onDropFiles)

  // ---- row interactions --------------------------------------------------
  const onRowClick = (entry: SftpEntry, index: number, ev: React.MouseEvent) => {
    if (renamingPath) return
    if (ev.shiftKey) sel.select(entry, index, "range")
    else if (ev.ctrlKey || ev.metaKey) sel.select(entry, index, "toggle")
    else sel.select(entry, index, "set")
  }
  const onToggleRow = (entry: SftpEntry, index: number) => sel.select(entry, index, "toggle")
  const onToggleAll = () => {
    if (sel.count === entries.length && entries.length > 0) sel.clear()
    else sel.selectAll()
  }
  const onRowDoubleClick = (entry: SftpEntry) => {
    if (searchResult) {
      navigate(entry.is_dir ? entry.path : (entry as { dir?: string }).dir || parentPath(entry.path))
      return
    }
    if (entry.is_dir) {
      navigate(entry.path)
      return
    }
    openFile(entry)
  }
  const onBeforeContextMenu = (entry: SftpEntry) => {
    if (!sel.isSelected(entry.path)) {
      sel.select(entry, entries.indexOf(entry), "set")
    }
  }

  const actions: SftpContextActions = {
    onOpen: (e) => onRowDoubleClick(e),
    onDownload: downloadOne,
    onArchive: (e) => archivePaths([e.path]),
    onPreview: (e) => openFile(e),
    onEdit: (e) => {
      if (!ensureWrite()) return
      if (isEditable(e)) setEditorEntry(e)
      else toast.info("此文件不支持在线编辑", { description: "请下载到本地编辑" })
    },
    onRename: (e) => {
      if (ensureWrite()) setRenamingPath(e.path)
    },
    onDuplicate: (e) => void runDuplicate([e]),
    onChmod: (e) => {
      if (ensureWrite()) setChmodEntry(e)
    },
    onProperties: (e) => setPropsEntry(e),
    onDelete: (e) => {
      const targets = sel.isSelected(e.path) && sel.count > 1 ? selectedPaths : [e.path]
      void runDelete(targets)
    },
    onCopyPath: (e) => {
      void navigator.clipboard?.writeText(e.path)
      toast.success("已复制路径", { description: e.path })
    },
  }

  // ---- keyboard ----------------------------------------------------------
  useSftpKeyboard(
    {
      onOpen: () => {
        const e = sel.selectedEntries[0]
        if (e) onRowDoubleClick(e)
      },
      onUp: goUp,
      onDelete: () => {
        if (sel.count > 0) void runDelete(selectedPaths)
      },
      onRename: () => {
        const e = sel.selectedEntries[0]
        if (e && ensureWrite()) setRenamingPath(e.path)
      },
      onSelectAll: () => sel.selectAll(),
      onFocusPath: () => pathInputRef.current?.focus(),
      onRefresh: refresh,
      onEscape: () => {
        if (renamingPath) setRenamingPath(null)
        else if (searchResult) clearSearch()
        else if (sel.count > 0) sel.clear()
      },
    },
    !previewEntry && !editorEntry && !chmodEntry && !propsEntry && createKind == null && !approvalOpen && !viewerFile,
  )

  if (!Number.isFinite(nodeId)) {
    return <div className="p-10 text-center text-destructive">无效的节点 ID</div>
  }

  const searchSummary = searchResult
    ? `搜索「${searchResult.query}」· ${searchResult.entries.length} 个结果${searchResult.truncated ? "（已截断）" : ""}`
    : null

  return (
    <div className={className ?? "flex h-[calc(100vh-3.5rem)] min-h-[520px] flex-col"}>
      {confirmDialogEl}
      {showNodeHeader && <SftpHeader nodeId={nodeId} node={node.data} loading={node.isLoading} />}
      <SftpApprovalBar approval={approval} onApply={() => setApprovalOpen(true)} />

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-64 shrink-0 flex-col border-r md:flex">
          <SftpTree
            nodeId={nodeId}
            currentPath={path}
            onNavigate={navigate}
            canWrite={approval.canWrite}
            onMove={runMove}
            onRefresh={refresh}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <SftpToolbar
            path={path}
            onNavigate={navigate}
            onUp={goUp}
            onRefresh={refresh}
            loading={listing.isFetching}
            filter={filter}
            onFilterChange={setFilter}
            onRecursiveSearch={runRecursiveSearch}
            onClearSearch={clearSearch}
            searching={searching}
            view={view}
            onViewChange={setView}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={(k, d) => {
              setSortKey(k)
              setSortDir(d)
            }}
            showHidden={showHidden}
            onToggleHidden={() => setShowHidden((v) => !v)}
            onUpload={() => {
              if (ensureWrite()) fileInputRef.current?.click()
            }}
            onUploadFolder={() => {
              if (ensureWrite()) folderInputRef.current?.click()
            }}
            onNewFolder={() => {
              if (ensureWrite()) setCreateKind("folder")
            }}
            onNewFile={() => {
              if (ensureWrite()) setCreateKind("file")
            }}
            canWrite={approval.canWrite}
            onMove={runMove}
            pathInputRef={pathInputRef}
          />

          <SftpSelectionBar
            count={sel.count}
            totalSize={sel.totalSize}
            fileCount={sel.selectedEntries.filter((e) => !e.is_dir).length}
            onDownload={() => void downloadSelected()}
            onArchive={() => archivePaths(selectedPaths)}
            onDuplicate={() => void runDuplicate(sel.selectedEntries)}
            onDelete={() => void runDelete(selectedPaths)}
            onClear={() => sel.clear()}
          />

          {view === "grid" ? (
            <div className="relative min-h-0 flex-1 overflow-auto" {...gridDrop.dropProps}>
              {entries.length === 0 && !listing.isLoading ? (
                <div className="flex h-full min-h-[240px] items-center justify-center text-sm text-muted-foreground">
                  {searchResult ? "没有匹配的文件" : "这个目录是空的"}
                </div>
              ) : (
                <SftpGrid
                  nodeId={nodeId}
                  entries={entries}
                  isSelected={sel.isSelected}
                  selectedPaths={selectedPaths}
                  onToggleRow={onToggleRow}
                  onRowClick={onRowClick}
                  onRowDoubleClick={onRowDoubleClick}
                  contextActions={actions}
                  onBeforeContextMenu={onBeforeContextMenu}
                  onMove={runMove}
                  canWrite={approval.canWrite}
                  canThumbnail={approval.canWrite}
                />
              )}
              {gridDrop.dragFiles && <UploadOverlay />}
            </div>
          ) : (
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
              onRetry={refresh}
              isSelected={sel.isSelected}
              selectedPaths={selectedPaths}
              allSelected={sel.count === entries.length}
              onToggleAll={onToggleAll}
              onRowClick={onRowClick}
              onRowDoubleClick={onRowDoubleClick}
              onToggleRow={onToggleRow}
              contextActions={actions}
              onBeforeContextMenu={onBeforeContextMenu}
              renamingPath={renamingPath}
              onRenameSubmit={runRename}
              onRenameCancel={() => setRenamingPath(null)}
              onDropFiles={onDropFiles}
              onMove={runMove}
              canWrite={approval.canWrite}
              showLocation={!!searchResult}
            />
          )}

          <SftpStatusBar
            entries={searchResult ? [] : entries}
            selectedCount={sel.count}
            selectedSize={sel.totalSize}
            loading={listing.isFetching && !listing.isLoading}
            error={listError}
            path={path}
            searchSummary={searchSummary}
          />
          <SftpTransferDock
            tasks={uploads.tasks}
            uploadingCount={uploads.uploadingCount}
            doneCount={uploads.doneCount}
            failedCount={uploads.failedCount}
            pct={uploads.pct}
            hasActive={uploads.hasActive}
            onCancel={uploads.cancel}
            onRetry={uploads.retry}
            onCancelAll={uploads.cancelAll}
            onRetryFailed={uploads.retryFailed}
            onClearFinished={uploads.clearFinished}
          />
        </main>
      </div>

      {/* hidden upload inputs */}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onPickFiles} />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={onPickFolder}
        {...({ webkitdirectory: "", directory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
      />

      {/* dialogs */}
      <SftpPreviewModal
        nodeId={nodeId}
        entry={previewEntry}
        onClose={() => setPreviewEntry(null)}
        onEdit={(e) => {
          setPreviewEntry(null)
          if (ensureWrite() && isEditable(e)) setEditorEntry(e)
        }}
      />
      <SftpEditorModal nodeId={nodeId} entry={editorEntry} onClose={() => setEditorEntry(null)} onSaved={refresh} />
      <SftpChmodDialog nodeId={nodeId} entry={chmodEntry} onClose={() => setChmodEntry(null)} onSaved={refresh} />
      <SftpPropertiesDialog nodeId={nodeId} entry={propsEntry} onClose={() => setPropsEntry(null)} />
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
      <FileViewer
        open={!!viewerFile}
        file={viewerFile}
        gallery={imageGallery}
        mediaGallery={mediaGallery}
        onClose={() => setViewerFile(null)}
        onDownload={(f) => f.ref && triggerBrowserDownload(sftpService.downloadURL(nodeId, f.ref))}
        onSaveImage={saveImage}
        loadOfficeConfig={(f) => sftpService.officeConfig(nodeId, f.ref || "")}
      />
      <SftpApprovalSheet
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        approval={approval}
        title={node.data?.name || `节点 #${nodeId}`}
        subtitle={node.data?.host ? `${node.data.host}${node.data.port ? `:${node.data.port}` : ""}` : undefined}
      />
    </div>
  )
}

function UploadOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-primary/5 backdrop-blur-[1px]">
      <div className="flex flex-col items-center gap-1.5 rounded-xl border-2 border-dashed border-primary bg-card px-7 py-5 text-sm font-medium shadow-xl">
        <Upload className="h-6 w-6 text-primary" />
        放下文件以上传到当前目录
      </div>
    </div>
  )
}

// "report.pdf" → "report 副本.pdf", avoiding names already in the directory.
function copyName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf(".")
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ""
  let candidate = `${base} 副本${ext}`
  let i = 2
  while (taken.has(candidate)) {
    candidate = `${base} 副本 ${i}${ext}`
    i++
  }
  return candidate
}
