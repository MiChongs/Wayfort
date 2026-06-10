"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { BookOpen, Database, FileText, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, Upload } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select"
import { DataTable, type Column } from "@/components/common/data-table"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { useFilesDropzone } from "@/components/sftp/useFilesDropzone"
import { useSseSnapshot } from "@/lib/hooks/use-sse-snapshot"
import { useCurrentUser } from "@/lib/hooks/use-current-user"
import { aiKnowledgeService, aiProviderService } from "@/lib/api/services"
import type { AIDocument, AIKnowledgeBase, KBIngestStatus } from "@/lib/api/types"
import { fmtBytes, relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { StatusDot, type Tone } from "@/components/ai/tool-views/shared"

const STATUS_TONE: Record<KBIngestStatus, Tone> = {
  ready: "success",
  embedding: "warning",
  chunking: "warning",
  pending: "warning",
  failed: "error",
}
const STATUS_LABEL: Record<KBIngestStatus, string> = {
  ready: "就绪", embedding: "嵌入中", chunking: "分块中", pending: "排队中", failed: "失败",
}

export default function AIKnowledgePage() {
  const qc = useQueryClient()
  const me = useCurrentUser()
  const kbs = useQuery({ queryKey: ["ai", "knowledge-bases"], queryFn: aiKnowledgeService.listKBs })
  const [selectedId, setSelectedId] = React.useState<number | null>(null)

  const list = kbs.data?.knowledge_bases ?? []
  const selected = list.find((k) => k.id === selectedId) ?? null
  const [editing, setEditing] = React.useState<AIKnowledgeBase | null>(null)
  React.useEffect(() => {
    if (!selectedId && list.length > 0) setSelectedId(list[0].id)
  }, [list, selectedId])

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <BookOpen className="h-5 w-5" /> AI 知识库
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            上传文档构建检索增强（RAG）知识库；智能体可挂载后语义检索作答。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <EmbeddingSettingButton />
          <CreateKBDialog
            canBeGlobal={!!me?.adm}
            onCreated={(id) => { qc.invalidateQueries({ queryKey: ["ai", "knowledge-bases"] }); setSelectedId(id) }}
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[320px_1fr]">
        <div className="space-y-2">
          {kbs.isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
          {!kbs.isLoading && list.length === 0 && (
            <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
              还没有知识库。点击右上角「新建知识库」。
            </p>
          )}
          {list.map((kb) => (
            <KBCard
              key={kb.id}
              kb={kb}
              active={kb.id === selectedId}
              onClick={() => setSelectedId(kb.id)}
              onEdit={() => setEditing(kb)}
              onDelete={async () => {
                const ok = await confirmDialog({ title: `删除知识库「${kb.name}」？`, description: "其下所有文档与向量将一并删除。", destructive: true })
                if (!ok) return
                await aiKnowledgeService.removeKB(kb.id)
                toast.success("已删除")
                if (selectedId === kb.id) setSelectedId(null)
                qc.invalidateQueries({ queryKey: ["ai", "knowledge-bases"] })
              }}
            />
          ))}
        </div>

        <div className="min-w-0 space-y-4">
          {selected ? (
            <>
              <DocumentPanel kb={selected} onChanged={() => qc.invalidateQueries({ queryKey: ["ai", "knowledge-bases"] })} />
              <SearchProbe kb={selected} />
            </>
          ) : (
            <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
              选择左侧一个知识库查看文档
            </div>
          )}
        </div>
      </div>

      {editing && (
        <EditKBDialog
          kb={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({ queryKey: ["ai", "knowledge-bases"] }) }}
        />
      )}
    </div>
  )
}

function KBCard({ kb, active, onClick, onEdit, onDelete }: { kb: AIKnowledgeBase; active: boolean; onClick: () => void; onEdit: () => void; onDelete: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        "group cursor-pointer rounded-lg border p-3 transition-colors",
        active ? "border-primary/50 bg-primary/5" : "border-border hover:bg-muted/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{kb.name}</span>
        {!kb.enabled && <Badge variant="outline" className="text-warning">停用</Badge>}
        {kb.scope === "global" ? <Badge variant="success">global</Badge> : <Badge variant="outline">personal</Badge>}
        <Button
          variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onEdit() }}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100"
          onClick={(e) => { e.stopPropagation(); onDelete() }}
        >
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </div>
      {kb.description && <p className="mt-0.5 truncate text-xs text-muted-foreground">{kb.description}</p>}
      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{kb.document_count} 文档 · {kb.chunk_count} 片段</span>
        {kb.embedding_model && <span className="truncate">{kb.embedding_model}</span>}
      </div>
    </div>
  )
}

function DocumentPanel({ kb, onChanged }: { kb: AIKnowledgeBase; onChanged: () => void }) {
  const qc = useQueryClient()
  const initial = useQuery({ queryKey: ["ai", "kb-docs", kb.id], queryFn: () => aiKnowledgeService.listDocs(kb.id) })
  // Live status while ingest runs; falls back to the initial query frame.
  const live = useSseSnapshot<{ documents: AIDocument[] }>(aiKnowledgeService.ingestStreamURL(kb.id), { enabled: true })
  const docs = (live.status === "live" ? live.data?.documents : undefined) ?? initial.data?.documents ?? []

  const [uploading, setUploading] = React.useState<{ name: string; pct: number }[]>([])
  const fileInput = React.useRef<HTMLInputElement>(null)

  const upload = React.useCallback(async (files: File[]) => {
    for (const f of files) {
      setUploading((u) => [...u, { name: f.name, pct: 0 }])
      try {
        await aiKnowledgeService.uploadDoc(kb.id, f, {
          name: f.name,
          onProgress: (sent, total) =>
            setUploading((u) => u.map((x) => (x.name === f.name ? { ...x, pct: total ? Math.round((sent / total) * 100) : 0 } : x))),
        })
      } catch (e) {
        toast.error(`上传失败：${f.name}`, { description: (e as Error).message })
      } finally {
        setUploading((u) => u.filter((x) => x.name !== f.name))
      }
    }
    qc.invalidateQueries({ queryKey: ["ai", "kb-docs", kb.id] })
    onChanged()
  }, [kb.id, qc, onChanged])

  const { dragFiles, dropProps } = useFilesDropzone(upload)

  const cols: Column<AIDocument>[] = [
    { header: "文档", cell: (d) => <span className="truncate font-medium">{d.title}</span> },
    {
      header: "状态",
      cell: (d) => (
        <span className="flex items-center gap-1.5">
          <StatusDot tone={STATUS_TONE[d.status] ?? "muted"} />
          <span className="text-xs">{STATUS_LABEL[d.status] ?? d.status}</span>
          {d.status === "failed" && d.error && <span className="truncate text-[10px] text-destructive">{d.error}</span>}
        </span>
      ),
    },
    { header: "片段", className: "tabular-nums", cell: (d) => d.chunk_count || "—" },
    { header: "大小", className: "tabular-nums", cell: (d) => fmtBytes(d.size) },
    { header: "更新", cell: (d) => <span className="text-xs text-muted-foreground">{relTime(d.updated_at)}</span> },
    {
      header: "操作", className: "text-right",
      cell: (d) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost" size="icon" title="重新索引"
            onClick={async () => { await aiKnowledgeService.reingestDoc(kb.id, d.id); toast.success("已触发重新索引") }}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost" size="icon" title="删除"
            onClick={async () => {
              const ok = await confirmDialog({ title: `删除文档「${d.title}」？`, destructive: true })
              if (!ok) return
              await aiKnowledgeService.removeDoc(kb.id, d.id)
              qc.invalidateQueries({ queryKey: ["ai", "kb-docs", kb.id] })
              onChanged()
            }}
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-3" {...dropProps}>
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors",
          dragFiles ? "border-primary bg-primary/5" : "border-border",
        )}
      >
        <Upload className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm">拖拽文件到此，或</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
            <Plus className="h-4 w-4" /> 选择文件
          </Button>
          <ImportURLButton kbId={kb.id} onImported={() => { qc.invalidateQueries({ queryKey: ["ai", "kb-docs", kb.id] }); onChanged() }} />
        </div>
        <p className="text-[11px] text-muted-foreground">支持文本 / Markdown / JSON / 日志 / PDF / DOCX / HTML，或从网址导入</p>
        <input
          ref={fileInput} type="file" multiple className="hidden"
          onChange={(e) => { const fs = Array.from(e.target.files ?? []); if (fs.length) upload(fs); e.target.value = "" }}
        />
      </div>

      {uploading.length > 0 && (
        <div className="space-y-1 rounded-lg border border-border p-2">
          {uploading.map((u) => (
            <div key={u.name} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">{u.name}</span>
              <span className="tabular-nums text-muted-foreground">{u.pct}%</span>
            </div>
          ))}
        </div>
      )}

      <DataTable columns={cols} rows={docs} loading={initial.isLoading} virtualize />
    </div>
  )
}

function ImportURLButton({ kbId, onImported }: { kbId: number; onImported: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [url, setUrl] = React.useState("")
  const imp = useMutation({
    mutationFn: () => aiKnowledgeService.importURL(kbId, url.trim()),
    onSuccess: () => { setOpen(false); setUrl(""); onImported(); toast.success("已导入，正在索引") },
    onError: (e: unknown) => toast.error("导入失败", { description: (e as Error).message }),
  })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">从网址导入</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>从网址导入</DialogTitle></DialogHeader>
        <div className="space-y-1">
          <Label>URL</Label>
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          <p className="text-xs text-muted-foreground">抓取网页/文档正文（HTML/PDF/文本），自动分块入库。</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={() => imp.mutate()} disabled={!url.trim() || imp.isPending}>导入</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CreateKBDialog({ canBeGlobal, onCreated }: { canBeGlobal: boolean; onCreated: (id: number) => void }) {
  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [scope, setScope] = React.useState<"personal" | "global">("personal")

  const create = useMutation({
    mutationFn: () => aiKnowledgeService.createKB({ name, description, scope }),
    onSuccess: (r) => { setOpen(false); setName(""); setDescription(""); onCreated(r.id); toast.success("已创建知识库") },
    onError: (e: unknown) => toast.error("创建失败", { description: (e as Error).message }),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus className="h-4 w-4" /> 新建知识库</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>新建知识库</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>名称 *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label>描述</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="space-y-1">
            <Label>范围</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as "personal" | "global")}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">个人</SelectItem>
                {canBeGlobal && <SelectItem value="global">全局</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">嵌入模型由全局「嵌入设置」决定，并在首次入库时冻结。</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={() => create.mutate()} disabled={!name || create.isPending}>创建</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Retrieval probe: run the same hybrid search the agent's knowledge_search
// tool uses, so an operator can verify documents are actually retrievable.
function SearchProbe({ kb }: { kb: AIKnowledgeBase }) {
  const [query, setQuery] = React.useState("")
  const search = useMutation({
    mutationFn: () => aiKnowledgeService.search(kb.id, query.trim(), 8),
    onError: (e: unknown) => toast.error("检索失败", { description: (e as Error).message }),
  })
  const hits = search.data?.hits
  const matchLabel: Record<string, string> = { vector: "语义", keyword: "关键词", hybrid: "语义+关键词" }

  return (
    <div className="rounded-lg border border-border">
      <div className="border-b border-border px-4 py-2.5">
        <span className="text-sm font-medium">检索测试</span>
        <span className="ml-2 text-xs text-muted-foreground">用智能体同款混合检索验证文档能否被命中</span>
      </div>
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && query.trim() && !search.isPending) search.mutate() }}
            placeholder="输入问题或关键词，例如：nginx 502 排查"
          />
          <Button size="sm" disabled={!query.trim() || search.isPending} onClick={() => search.mutate()}>
            {search.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            检索
          </Button>
        </div>
        {hits && hits.length === 0 && (
          <p className="text-sm text-muted-foreground">没有命中——文档可能还在索引中，或内容与查询无关。</p>
        )}
        {hits && hits.length > 0 && (
          <div className="space-y-2">
            {hits.map((h) => (
              <div key={h.chunk_id} className="rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{h.document || `文档 #${h.document_id}`}</span>
                  {h.match && (
                    <Badge variant="outline" className="h-4 px-1 text-[10px]">{matchLabel[h.match] ?? h.match}</Badge>
                  )}
                  {h.score > 0 && (
                    <span className="ml-auto tabular-nums text-muted-foreground">相似度 {(h.score * 100).toFixed(1)}%</span>
                  )}
                </div>
                <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">{h.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function EditKBDialog({ kb, onClose, onSaved }: { kb: AIKnowledgeBase; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = React.useState(kb.name)
  const [description, setDescription] = React.useState(kb.description ?? "")
  const [enabled, setEnabled] = React.useState(kb.enabled)
  const save = useMutation({
    mutationFn: () => aiKnowledgeService.updateKB(kb.id, { name: name.trim(), description: description.trim(), enabled }),
    onSuccess: () => { toast.success("已保存"); onSaved() },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>编辑知识库</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>名称 *</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label>描述</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <div>
              <p className="text-sm font-medium">启用</p>
              <p className="text-xs text-muted-foreground">停用后智能体检索不到该库内容</p>
            </div>
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EmbeddingSettingButton() {
  const [open, setOpen] = React.useState(false)
  const setting = useQuery({ queryKey: ["ai", "embedding-setting"], queryFn: aiKnowledgeService.embeddingSetting, enabled: open })
  const providers = useQuery({ queryKey: ["ai", "providers"], queryFn: aiProviderService.list, enabled: open })
  const [providerId, setProviderId] = React.useState(0)
  const [model, setModel] = React.useState("")

  React.useEffect(() => {
    if (setting.data) { setProviderId(setting.data.provider_id || 0); setModel(setting.data.model || "") }
  }, [setting.data])

  const save = useMutation({
    mutationFn: () => aiKnowledgeService.setEmbeddingSetting({ provider_id: providerId, model }),
    onSuccess: () => { setOpen(false); toast.success("已更新嵌入设置") },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline"><Database className="h-4 w-4" /> 嵌入设置</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>嵌入设置</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            选择负责生成向量的提供商与嵌入模型（Anthropic 无嵌入 API，请用 OpenAI/Gemini/兼容网关，如本地 Ollama）。留空则自动挑选。
          </p>
          <div className="space-y-1">
            <Label>提供商</Label>
            <Select value={providerId ? String(providerId) : ""} onValueChange={(v) => setProviderId(Number(v))}>
              <SelectTrigger><SelectValue placeholder="自动" /></SelectTrigger>
              <SelectContent>
                {(providers.data?.providers ?? []).map((p) => (
                  <SelectItem key={p.id} value={String(p.id)}>{p.display_name || p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>嵌入模型</Label>
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="如 text-embedding-3-large / nomic-embed-text" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>取消</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
