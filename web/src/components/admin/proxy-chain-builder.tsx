"use client"

// ProxyChainBuilder — Phase 10's interactive replacement for the old
// "comma-separated proxy id" Input field. Rendered inside the AddNodeSheet
// (and reusable on the standalone proxy templates page), it lets operators
// compose hop sequences visually with drag-friendly up/down controls, validate
// the chain against the backend lint rules, and run a real end-to-end probe
// before saving the node.
//
// Design pillars
// --------------
// - **Pure controlled component**: parent owns `value: string` (comma-separated
//   proxy ids) and `onChange` so the chain integrates cleanly with the
//   surrounding draft state. No internal redux, no useImperativeHandle.
// - **Optimistic UX**: validation is debounced and triggered on every change;
//   the user gets per-hop badges without clicking a button. The Test button
//   is a separate, explicit action because it consumes real connections.
// - **shadcn primitives only**: Card / Badge / Button / Select / Tooltip /
//   Popover / AlertDialog — no inline `style={}`, no raw `<button>`.
// - **Motion-aware**: hop list uses motion.li with LayoutGroup so re-ordering
//   animates without jank. Respects prefers-reduced-motion.
// - **Templates**: a Popover lets the operator apply a saved template or
//   persist the current chain as one.

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react"
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  CircleSlash,
  Info,
  Loader2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Server,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { chainTemplateService, proxyService } from "@/lib/api/services"
import type {
  ChainHopTestResult,
  ChainIssue,
  Proxy,
  ProxyChainTemplate,
  ProxyKind,
} from "@/lib/api/types"

const KIND_LABEL: Record<ProxyKind, string> = {
  direct: "Direct",
  socks5: "SOCKS5",
  bastion: "SSH 跳板",
  http_connect: "HTTP CONNECT",
}

const KIND_TONE: Record<ProxyKind, string> = {
  direct: "bg-muted text-muted-foreground border-border",
  socks5: "bg-sky-500/10 text-sky-600 dark:text-sky-300 border-sky-500/30",
  bastion: "bg-amber-500/10 text-amber-600 dark:text-amber-300 border-amber-500/30",
  http_connect: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300 border-emerald-500/30",
}

export interface ProxyChainBuilderProps {
  value: string
  onChange: (next: string) => void
  proxies: Proxy[]
  /** target host:port the chain will reach — used in Test Chain probe */
  target?: string
  /** disable the entire control while the parent submits */
  disabled?: boolean
  /** smaller footprint for sidebars; defaults to false */
  compact?: boolean
  className?: string
}

export function ProxyChainBuilder({
  value,
  onChange,
  proxies,
  target,
  disabled,
  compact,
  className,
}: ProxyChainBuilderProps) {
  const qc = useQueryClient()
  const reducedMotion = useReducedMotion()
  // The chain is stored as canonical "1,2,3" so it integrates with existing
  // backend field shapes; we parse it once into ids[] for rendering.
  const ids = React.useMemo(() => parseChainIds(value), [value])
  const proxyById = React.useMemo(() => {
    const m = new Map<number, Proxy>()
    for (const p of proxies) m.set(p.id, p)
    return m
  }, [proxies])

  // Debounced server-side validation. We re-run it whenever the chain changes
  // so the UI never lies about hop legitimacy.
  const [issues, setIssues] = React.useState<ChainIssue[]>([])
  const [validating, setValidating] = React.useState(false)
  React.useEffect(() => {
    if (ids.length === 0) {
      setIssues([])
      return
    }
    const handle = setTimeout(async () => {
      setValidating(true)
      try {
        const r = await proxyService.validateChain(value)
        setIssues(r.issues || [])
      } catch (e) {
        // Surface as a single synthetic issue rather than crashing.
        setIssues([
          {
            hop: -1,
            severity: "warning",
            code: "validate_unavailable",
            message: (e as Error).message,
          },
        ])
      } finally {
        setValidating(false)
      }
    }, 350)
    return () => clearTimeout(handle)
  }, [value, ids.length])

  // Test Chain — explicit, user-triggered. Results are kept per-hop so we can
  // render badges next to each hop card after the probe lands.
  const [testResults, setTestResults] = React.useState<ChainHopTestResult[] | null>(null)
  const [testOK, setTestOK] = React.useState<boolean | null>(null)
  const test = useMutation({
    mutationFn: () => proxyService.testChain(value, target || ""),
    onMutate: () => {
      setTestResults(null)
      setTestOK(null)
    },
    onSuccess: (r) => {
      setTestResults(r.results || [])
      setTestOK(r.ok)
      if (r.ok) toast.success("代理链测试通过", { description: target ? `目标 ${target} 可达` : "所有 hop 建链成功" })
      else toast.error("代理链测试失败", { description: r.results?.find((x) => !x.ok)?.error || "请查看每跳详情" })
    },
    onError: (e: Error) => toast.error("测试请求失败", { description: e.message }),
  })

  // Templates list — fetched once and reused via a Popover.
  const templates = useQuery({
    queryKey: ["admin", "chain-templates"],
    queryFn: chainTemplateService.list,
    staleTime: 30_000,
  })

  // Internal helpers --------------------------------------------------------
  const updateIds = React.useCallback(
    (next: number[]) => onChange(next.join(",")),
    [onChange],
  )

  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length) return
    const next = [...ids]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    updateIds(next)
  }

  const remove = (idx: number) => {
    const next = [...ids]
    next.splice(idx, 1)
    updateIds(next)
  }

  const addHop = (id: number) => {
    if (ids.includes(id)) {
      toast.warning("该代理已在链中,跳过添加")
      return
    }
    updateIds([...ids, id])
  }

  // Available proxies to add: not already in chain + not disabled.
  const candidates = React.useMemo(
    () => proxies.filter((p) => !ids.includes(p.id) && !p.disabled),
    [proxies, ids],
  )

  const hops = ids.map((id) => proxyById.get(id))
  const errorCount = issues.filter((i) => i.severity === "error").length
  const warningCount = issues.filter((i) => i.severity === "warning").length

  // ----- Render -----------------------------------------------------------
  return (
    <TooltipProvider delayDuration={200}>
      <div className={cn("space-y-3", className)}>
        <div className="flex items-center justify-between gap-2">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">代理链</span>
              {ids.length === 0 ? (
                <Badge variant="outline" className="font-normal text-muted-foreground">
                  <CircleSlash className="mr-1 h-3 w-3" /> 直连
                </Badge>
              ) : (
                <Badge variant="secondary" className="font-normal">
                  {ids.length} 跳
                </Badge>
              )}
              {validating && (
                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" aria-label="校验中" />
              )}
            </div>
            <p className="text-xs text-muted-foreground">按顺序经过每跳,直至到达目标节点。</p>
          </div>
          <div className="flex items-center gap-1.5">
            <ChainTemplatesPopover
              templates={templates.data?.templates || []}
              loading={templates.isLoading}
              onApply={(t) => {
                onChange(t.chain)
                toast.success(`已套用模板 “${t.name}”`)
              }}
              onSaveCurrent={() => qc.invalidateQueries({ queryKey: ["admin", "chain-templates"] })}
              currentChain={value}
              hasChain={ids.length > 0}
              disabled={disabled}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => test.mutate()}
                  disabled={disabled || ids.length === 0 || test.isPending}
                >
                  {test.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Zap className="h-3.5 w-3.5" />
                  )}
                  测试
                </Button>
              </TooltipTrigger>
              <TooltipContent>对当前链发起真实 dial 探测</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <Card className={cn("border-dashed", compact ? "py-2" : "py-3")}>
          <CardContent className="space-y-2 p-3">
            <LayoutGroup id="proxy-chain-hops">
              <AnimatePresence initial={false}>
                {hops.length === 0 ? (
                  <motion.div
                    initial={reducedMotion ? false : { opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    className="rounded-md border border-dashed bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground"
                  >
                    <CircleSlash className="mx-auto mb-2 h-5 w-5" />
                    暂无 hop。下方添加代理或套用模板,留空即为直连。
                  </motion.div>
                ) : (
                  <ol className="space-y-1.5">
                    <li className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border bg-background text-[10px] font-semibold">
                        S
                      </span>
                      客户端 / 网关
                    </li>
                    {hops.map((p, idx) => {
                      const hopResult = testResults?.find((r) => r.hop === idx)
                      const hopIssues = issues.filter((i) => i.hop === idx)
                      return (
                        <motion.li
                          layout={!reducedMotion}
                          key={ids[idx]}
                          initial={reducedMotion ? false : { opacity: 0, x: -8 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={reducedMotion ? undefined : { opacity: 0, x: -8 }}
                          transition={{ type: "spring", stiffness: 360, damping: 28 }}
                        >
                          <HopRow
                            index={idx}
                            total={hops.length}
                            proxy={p}
                            id={ids[idx]}
                            issues={hopIssues}
                            testResult={hopResult}
                            disabled={!!disabled}
                            onMoveUp={() => move(idx, idx - 1)}
                            onMoveDown={() => move(idx, idx + 1)}
                            onRemove={() => remove(idx)}
                          />
                        </motion.li>
                      )
                    })}
                    <li className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border bg-background text-[10px] font-semibold">
                        T
                      </span>
                      目标节点 {target ? <span className="font-mono">({target})</span> : null}
                    </li>
                  </ol>
                )}
              </AnimatePresence>
            </LayoutGroup>

            <AddHopRow candidates={candidates} disabled={disabled} onAdd={addHop} />
          </CardContent>
        </Card>

        {/* lint + test feedback strip */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs">
          <div className="flex items-center gap-2 text-muted-foreground">
            {ids.length === 0 ? (
              <span>未设置代理链:网关将直接 dial 目标节点。</span>
            ) : errorCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-destructive">
                <AlertCircle className="h-3.5 w-3.5" /> {errorCount} 项错误,无法连接
              </span>
            ) : warningCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <ShieldAlert className="h-3.5 w-3.5" /> {warningCount} 项警告
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3.5 w-3.5" /> 链路结构有效
              </span>
            )}
          </div>
          {testOK !== null && (
            <Badge
              variant="outline"
              className={cn(
                "font-normal",
                testOK
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                  : "border-destructive/30 bg-destructive/10 text-destructive",
              )}
            >
              {testOK ? <Check className="mr-1 h-3 w-3" /> : <X className="mr-1 h-3 w-3" />}
              {testOK ? "探测通过" : "探测失败"}
            </Badge>
          )}
        </div>

        {/* per-chain lint issues with no specific hop slot */}
        {issues
          .filter((i) => i.hop < 0 || !ids[i.hop])
          .map((i, idx) => (
            <div
              key={idx}
              className={cn(
                "flex items-start gap-2 rounded-md border px-3 py-2 text-xs",
                i.severity === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
                i.severity === "warning" && "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                i.severity === "info" && "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-300",
              )}
            >
              <IssueIcon severity={i.severity} />
              <span>{i.message}</span>
            </div>
          ))}
      </div>
    </TooltipProvider>
  )
}

// ----- subcomponents ------------------------------------------------------

function HopRow({
  index,
  total,
  id,
  proxy,
  issues,
  testResult,
  disabled,
  onMoveUp,
  onMoveDown,
  onRemove,
}: {
  index: number
  total: number
  id: number
  proxy?: Proxy
  issues: ChainIssue[]
  testResult?: ChainHopTestResult
  disabled: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
}) {
  const missing = !proxy
  const blocking = issues.some((i) => i.severity === "error") || missing
  return (
    <div
      className={cn(
        "group relative flex items-center gap-3 rounded-md border bg-card px-3 py-2 transition-colors",
        blocking && "border-destructive/30 ring-1 ring-destructive/10",
      )}
    >
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
        {index + 1}
      </div>
      <div className="min-w-0 flex-1">
        {missing ? (
          <div className="space-y-0.5">
            <div className="flex items-center gap-2 text-sm font-medium text-destructive">
              <AlertCircle className="h-3.5 w-3.5" />
              代理 #{id} 已不存在
            </div>
            <p className="text-xs text-muted-foreground">移除该 hop 或重新选择。</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{proxy.name}</span>
              <Badge variant="outline" className={cn("font-normal", KIND_TONE[proxy.kind])}>
                {KIND_LABEL[proxy.kind]}
              </Badge>
              {proxy.disabled && (
                <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 font-normal text-amber-700 dark:text-amber-300">
                  已禁用
                </Badge>
              )}
              {testResult && (
                <Badge
                  variant="outline"
                  className={cn(
                    "font-normal",
                    testResult.ok
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                      : "border-destructive/30 bg-destructive/10 text-destructive",
                  )}
                >
                  {testResult.ok ? "通过" : "失败"} · {testResult.duration_ms}ms
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              {proxy.host ? <span className="font-mono">{proxy.host}:{proxy.port}</span> : <span>—</span>}
              {proxy.description && <span className="truncate">{proxy.description}</span>}
            </div>
            {issues.map((i, k) => (
              <div
                key={k}
                className={cn(
                  "flex items-start gap-1.5 pt-1 text-[11px]",
                  i.severity === "error" && "text-destructive",
                  i.severity === "warning" && "text-amber-600 dark:text-amber-400",
                  i.severity === "info" && "text-sky-600 dark:text-sky-300",
                )}
              >
                <IssueIcon severity={i.severity} />
                {i.message}
              </div>
            ))}
            {testResult && !testResult.ok && testResult.error && (
              <div className="pt-1 text-[11px] text-destructive">{testResult.error}</div>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              disabled={disabled || index === 0}
              onClick={onMoveUp}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>上移</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              disabled={disabled || index === total - 1}
              onClick={onMoveDown}
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>下移</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:bg-destructive/10"
              disabled={disabled}
              onClick={onRemove}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>移除</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

function AddHopRow({
  candidates,
  disabled,
  onAdd,
}: {
  candidates: Proxy[]
  disabled?: boolean
  onAdd: (id: number) => void
}) {
  const [pick, setPick] = React.useState<string>("")
  return (
    <div className="flex items-center gap-2 pt-1">
      <Select
        value={pick}
        onValueChange={(v) => {
          setPick(v)
          onAdd(Number(v))
          // reset so the same proxy can be added later if removed
          setTimeout(() => setPick(""), 0)
        }}
        disabled={disabled || candidates.length === 0}
      >
        <SelectTrigger className="h-8 flex-1">
          <SelectValue placeholder={candidates.length === 0 ? "无可用代理" : "+ 添加 hop…"} />
        </SelectTrigger>
        <SelectContent>
          {candidates.map((p) => (
            <SelectItem key={p.id} value={String(p.id)}>
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={cn("font-normal text-[10px]", KIND_TONE[p.kind])}>
                  {KIND_LABEL[p.kind]}
                </Badge>
                <span className="font-medium">{p.name}</span>
                {p.host ? <span className="text-xs text-muted-foreground font-mono">{p.host}:{p.port}</span> : null}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="hidden text-xs text-muted-foreground sm:inline">
        共 {candidates.length} 个可用
      </span>
    </div>
  )
}

function ChainTemplatesPopover({
  templates,
  loading,
  onApply,
  onSaveCurrent,
  currentChain,
  hasChain,
  disabled,
}: {
  templates: (ProxyChainTemplate & { hops?: Proxy[]; issues?: ChainIssue[] })[]
  loading: boolean
  onApply: (t: ProxyChainTemplate) => void
  onSaveCurrent: () => void
  currentChain: string
  hasChain: boolean
  disabled?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [saveOpen, setSaveOpen] = React.useState(false)
  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" disabled={disabled}>
            <Sparkles className="h-3.5 w-3.5" />
            模板
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="end">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-sm font-semibold">代理链模板</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false)
                setSaveOpen(true)
              }}
              disabled={!hasChain}
            >
              <Save className="h-3.5 w-3.5" />
              保存当前
            </Button>
          </div>
          <ScrollArea className="max-h-72">
            <div className="p-2">
              {loading ? (
                <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载中…
                </div>
              ) : templates.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                  尚未保存任何模板。
                </div>
              ) : (
                templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="w-full rounded-md px-2 py-2 text-left hover:bg-muted/60 focus:bg-muted/80 focus:outline-none"
                    onClick={() => {
                      onApply(t)
                      setOpen(false)
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium">{t.name}</span>
                      <Badge variant="secondary" className="font-normal">
                        {(t.hops?.length ?? 0)} 跳
                      </Badge>
                    </div>
                    {t.description && <p className="truncate text-xs text-muted-foreground">{t.description}</p>}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {(t.hops || []).map((p) => (
                        <Badge key={p.id} variant="outline" className={cn("text-[10px] font-normal", KIND_TONE[p.kind])}>
                          {p.name}
                        </Badge>
                      ))}
                    </div>
                  </button>
                ))
              )}
            </div>
          </ScrollArea>
        </PopoverContent>
      </Popover>
      <SaveTemplateDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        chain={currentChain}
        onSaved={onSaveCurrent}
      />
    </>
  )
}

function SaveTemplateDialog({
  open,
  onOpenChange,
  chain,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  chain: string
  onSaved: () => void
}) {
  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [tags, setTags] = React.useState("")
  const save = useMutation({
    mutationFn: () =>
      chainTemplateService.create({
        name: name.trim(),
        description: description.trim() || undefined,
        chain,
        tags: tags.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success("模板已保存")
      onSaved()
      onOpenChange(false)
      setName("")
      setDescription("")
      setTags("")
    },
    onError: (e: Error) => toast.error("保存失败", { description: e.message }),
  })
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Save className="h-4 w-4" /> 保存为代理链模板
          </AlertDialogTitle>
          <AlertDialogDescription>
            将当前链 <span className="font-mono">{chain || "(空)"}</span> 持久化为模板,后续可在任意节点上一键应用。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="tpl-name">名称</Label>
            <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="如:亚太-生产-跳板链" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-desc">描述</Label>
            <Textarea
              id="tpl-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="说明使用场景或合规边界(可选)"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="tpl-tags">标签</Label>
            <Input id="tpl-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="逗号分隔(可选)" />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>取消</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault()
              save.mutate()
            }}
            disabled={!name.trim() || save.isPending}
          >
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            保存
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function IssueIcon({ severity }: { severity: ChainIssue["severity"] }) {
  if (severity === "error") return <AlertCircle className="h-3.5 w-3.5 shrink-0" />
  if (severity === "warning") return <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
  return <Info className="h-3.5 w-3.5 shrink-0" />
}

// Public helper exported so callers (NodeInfoTab, list rows) can also render a
// compact, read-only summary of a chain string.
export function ProxyChainSummary({
  chain,
  proxies,
  className,
}: {
  chain: string
  proxies: Proxy[]
  className?: string
}) {
  const ids = parseChainIds(chain)
  if (ids.length === 0)
    return (
      <Badge variant="outline" className={cn("font-normal text-muted-foreground", className)}>
        <CircleSlash className="mr-1 h-3 w-3" /> 直连
      </Badge>
    )
  const byId = new Map(proxies.map((p) => [p.id, p]))
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {ids.map((id, i) => {
        const p = byId.get(id)
        return (
          <React.Fragment key={`${id}-${i}`}>
            {i > 0 && <span className="text-muted-foreground">→</span>}
            {p ? (
              <Badge variant="outline" className={cn("font-normal", KIND_TONE[p.kind])}>
                <Server className="mr-1 h-3 w-3" />
                {p.name}
              </Badge>
            ) : (
              <Badge variant="outline" className="border-destructive/30 bg-destructive/10 font-normal text-destructive">
                #{id} 缺失
              </Badge>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}

function parseChainIds(s: string): number[] {
  if (!s) return []
  const out: number[] = []
  for (const raw of s.split(",")) {
    const v = raw.trim()
    if (!v) continue
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) out.push(n)
  }
  return out
}

// Pencil import kept for future inline-rename of templates; currently unused.
void Pencil
void RefreshCw
void Plus
