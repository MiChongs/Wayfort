"use client"

// Phase 11 — Terminal Snippets Sheet. A right-edge command palette + manager
// rolled into one Sheet. Users browse / pin / edit / delete reusable command
// templates and insert them (with on-the-fly variable substitution) into
// the active terminal session.
//
// Variable templating: snippets may embed `{{var}}` placeholders. When the
// user clicks "Insert", the sheet collects values for any pending variables
// in an inline form before resolving via the server-side endpoint and
// dispatching the resolved text via `onInsert`.

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, motion } from "motion/react"
import {
  ArrowDown,
  ArrowUp,
  ClipboardPaste,
  Edit3,
  Loader2,
  Pin,
  PinOff,
  Plus,
  Save,
  Search,
  Sparkles,
  Tag,
  TerminalSquare,
  Variable,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { ConfirmDeleteIconButton } from "@/components/admin/confirm-delete"
import { snippetService } from "@/lib/api/services"
import type { Snippet } from "@/lib/api/types"

type Mode = "list" | "edit"

export interface TerminalSnippetsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Called when the user selects a snippet for insertion. The text has
   * already been variable-resolved on the server. Caller should write it
   * into the active terminal session.
   */
  onInsert: (resolved: string, snippetName: string) => void
  /** Optional context — passed through unchanged so future server-side
   * resolvers can read it (host / user / region). */
  contextVars?: Record<string, string>
}

export function TerminalSnippetsSheet({
  open,
  onOpenChange,
  onInsert,
  contextVars,
}: TerminalSnippetsSheetProps) {
  const qc = useQueryClient()
  const list = useQuery({
    queryKey: ["me", "snippets"],
    queryFn: snippetService.list,
    enabled: open,
  })
  const [mode, setMode] = React.useState<Mode>("list")
  const [editing, setEditing] = React.useState<Snippet | null>(null)
  const [search, setSearch] = React.useState("")
  const [tagFilter, setTagFilter] = React.useState<string | null>(null)
  const [resolving, setResolving] = React.useState<Snippet | null>(null)

  React.useEffect(() => {
    if (!open) {
      setMode("list")
      setEditing(null)
      setSearch("")
      setTagFilter(null)
      setResolving(null)
    }
  }, [open])

  const all = list.data?.snippets || []
  const tags = React.useMemo(() => {
    const set = new Set<string>()
    for (const s of all) {
      for (const t of (s.tags || "").split(",").map((x) => x.trim()).filter(Boolean)) set.add(t)
    }
    return Array.from(set).sort()
  }, [all])
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase()
    return all.filter((s) => {
      if (tagFilter) {
        const ts = (s.tags || "").split(",").map((x) => x.trim()).filter(Boolean)
        if (!ts.includes(tagFilter)) return false
      }
      if (!q) return true
      return (
        s.name.toLowerCase().includes(q) ||
        s.body.toLowerCase().includes(q) ||
        (s.description || "").toLowerCase().includes(q)
      )
    })
  }, [all, search, tagFilter])

  const togglePin = useMutation({
    mutationFn: (s: Snippet) => snippetService.update(s.id, { pinned: !s.pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["me", "snippets"] }),
  })
  const remove = useMutation({
    mutationFn: (id: number) => snippetService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["me", "snippets"] })
      toast.success("已删除")
    },
  })

  return (
    <TooltipProvider delayDuration={150}>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-[480px]">
          <SheetHeader className="border-b px-5 pt-5 pb-3">
            <SheetTitle className="flex items-center gap-2 text-base">
              <TerminalSquare className="h-4 w-4" /> 命令片段
            </SheetTitle>
            <SheetDescription>
              复用常用命令、{{`{{`}}变量{{`}}`}} 模板。Ctrl+Shift+I 可快速打开。
            </SheetDescription>
          </SheetHeader>

          <AnimatePresence mode="wait">
            {mode === "edit" ? (
              <motion.div
                key="edit"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ type: "spring", stiffness: 320, damping: 28 }}
                className="flex min-h-0 flex-1 flex-col"
              >
                <SnippetEditor
                  existing={editing}
                  onClose={() => {
                    setMode("list")
                    setEditing(null)
                  }}
                />
              </motion.div>
            ) : resolving ? (
              <motion.div
                key="resolve"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ type: "spring", stiffness: 320, damping: 28 }}
                className="flex min-h-0 flex-1 flex-col"
              >
                <SnippetVariables
                  snippet={resolving}
                  context={contextVars}
                  onCancel={() => setResolving(null)}
                  onResolved={(text, name) => {
                    setResolving(null)
                    onInsert(text, name)
                    onOpenChange(false)
                    toast.success(`已插入「${name}」`)
                    qc.invalidateQueries({ queryKey: ["me", "snippets"] })
                  }}
                />
              </motion.div>
            ) : (
              <motion.div
                key="list"
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                transition={{ type: "spring", stiffness: 320, damping: 28 }}
                className="flex min-h-0 flex-1 flex-col"
              >
                <div className="space-y-2 border-b bg-muted/20 px-5 py-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="搜索片段..."
                      className="h-8 pl-8"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  {tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        variant={tagFilter === null ? "secondary" : "ghost"}
                        className="h-6 px-2 text-[11px]"
                        onClick={() => setTagFilter(null)}
                      >
                        全部
                      </Button>
                      {tags.map((t) => (
                        <Button
                          key={t}
                          size="sm"
                          variant={tagFilter === t ? "secondary" : "ghost"}
                          className="h-6 px-2 text-[11px]"
                          onClick={() => setTagFilter(t)}
                        >
                          <Tag className="h-3 w-3" />
                          {t}
                        </Button>
                      ))}
                    </div>
                  )}
                </div>
                <ScrollArea className="min-h-0 flex-1 px-3 py-2">
                  {list.isLoading ? (
                    <div className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中...
                    </div>
                  ) : filtered.length === 0 ? (
                    <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                      <Sparkles className="mx-auto mb-2 h-5 w-5 opacity-60" />
                      {all.length === 0
                        ? "还没有片段。下方 + 新建你的第一个常用命令。"
                        : "没有匹配结果"}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {filtered.map((s) => (
                        <SnippetRow
                          key={s.id}
                          snippet={s}
                          onInsert={() =>
                            s.variables && s.variables.length > 0
                              ? setResolving(s)
                              : void snippetService.use(s.id, contextVars || {}).then((r) => {
                                  onInsert(r.resolved, s.name)
                                  onOpenChange(false)
                                  toast.success(`已插入「${s.name}」`)
                                  qc.invalidateQueries({ queryKey: ["me", "snippets"] })
                                })
                          }
                          onEdit={() => {
                            setEditing(s)
                            setMode("edit")
                          }}
                          onTogglePin={() => togglePin.mutate(s)}
                          onDelete={() => remove.mutate(s.id)}
                          removing={remove.isPending}
                        />
                      ))}
                    </div>
                  )}
                </ScrollArea>
                <SheetFooter className="flex-row items-center justify-between gap-2 border-t bg-muted/30 px-5 py-3">
                  <span className="text-[11px] text-muted-foreground">
                    {filtered.length} / {all.length} 个片段
                  </span>
                  <Button
                    size="sm"
                    onClick={() => {
                      setEditing(null)
                      setMode("edit")
                    }}
                  >
                    <Plus className="h-3.5 w-3.5" /> 新建
                  </Button>
                </SheetFooter>
              </motion.div>
            )}
          </AnimatePresence>
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  )
}

// ----- subcomponents ------------------------------------------------------

function SnippetRow({
  snippet,
  onInsert,
  onEdit,
  onTogglePin,
  onDelete,
  removing,
}: {
  snippet: Snippet
  onInsert: () => void
  onEdit: () => void
  onTogglePin: () => void
  onDelete: () => void
  removing: boolean
}) {
  const tags = (snippet.tags || "").split(",").map((x) => x.trim()).filter(Boolean)
  return (
    <Card className="group transition-colors hover:bg-muted/40">
      <CardContent className="space-y-1.5 p-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            {snippet.pinned && <Pin className="h-3 w-3 shrink-0 text-amber-500" />}
            <span className="truncate text-sm font-medium">{snippet.name}</span>
            {snippet.usage_count > 0 && (
              <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                {snippet.usage_count}×
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onTogglePin}>
                  {snippet.pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{snippet.pinned ? "取消置顶" : "置顶"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={onEdit}>
                  <Edit3 className="h-3 w-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>编辑</TooltipContent>
            </Tooltip>
            <ConfirmDeleteIconButton
              className="h-6 w-6"
              iconClassName="h-3 w-3"
              title={`删除片段 "${snippet.name}"?`}
              description="该操作不可恢复。"
              loading={removing}
              onConfirm={onDelete}
            />
          </div>
        </div>
        {snippet.description && (
          <p className="truncate text-[11px] text-muted-foreground">{snippet.description}</p>
        )}
        <pre className="overflow-x-auto rounded-md border bg-muted/50 px-2 py-1.5 font-mono text-[11px] leading-snug">
          {snippet.body.length > 240 ? snippet.body.slice(0, 240) + "…" : snippet.body}
        </pre>
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex flex-wrap gap-1">
            {tags.map((t) => (
              <Badge key={t} variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
                {t}
              </Badge>
            ))}
            {snippet.variables && snippet.variables.length > 0 && (
              <Badge variant="outline" className="h-4 border-sky-500/30 bg-sky-500/10 px-1.5 text-[10px] font-normal text-sky-600 dark:text-sky-300">
                <Variable className="mr-0.5 h-2.5 w-2.5" />
                {snippet.variables.length} 变量
              </Badge>
            )}
          </div>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={onInsert}>
            <ClipboardPaste className="h-3 w-3" /> 插入
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function SnippetEditor({ existing, onClose }: { existing: Snippet | null; onClose: () => void }) {
  const qc = useQueryClient()
  const [draft, setDraft] = React.useState({
    name: existing?.name || "",
    description: existing?.description || "",
    body: existing?.body || "",
    tags: existing?.tags || "",
    pinned: existing?.pinned || false,
  })

  const save = useMutation({
    mutationFn: () =>
      existing
        ? snippetService.update(existing.id, draft)
        : snippetService.create(draft),
    onSuccess: () => {
      toast.success(existing ? "已更新" : "已创建")
      qc.invalidateQueries({ queryKey: ["me", "snippets"] })
      onClose()
    },
    onError: (e: Error) => toast.error("保存失败", { description: e.message }),
  })

  const canSave = !!draft.name.trim() && !!draft.body.trim() && !save.isPending

  return (
    <>
      <ScrollArea className="min-h-0 flex-1 px-5 py-4">
        <div className="space-y-3">
          <Field label="名称" required>
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="如:跟踪 nginx 错误日志"
              autoFocus
            />
          </Field>
          <Field label="描述">
            <Input
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              placeholder="一句话说明这段命令的用途"
            />
          </Field>
          <Field label="标签">
            <Input
              value={draft.tags}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
              placeholder="逗号分隔: ops, nginx, debug"
            />
          </Field>
          <Field
            label="命令体"
            required
            hint={
              <span>
                可使用 <code className="rounded bg-muted px-1 font-mono">{`{{var}}`}</code> 变量占位,
                插入时会弹出变量填写表单。
              </span>
            }
          >
            <Textarea
              rows={10}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              placeholder={"如: sudo journalctl -u {{service}} --since '{{since}}' -n 200 -f"}
              className="font-mono text-xs leading-relaxed"
            />
          </Field>
          <Separator />
          <div className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-2">
            <div className="space-y-0.5">
              <Label className="text-sm">置顶</Label>
              <p className="text-[11px] text-muted-foreground">置顶后显示在列表最上方。</p>
            </div>
            <Switch
              checked={draft.pinned}
              onCheckedChange={(v) => setDraft({ ...draft, pinned: v })}
            />
          </div>
        </div>
      </ScrollArea>
      <SheetFooter className="flex-row items-center justify-between gap-2 border-t bg-muted/30 px-5 py-3">
        <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
          <ArrowUp className="h-3.5 w-3.5 rotate-90" /> 返回
        </Button>
        <Button onClick={() => save.mutate()} disabled={!canSave}>
          {save.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {existing ? "保存" : "创建"}
        </Button>
      </SheetFooter>
    </>
  )
}

function SnippetVariables({
  snippet,
  context,
  onCancel,
  onResolved,
}: {
  snippet: Snippet
  context?: Record<string, string>
  onCancel: () => void
  onResolved: (resolved: string, name: string) => void
}) {
  const [values, setValues] = React.useState<Record<string, string>>(() => ({ ...(context || {}) }))
  const vars = snippet.variables || []
  const resolve = useMutation({
    mutationFn: () => snippetService.use(snippet.id, values),
    onSuccess: (r) => onResolved(r.resolved, snippet.name),
    onError: (e: Error) => toast.error("插入失败", { description: e.message }),
  })
  const allFilled = vars.every((v) => values[v] !== undefined && values[v].trim() !== "")
  return (
    <>
      <ScrollArea className="min-h-0 flex-1 px-5 py-4">
        <div className="space-y-4">
          <div className="rounded-md border bg-muted/30 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium">
              <TerminalSquare className="h-3.5 w-3.5" />
              {snippet.name}
            </div>
            {snippet.description && (
              <p className="text-[11px] text-muted-foreground">{snippet.description}</p>
            )}
          </div>
          <div>
            <Label className="mb-2 block text-xs uppercase tracking-wide text-muted-foreground">
              填写变量
            </Label>
            <div className="space-y-2">
              {vars.map((v) => (
                <Field key={v} label={v}>
                  <Input
                    value={values[v] ?? ""}
                    onChange={(e) => setValues({ ...values, [v]: e.target.value })}
                    placeholder={`{{${v}}}`}
                  />
                </Field>
              ))}
            </div>
          </div>
          <Field label="预览">
            <pre className="rounded-md border bg-muted/50 p-2 font-mono text-[11px] leading-snug whitespace-pre-wrap">
              {preview(snippet.body, values)}
            </pre>
          </Field>
        </div>
      </ScrollArea>
      <SheetFooter className="flex-row items-center justify-between gap-2 border-t bg-muted/30 px-5 py-3">
        <Button variant="ghost" onClick={onCancel}>
          <ArrowDown className="h-3.5 w-3.5 rotate-90" /> 返回
        </Button>
        <Button onClick={() => resolve.mutate()} disabled={!allFilled || resolve.isPending}>
          {resolve.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardPaste className="h-3.5 w-3.5" />}
          插入到终端
        </Button>
      </SheetFooter>
    </>
  )
}

function preview(body: string, values: Record<string, string>) {
  return body.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (m, name) => {
    if (values[name] !== undefined && values[name] !== "") return values[name]
    return m
  })
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string
  required?: boolean
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

void cn
