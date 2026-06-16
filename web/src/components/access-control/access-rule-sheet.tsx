"use client"

import * as React from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Spinner } from "@/components/ui/spinner"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "@/components/ui/sonner"
import { accessRuleService } from "@/lib/api/services"
import { cn } from "@/lib/utils"
import type { AccessRule, AccessRuleAction, AccessRuleKind, AccessRuleScope, AccessRuleTimeWindow } from "@/lib/api/types"
import { ScopeField } from "./scope-field"
import { ACTIONS_BY_KIND, KIND_META, defaultActionFor } from "./meta"

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"]

const PROTOCOLS: { v: string; t: string }[] = [
  { v: "ssh", t: "SSH" },
  { v: "telnet", t: "Telnet" },
  { v: "rdp", t: "RDP" },
  { v: "vnc", t: "VNC" },
  { v: "database", t: "数据库" },
  { v: "sftp", t: "SFTP" },
]

function parseJSON(s?: string): Record<string, unknown> {
  if (!s || !s.trim()) return {}
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return {}
  }
}
function parseScope(s?: string): AccessRuleScope {
  if (!s || !s.trim()) return { all: true }
  try {
    return JSON.parse(s) as AccessRuleScope
  } catch {
    return { all: true }
  }
}
function serializeScope(s: AccessRuleScope): string {
  if (s.all !== false) return ""
  return JSON.stringify(s)
}
function parseTW(s?: string): AccessRuleTimeWindow {
  if (!s || !s.trim()) return {}
  try {
    return JSON.parse(s) as AccessRuleTimeWindow
  } catch {
    return {}
  }
}
function serializeTW(w: AccessRuleTimeWindow): string {
  if ((!w.weekdays || w.weekdays.length === 0) && !w.start && !w.end) return ""
  return JSON.stringify(w)
}

// Section is a labelled form group with optional helper copy — the backbone of
// the guided, "humane" layout.
function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  )
}

export function AccessRuleSheet({
  kind,
  rule,
  open,
  onOpenChange,
  onSaved,
}: {
  kind: AccessRuleKind
  rule?: AccessRule | null
  open: boolean
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const qc = useQueryClient()
  const editing = !!rule
  const meta = KIND_META[kind]
  const Icon = meta.icon
  const actions = ACTIONS_BY_KIND[kind]

  const [name, setName] = React.useState("")
  const [description, setDescription] = React.useState("")
  const [priority, setPriority] = React.useState(50)
  const [active, setActive] = React.useState(true)
  const [action, setAction] = React.useState<AccessRuleAction>("review")
  const [users, setUsers] = React.useState<AccessRuleScope>({ all: true })
  const [assets, setAssets] = React.useState<AccessRuleScope>({ all: true })
  const [accounts, setAccounts] = React.useState<AccessRuleScope>({ all: true })
  const [ipRule, setIpRule] = React.useState("")
  const [tw, setTw] = React.useState<AccessRuleTimeWindow>({})
  // kind-specific Spec
  const [cmdType, setCmdType] = React.useState<"command" | "regex">("command")
  const [cmdContent, setCmdContent] = React.useState("")
  const [cmdIgnoreCase, setCmdIgnoreCase] = React.useState(true)
  const [maskColumns, setMaskColumns] = React.useState("")
  const [maskMethod, setMaskMethod] = React.useState<"partial" | "hash" | "fixed">("partial")
  const [methods, setMethods] = React.useState<string[]>([])
  const [requireMfa, setRequireMfa] = React.useState(false)

  // Reset form whenever the sheet opens (new vs edit).
  React.useEffect(() => {
    if (!open) return
    setName(rule?.name ?? "")
    setDescription(rule?.description ?? "")
    setPriority(rule?.priority ?? 50)
    setActive(rule?.active ?? true)
    setAction(rule?.action ?? defaultActionFor(kind))
    setUsers(parseScope(rule?.users))
    setAssets(parseScope(rule?.assets))
    setAccounts(parseScope(rule?.accounts))
    setIpRule(rule?.ip_rule ?? "")
    setTw(parseTW(rule?.time_window))
    const spec = parseJSON(rule?.spec)
    const groups = (spec.command_groups as { type?: string; content?: string; ignore_case?: boolean }[]) ?? []
    const g = groups[0] ?? {}
    setCmdType(g.type === "regex" ? "regex" : "command")
    setCmdContent(g.content ?? "")
    setCmdIgnoreCase(g.ignore_case ?? true)
    setMaskColumns(((spec.columns as string[]) ?? []).join("\n"))
    setMaskMethod((spec.method as "partial" | "hash" | "fixed") ?? "partial")
    setMethods((spec.methods as string[]) ?? [])
    setRequireMfa((spec.require_mfa as boolean) ?? false)
  }, [open, rule, kind])

  const buildSpec = (): string => {
    switch (kind) {
      case "command_filter":
        if (!cmdContent.trim()) return ""
        return JSON.stringify({ command_groups: [{ type: cmdType, content: cmdContent, ignore_case: cmdIgnoreCase }] })
      case "data_masking": {
        const cols = maskColumns
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean)
        return JSON.stringify({ columns: cols, method: maskMethod })
      }
      case "connection_method":
        return JSON.stringify({ methods })
      case "user_login":
        return requireMfa ? JSON.stringify({ require_mfa: true }) : ""
      default:
        return ""
    }
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        kind,
        name: name.trim(),
        description: description.trim(),
        priority,
        active,
        // data_masking has no action selector — a matched rule simply masks.
        action: actions.length === 0 ? "accept" : action,
        users: serializeScope(users),
        assets: serializeScope(assets),
        accounts: serializeScope(accounts),
        ip_rule: ipRule.trim(),
        time_window: serializeTW(tw),
        spec: buildSpec(),
      }
      return editing ? accessRuleService.update(rule!.id, body) : accessRuleService.create(body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["access-rules", kind] })
      toast.success(editing ? "规则已更新" : "规则已创建")
      onSaved()
      onOpenChange(false)
    },
    onError: (e: unknown) => toast.error("保存失败", { description: e instanceof Error ? e.message : String(e) }),
  })

  const toggleWeekday = (d: number) => {
    const cur = tw.weekdays ?? []
    setTw({ ...tw, weekdays: cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort() })
  }

  const actionHint = actions.find((a) => a.value === action)?.hint

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        {/* Header — kind-aware, with room cleared for the close button */}
        <SheetHeader className="gap-0 space-y-0 border-b px-6 py-5 pr-14">
          <div className="flex items-start gap-3.5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 space-y-1">
              <SheetTitle className="text-base leading-tight">
                {editing ? "编辑" : "新建"}
                {meta.title}规则
              </SheetTitle>
              <SheetDescription className="text-sm leading-snug">{meta.sheetHint}</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* 基本信息 */}
          <Section title="基本信息">
            <div className="space-y-2">
              <Label htmlFor="rule-name">
                规则名称 <span className="text-destructive">*</span>
              </Label>
              <Input id="rule-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`例如：${meta.title}-生产环境`} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="rule-desc">描述</Label>
              <Input id="rule-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="选填，便于团队理解这条规则的用途" />
            </div>
            <div className={cn("grid gap-4", actions.length > 0 ? "grid-cols-2" : "grid-cols-1")}>
              <div className="space-y-2">
                <Label htmlFor="rule-priority">优先级</Label>
                <Input
                  id="rule-priority"
                  type="number"
                  min={1}
                  max={100}
                  value={priority}
                  onChange={(e) => setPriority(Math.max(1, Math.min(100, Number(e.target.value) || 50)))}
                />
                <p className="text-xs text-muted-foreground">1~100，数值越小越先匹配</p>
              </div>
              {actions.length > 0 && (
                <div className="space-y-2">
                  <Label htmlFor="rule-action">命中后动作</Label>
                  <Select value={action} onValueChange={(v) => setAction(v as AccessRuleAction)}>
                    <SelectTrigger id="rule-action">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {actions.map((a) => (
                        <SelectItem key={a.value} value={a.value}>
                          {a.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {actionHint && <p className="text-xs text-muted-foreground">{actionHint}</p>}
                </div>
              )}
            </div>
          </Section>

          {/* 适用对象 */}
          <Section title="适用对象" hint="规则匹配下列维度的交集；保留「所有」即不限制该维度。">
            <div className="space-y-3 rounded-xl border bg-card p-4">
              <ScopeField dimension="users" value={users} onChange={setUsers} />
              <ScopeField dimension="assets" value={assets} onChange={setAssets} />
              <ScopeField dimension="accounts" value={accounts} onChange={setAccounts} />
            </div>
          </Section>

          {/* 规则配置 — kind-specific */}
          {kind === "command_filter" && (
            <Section title="命令组" hint="留空则匹配所有命令。input-side 拦截为威慑 + 审计，并非硬性沙箱。">
              <div className="space-y-3 rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted-foreground">匹配方式</span>
                  <Select value={cmdType} onValueChange={(v) => setCmdType(v as "command" | "regex")}>
                    <SelectTrigger className="h-8 w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="command">命令(子串)</SelectItem>
                      <SelectItem value="regex">正则表达式</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Textarea
                  value={cmdContent}
                  onChange={(e) => setCmdContent(e.target.value)}
                  placeholder={cmdType === "regex" ? "每行一个正则，如 ^rm\\s+-rf" : "每行一个命令，如 rm -rf /"}
                  className="min-h-24 font-mono text-xs"
                />
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">忽略大小写</span>
                  <Switch checked={cmdIgnoreCase} onCheckedChange={setCmdIgnoreCase} />
                </div>
              </div>
            </Section>
          )}
          {kind === "data_masking" && (
            <Section title="脱敏设置" hint="命中规则的查询结果中，名称匹配的列将被遮盖。">
              <div className="space-y-3 rounded-xl border bg-card p-4">
                <div className="space-y-2">
                  <Label htmlFor="mask-cols">脱敏列</Label>
                  <Textarea
                    id="mask-cols"
                    value={maskColumns}
                    onChange={(e) => setMaskColumns(e.target.value)}
                    placeholder="每行 / 逗号一个列名，支持通配符：password, *secret, pwd*"
                    className="min-h-20 font-mono text-xs"
                  />
                </div>
                <div className="space-y-2">
                  <Label>遮盖方法</Label>
                  <Select value={maskMethod} onValueChange={(v) => setMaskMethod(v as "partial" | "hash" | "fixed")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="partial">部分遮盖(保留首尾)</SelectItem>
                      <SelectItem value="fixed">固定遮盖(******)</SelectItem>
                      <SelectItem value="hash">哈希</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </Section>
          )}
          {kind === "connection_method" && (
            <Section title="连接方式" hint="选中的连接方式适用本规则(动作设为「禁止」即拦截)。不选 = 所有方式。">
              <div className="flex flex-wrap gap-1.5 rounded-xl border bg-card p-4">
                {PROTOCOLS.map((p) => {
                  const on = methods.includes(p.v)
                  return (
                    <button
                      key={p.v}
                      type="button"
                      onClick={() => setMethods(on ? methods.filter((x) => x !== p.v) : [...methods, p.v])}
                      className={cn(
                        "rounded-md border px-3 py-1.5 text-sm transition-colors",
                        on ? "border-primary/30 bg-primary/12 text-primary" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {p.t}
                    </button>
                  )
                })}
              </div>
            </Section>
          )}
          {kind === "user_login" && (
            <Section title="登录强化">
              <div className="flex items-center justify-between rounded-xl border bg-card p-4">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">强制二次验证(MFA)</div>
                  <div className="text-xs text-muted-foreground">命中该规则的登录强制走 MFA 步骤。</div>
                </div>
                <Switch checked={requireMfa} onCheckedChange={setRequireMfa} />
              </div>
            </Section>
          )}

          {/* 生效条件 */}
          <Section title="生效条件" hint="可选。不设置则任意来源、任意时间都生效。">
            <div className="space-y-4 rounded-xl border bg-card p-4">
              <div className="space-y-2">
                <Label htmlFor="rule-ip">来源 IP</Label>
                <Input
                  id="rule-ip"
                  value={ipRule}
                  onChange={(e) => setIpRule(e.target.value)}
                  placeholder="留空 = 不限。如 10.0.0.0/8, 192.168.1.5, 10.1.1.1-10.1.1.20"
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-2">
                <Label>生效时段</Label>
                <div className="flex flex-wrap gap-1">
                  {WEEKDAYS.map((w, i) => {
                    const on = (tw.weekdays ?? []).includes(i)
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => toggleWeekday(i)}
                        className={cn(
                          "h-8 w-8 rounded-md border text-sm transition-colors",
                          on ? "border-primary/30 bg-primary/12 text-primary" : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {w}
                      </button>
                    )
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <Input type="time" value={tw.start ?? ""} onChange={(e) => setTw({ ...tw, start: e.target.value })} className="w-32" />
                  <span className="text-sm text-muted-foreground">至</span>
                  <Input type="time" value={tw.end ?? ""} onChange={(e) => setTw({ ...tw, end: e.target.value })} className="w-32" />
                </div>
                <p className="text-xs text-muted-foreground">不选星期 = 每天；不填时间 = 全天。</p>
              </div>
            </div>
          </Section>

          {/* 状态 */}
          <div className="flex items-center justify-between rounded-xl border bg-card p-4">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">启用规则</div>
              <div className="text-xs text-muted-foreground">关闭后该规则不参与匹配。</div>
            </div>
            <Switch checked={active} onCheckedChange={setActive} />
          </div>
        </div>

        <SheetFooter className="mt-0 flex-row justify-end gap-2 border-t px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending} className="gap-1.5">
            {save.isPending && <Spinner className="h-4 w-4" />}
            {editing ? "保存修改" : "创建规则"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
