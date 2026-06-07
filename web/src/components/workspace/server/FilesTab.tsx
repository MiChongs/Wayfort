"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { useMutation, useQuery } from "@tanstack/react-query"
import { useTheme } from "next-themes"
import {
  ArrowLeft,
  ChevronRight,
  CornerLeftUp,
  File as FileIcon,
  FileText,
  Folder,
  Link2,
  Loader2,
  RotateCw,
  Save,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { VirtualTable } from "@/components/common/virtual-table"
import { formatBytes } from "@/components/insights/format"
import { filesService, type FileEntry } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import { codeOf, type ApiError } from "./_shared"

const MonacoEditor = dynamic(() => import("@monaco-editor/react").then((m) => m.default), {
  ssr: false,
  loading: () => (
    <div className="inline-flex items-center gap-2 p-4 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" /> 加载编辑器…
    </div>
  ),
})

type Props = { nodeId: number; tabId: string; active: boolean }

function errorHint(code: string | undefined, msg: string): string {
  if (code === "permission_denied" || /permission|read-only|password is required/i.test(msg))
    return "写入需 root / sudo NOPASSWD（编辑 /etc 等）。换 root 凭据或为 tee 配置 sudoers。"
  if (code === "too_large") return "文件过大，超出 256KB 在线编辑上限。"
  if (code === "not_found") return "路径不存在。"
  return ""
}

// Map a filename to a Monaco language id for syntax highlighting.
function langOf(name: string): string {
  const n = name.toLowerCase()
  if (n.endsWith(".json")) return "json"
  if (n.endsWith(".ya?ml") || n.endsWith(".yml") || n.endsWith(".yaml")) return "yaml"
  if (n.endsWith(".sh") || n.endsWith(".bash") || n.endsWith(".zsh")) return "shell"
  if (n.endsWith(".py")) return "python"
  if (n.endsWith(".js")) return "javascript"
  if (n.endsWith(".ts")) return "typescript"
  if (n.endsWith(".sql")) return "sql"
  if (n.endsWith(".xml") || n.endsWith(".html")) return "xml"
  if (n.endsWith(".md")) return "markdown"
  if (n.endsWith(".toml")) return "ini"
  if (n.endsWith(".conf") || n.endsWith(".cnf") || n.endsWith(".ini") || n.startsWith(".env") || n.endsWith(".properties")) return "ini"
  if (n === "dockerfile") return "dockerfile"
  return "plaintext"
}

function parentDir(p: string): string {
  const c = p.replace(/\/+$/, "")
  const i = c.lastIndexOf("/")
  return i <= 0 ? "/" : c.slice(0, i)
}
function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`
}

export function FilesTab({ nodeId, active }: Props) {
  const [dir, setDir] = React.useState("/etc")
  const [openFile, setOpenFile] = React.useState<string | null>(null)

  if (!active) return null
  if (openFile) {
    return <Editor nodeId={nodeId} path={openFile} onBack={() => setOpenFile(null)} />
  }
  return <Browser nodeId={nodeId} active={active} dir={dir} setDir={setDir} onOpen={setOpenFile} />
}

function Browser({
  nodeId,
  active,
  dir,
  setDir,
  onOpen,
}: {
  nodeId: number
  active: boolean
  dir: string
  setDir: (p: string) => void
  onOpen: (p: string) => void
}) {
  const [jump, setJump] = React.useState(dir)
  React.useEffect(() => setJump(dir), [dir])

  const list = useQuery({
    queryKey: ["files", nodeId, "list", dir],
    queryFn: () => filesService.list(nodeId, dir),
    enabled: active,
    retry: false,
  })

  const entries = React.useMemo(() => {
    const e = list.data?.entries ?? []
    // Directories first, then files; each alphabetical.
    return [...e].sort((a, b) => {
      const ad = a.type === "dir" ? 0 : 1
      const bd = b.type === "dir" ? 0 : 1
      return ad - bd || a.name.localeCompare(b.name)
    })
  }, [list.data])

  const onRow = (e: FileEntry) => {
    if (e.type === "dir") setDir(joinPath(dir, e.name))
    else onOpen(joinPath(dir, e.name))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1.5 border-b bg-card px-2 py-1.5">
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="上级目录" disabled={dir === "/"} onClick={() => setDir(parentDir(dir))}>
          <CornerLeftUp className="h-3.5 w-3.5" />
        </Button>
        <form
          className="relative min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (jump.trim().startsWith("/")) setDir(jump.trim())
          }}
        >
          <Input value={jump} onChange={(e) => setJump(e.target.value)} placeholder="/etc" className="h-7 pl-2 text-xs font-mono" />
        </form>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="刷新" onClick={() => list.refetch()}>
          <RotateCw className={cn("h-3.5 w-3.5", list.isFetching && "animate-spin")} />
        </Button>
      </header>

      <Breadcrumb dir={dir} onPick={setDir} />

      <div className="min-h-0 flex-1">
        {list.isLoading ? (
          <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 读取目录…</div>
        ) : list.isError ? (
          <div className="space-y-1 p-6 text-center text-xs text-muted-foreground">
            <div className="font-medium text-foreground">无法读取目录</div>
            <div>{(list.error as ApiError)?.message}</div>
            {errorHint(codeOf(list.error), (list.error as ApiError)?.message || "") && (
              <div className="text-foreground/80">{errorHint(codeOf(list.error), (list.error as ApiError)?.message || "")}</div>
            )}
          </div>
        ) : (
          <VirtualTable
            rows={entries}
            empty="空目录"
            header={
              <>
                <th className="px-2 py-1.5 text-left">名称</th>
                <th className="w-16 px-2 py-1.5 text-right">大小</th>
                <th className="w-12 px-2 py-1.5 text-right">权限</th>
                <th className="w-16 px-2 py-1.5 text-left">属主</th>
              </>
            }
            renderRow={(e) => (
              <>
                <td className="min-w-0 px-2 py-1">
                  <button type="button" onClick={() => onRow(e)} className="flex min-w-0 items-center gap-1.5 text-left hover:text-primary">
                    <EntryIcon type={e.type} />
                    <span className="truncate">{e.name}</span>
                  </button>
                </td>
                <td className="px-2 py-1 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                  {e.type === "dir" ? "—" : formatBytes(e.size / 1024)}
                </td>
                <td className="px-2 py-1 text-right font-mono text-[10px] text-muted-foreground">{e.mode}</td>
                <td className="max-w-[5rem] truncate px-2 py-1 text-[10px] text-muted-foreground" title={e.owner}>{e.owner}</td>
              </>
            )}
          />
        )}
      </div>
    </div>
  )
}

function EntryIcon({ type }: { type: FileEntry["type"] }) {
  if (type === "dir") return <Folder className="h-3.5 w-3.5 shrink-0 text-primary" />
  if (type === "link") return <Link2 className="h-3.5 w-3.5 shrink-0 text-[#4f9d8f] dark:text-[#5db8a6]" />
  return <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
}

function Breadcrumb({ dir, onPick }: { dir: string; onPick: (p: string) => void }) {
  const parts = dir.split("/").filter(Boolean)
  return (
    <div className="flex items-center gap-0.5 overflow-x-auto border-b px-2 py-1 text-[11px] text-muted-foreground no-scrollbar">
      <button type="button" className="shrink-0 hover:text-primary" onClick={() => onPick("/")}>/</button>
      {parts.map((p, i) => {
        const path = "/" + parts.slice(0, i + 1).join("/")
        return (
          <React.Fragment key={path}>
            <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
            <button type="button" className="shrink-0 truncate font-mono hover:text-primary" onClick={() => onPick(path)}>{p}</button>
          </React.Fragment>
        )
      })}
    </div>
  )
}

function Editor({ nodeId, path, onBack }: { nodeId: number; path: string; onBack: () => void }) {
  const { theme } = useTheme()
  const read = useQuery({
    queryKey: ["files", nodeId, "read", path],
    queryFn: () => filesService.read(nodeId, path),
    enabled: true,
    retry: false,
  })
  const [value, setValue] = React.useState<string | null>(null)
  const baseRef = React.useRef<string>("")
  React.useEffect(() => {
    if (read.data && !read.data.binary) {
      setValue(read.data.content)
      baseRef.current = read.data.content
    }
  }, [read.data])

  const save = useMutation({
    mutationFn: () => filesService.write(nodeId, path, value ?? ""),
    onSuccess: () => {
      baseRef.current = value ?? ""
      toast.success("已保存", { description: "原文件已备份为 .bak" })
    },
    onError: (e: ApiError) => toast.error("保存失败", { description: errorHint(codeOf(e), e?.message || "") || e?.message }),
  })

  const dirty = value !== null && value !== baseRef.current
  const name = path.split("/").pop() || path

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-1.5 border-b bg-card px-2 py-1.5">
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="返回目录" onClick={onBack}><ArrowLeft className="h-3.5 w-3.5" /></Button>
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>{name}</span>
        {dirty && <Badge variant="warning" className="h-4 shrink-0 px-1.5 text-[10px]">未保存</Badge>}
        {read.data?.truncated && <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[10px]" title="文件超出 256KB，仅载入前 256KB；保存会截断">已截断</Badge>}
        <Button size="sm" className="h-7 shrink-0 text-xs" disabled={!dirty || save.isPending || read.data?.binary} onClick={() => save.mutate()}>
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} 保存
        </Button>
      </header>
      <div className="min-h-0 flex-1">
        {read.isLoading ? (
          <div className="inline-flex items-center gap-2 p-6 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> 读取文件…</div>
        ) : read.isError ? (
          <div className="space-y-1 p-6 text-center text-xs text-muted-foreground">
            <div className="font-medium text-foreground">无法读取文件</div>
            <div>{(read.error as ApiError)?.message}</div>
            {errorHint(codeOf(read.error), (read.error as ApiError)?.message || "") && (
              <div className="text-foreground/80">{errorHint(codeOf(read.error), (read.error as ApiError)?.message || "")}</div>
            )}
          </div>
        ) : read.data?.binary ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            二进制文件（{formatBytes((read.data.size || 0) / 1024)}）不支持在线编辑。
          </div>
        ) : (
          <MonacoEditor
            height="100%"
            language={langOf(name)}
            theme={theme === "dark" ? "vs-dark" : "light"}
            value={value ?? ""}
            onChange={(v) => setValue(v ?? "")}
            options={{
              fontSize: 12,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              wordWrap: "on",
              tabSize: 2,
              renderWhitespace: "boundary",
            }}
          />
        )}
      </div>
    </div>
  )
}
