"use client"

// 授权向导（可复用、可内嵌）。访问策略中心、节点详情、用户详情都用它：
//   · 不传 fixed*：完整向导（选谁 × 选资产 × 权限 × 有效期）。
//   · 传 fixedSubject：锁定客体（从某资产进入，给它授权给若干人）。
//   · 传 fixedGrantee：锁定主体（从某人进入，给他开若干资产）。

import * as React from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Plus, Search } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TreeList } from "@/components/common/tree-list"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import {
  assetGroupService, departmentService, grantService, groupService, nodeService, roleService, tagService, userService,
} from "@/lib/api/services"
import type { GranteeKind, SubjectKind } from "@/lib/api/types"
import { ALL_ACTIONS, PRESETS, actionLabel, summarizeActions } from "@/lib/access/permissions"

export interface PickerEntity {
  id: number
  name: string
  sub?: string
  /** Parent id for hierarchical categories (用户组 / 部门 / 资产组). */
  parentId?: number | null
}
export interface PickerCat {
  key: string
  label: string
  items: PickerEntity[]
  /** Render this category as a real tree (parentId-driven) instead of a flat list. */
  tree?: boolean
}

// useGrantDirectories 复用与访问策略页相同的 query key，react-query 自动去重，
// 内嵌使用不会重复请求。
export function useGrantDirectories() {
  const users = useQuery({ queryKey: ["admin", "users", "all"], queryFn: () => userService.list({ limit: 1000 }) })
  const roles = useQuery({ queryKey: ["admin", "roles"], queryFn: roleService.list })
  const groups = useQuery({ queryKey: ["admin", "groups"], queryFn: groupService.list })
  const depts = useQuery({ queryKey: ["admin", "depts"], queryFn: departmentService.list })
  const nodes = useQuery({ queryKey: ["admin", "nodes"], queryFn: nodeService.list })
  const assetGroups = useQuery({ queryKey: ["admin", "asset-groups"], queryFn: assetGroupService.list })
  const tags = useQuery({ queryKey: ["admin", "tags"], queryFn: tagService.list })

  const granteeCats = React.useMemo<PickerCat[]>(
    () => [
      { key: "user", label: "用户", items: (users.data?.users || []).map((u) => ({ id: u.id, name: u.username })) },
      { key: "role", label: "角色", items: (roles.data?.roles || []).map((r) => ({ id: r.id, name: r.name })) },
      {
        key: "group",
        label: "用户组",
        tree: true,
        items: (groups.data?.groups || []).map((g) => ({ id: g.id, name: g.name, parentId: g.parent_id ?? null })),
      },
      {
        key: "department",
        label: "部门",
        tree: true,
        items: (depts.data?.departments || []).map((d) => ({ id: d.id, name: d.name, parentId: d.parent_id ?? null })),
      },
    ],
    [users.data, roles.data, groups.data, depts.data],
  )
  const subjectCats = React.useMemo<PickerCat[]>(
    () => [
      { key: "node", label: "节点", items: (nodes.data?.nodes || []).map((n) => ({ id: n.id, name: n.name, sub: `${n.host}:${n.port}` })) },
      {
        key: "group",
        label: "资产组",
        tree: true,
        items: (assetGroups.data?.asset_groups || []).map((g) => ({ id: g.id, name: g.name, parentId: g.parent_id ?? null })),
      },
      { key: "tag", label: "标签", items: (tags.data?.tags || []).map((t) => ({ id: t.id, name: t.name })) },
    ],
    [nodes.data, assetGroups.data, tags.data],
  )
  return { granteeCats, subjectCats }
}

export function parseRef(key: string): { type: string; id: number } {
  const [type, id] = key.split(":")
  return { type, id: Number(id) }
}

interface Fixed {
  type: string
  id: number
  name?: string
}

export interface GrantWizardProps {
  trigger?: React.ReactNode
  onDone?: () => void
  /** 锁定客体（从资产进入）：例如 {type:"node", id, name}。 */
  fixedSubject?: Fixed
  /** 锁定多个客体（从资产树多选进入批量授权）。优先于 fixedSubject。 */
  fixedSubjects?: Fixed[]
  /** 锁定主体（从人进入）：例如 {type:"user", id, name}。 */
  fixedGrantee?: Fixed
  /** 受控开关（如从右键菜单程序化打开）。不传则内部用 trigger 管理。 */
  open?: boolean
  onOpenChange?: (v: boolean) => void
}

export function GrantWizard({
  trigger,
  onDone,
  fixedSubject,
  fixedSubjects,
  fixedGrantee,
  open: controlledOpen,
  onOpenChange,
}: GrantWizardProps) {
  const { granteeCats, subjectCats } = useGrantDirectories()
  const isControlled = controlledOpen !== undefined
  const [internalOpen, setInternalOpen] = React.useState(false)
  const open = isControlled ? controlledOpen! : internalOpen
  const setOpen = (v: boolean) => (isControlled ? onOpenChange?.(v) : setInternalOpen(v))
  const [subjectAll, setSubjectAll] = React.useState(false)
  const [subjectSel, setSubjectSel] = React.useState<Set<string>>(new Set())
  const [granteeSel, setGranteeSel] = React.useState<Set<string>>(new Set())
  const [presetKey, setPresetKey] = React.useState("readonly")
  const [customActions, setCustomActions] = React.useState<string[]>(["connect"])
  const [validMode, setValidMode] = React.useState<"forever" | "until">("forever")
  const [validTo, setValidTo] = React.useState("")

  React.useEffect(() => {
    if (open) {
      setSubjectAll(false); setSubjectSel(new Set()); setGranteeSel(new Set())
      setPresetKey("readonly"); setCustomActions(["connect"]); setValidMode("forever"); setValidTo("")
    }
  }, [open])

  const actions = presetKey === "custom" ? customActions : PRESETS.find((p) => p.key === presetKey)?.actions ?? []
  const presetLabel = presetKey === "custom" ? "自定义" : PRESETS.find((p) => p.key === presetKey)?.label ?? ""

  const hasFixedSubjects = !!fixedSubjects && fixedSubjects.length > 0
  const grantees = fixedGrantee
    ? [{ type: fixedGrantee.type, id: fixedGrantee.id }]
    : [...granteeSel].map(parseRef)
  const subjects = hasFixedSubjects
    ? fixedSubjects!.map((s) => ({ type: s.type, id: s.id }))
    : fixedSubject
      ? [{ type: fixedSubject.type, id: fixedSubject.id }]
      : subjectAll
        ? [{ type: "all", id: 0 }]
        : [...subjectSel].map(parseRef)

  const canSubmit = grantees.length > 0 && subjects.length > 0 && actions.length > 0 && (validMode === "forever" || !!validTo)

  const submit = useMutation({
    mutationFn: () =>
      grantService.createBatch({
        grantees: grantees as { type: GranteeKind; id: number }[],
        subjects: subjects as { type: SubjectKind; id: number }[],
        actions: actions.join(","),
        valid_to: validMode === "until" && validTo ? validTo : undefined,
      }),
    onSuccess: (r) => {
      toast.success("授权已创建", { description: `新增 ${r.created} 条` })
      onDone?.(); setOpen(false)
    },
    onError: (e: Error) => toast.error("创建失败", { description: e.message }),
  })

  let stepNo = 0
  const next = () => ++stepNo

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {!isControlled && (
        <SheetTrigger asChild>{trigger ?? <Button><Plus className="h-4 w-4" /> 新建授权</Button>}</SheetTrigger>
      )}
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl lg:max-w-3xl">
        <SheetHeader className="border-b px-6 py-4">
          <SheetTitle className="text-lg">新建授权</SheetTitle>
          <SheetDescription>
            {fixedGrantee
              ? `把资产分配给「${fixedGrantee.name}」`
              : fixedSubject
                ? `把「${fixedSubject.name}」分配给用户 / 部门 / 角色`
                : hasFixedSubjects
                  ? `把所选 ${fixedSubjects!.length} 个资产分配给用户 / 部门 / 角色`
                  : "选择对象 × 资产 × 权限套餐 × 有效期，一次批量授权。"}
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-6 px-6 py-5">
            {!fixedGrantee && (
              <Section step={next()} title="给谁">
                <MultiPicker cats={granteeCats} selected={granteeSel} onChange={setGranteeSel} />
              </Section>
            )}
            {!fixedSubject && !hasFixedSubjects && (
              <Section step={next()} title="可访问哪些资产">
                <label className="mb-2 flex w-fit cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                  <Checkbox checked={subjectAll} onCheckedChange={(v) => setSubjectAll(!!v)} />
                  <span className="font-medium text-warning">全部资产</span>
                  <span className="text-xs text-muted-foreground">（慎用，等于放开所有节点）</span>
                </label>
                {!subjectAll && <MultiPicker cats={subjectCats} selected={subjectSel} onChange={setSubjectSel} />}
              </Section>
            )}

            <Section step={next()} title="授予什么权限">
              <RadioGroup value={presetKey} onValueChange={setPresetKey} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PRESETS.map((p) => (
                  <label key={p.key} className={cn("cursor-pointer rounded-lg border p-2.5 text-sm transition-colors", presetKey === p.key ? "border-primary bg-primary/5" : "hover:bg-accent")}>
                    <div className="flex items-center gap-2"><RadioGroupItem value={p.key} /><span className="font-medium">{p.label}</span></div>
                    <p className="mt-1 pl-6 text-xs text-muted-foreground">{p.desc}</p>
                  </label>
                ))}
                <label className={cn("cursor-pointer rounded-lg border p-2.5 text-sm transition-colors", presetKey === "custom" ? "border-primary bg-primary/5" : "hover:bg-accent")}>
                  <div className="flex items-center gap-2"><RadioGroupItem value="custom" /><span className="font-medium">自定义</span></div>
                  <p className="mt-1 pl-6 text-xs text-muted-foreground">自己勾选动作</p>
                </label>
              </RadioGroup>
              {presetKey === "custom" && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {ALL_ACTIONS.map((a) => {
                    const on = customActions.includes(a)
                    return (
                      <button key={a} type="button"
                        onClick={() => setCustomActions(on ? customActions.filter((x) => x !== a) : [...customActions, a])}
                        className={cn("rounded-md border px-2.5 py-1 text-xs", on ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent")}>
                        {actionLabel(a)}
                      </button>
                    )
                  })}
                </div>
              )}
            </Section>

            <Section step={next()} title="有效期">
              <div className="flex flex-wrap items-center gap-3">
                <RadioGroup value={validMode} onValueChange={(v) => setValidMode(v as "forever" | "until")} className="flex gap-4">
                  <label className="flex cursor-pointer items-center gap-2 text-sm"><RadioGroupItem value="forever" /> 永久</label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm"><RadioGroupItem value="until" /> 临时到</label>
                </RadioGroup>
                {validMode === "until" && (
                  <Input type="datetime-local" value={validTo} onChange={(e) => setValidTo(e.target.value)} className="w-56" />
                )}
              </div>
            </Section>
          </div>
        </ScrollArea>

        <SheetFooter className="flex-row items-center justify-between gap-2 border-t bg-muted/30 px-6 py-4">
          <div className="min-w-0 flex-1 text-sm text-muted-foreground">
            {canSubmit ? (
              <span className="line-clamp-2">
                给 <strong className="text-foreground">{fixedGrantee ? fixedGrantee.name : `${grantees.length} 个对象`}</strong> ×{" "}
                <strong className="text-foreground">{fixedSubject ? fixedSubject.name : hasFixedSubjects ? `${subjects.length} 个资产` : subjectAll ? "全部资产" : `${subjects.length} 个资产`}</strong> 授【
                <strong className="text-foreground">{presetLabel}</strong>】
                {validMode === "until" && validTo ? `，到期 ${validTo.replace("T", " ")}` : ""}
                <span className="ml-1 text-xs">= {summarizeActions(actions)}</span>
              </span>
            ) : (
              <span>选择对象、资产与权限后可创建</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" onClick={() => setOpen(false)} disabled={submit.isPending}>取消</Button>
            <Button disabled={!canSubmit || submit.isPending} onClick={() => submit.mutate()}>确认授权</Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function Section({ step, title, children }: { step: number; title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">{step}</span>
        <Label className="text-sm font-medium">{title}</Label>
      </div>
      {children}
    </div>
  )
}

type PickerTreeNode = PickerEntity & { children: PickerTreeNode[] }

// Build a parentId-driven forest from a flat entity list (orphans → roots).
function buildPickerForest(items: PickerEntity[]): PickerTreeNode[] {
  const byId = new Map<number, PickerTreeNode>(items.map((i) => [i.id, { ...i, children: [] }]))
  const roots: PickerTreeNode[] = []
  for (const node of byId.values()) {
    const parent = node.parentId != null ? byId.get(node.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sortRec = (arr: PickerTreeNode[]) => {
    arr.sort((a, b) => a.name.localeCompare(b.name))
    arr.forEach((n) => sortRec(n.children))
  }
  sortRec(roots)
  return roots
}

// Search keeps matches AND their ancestors so the tree path stays visible.
function filterPickerItems(items: PickerEntity[], q: string): PickerEntity[] {
  const k = q.trim().toLowerCase()
  if (!k) return items
  const byId = new Map(items.map((i) => [i.id, i]))
  const keep = new Set<number>()
  for (const i of items) {
    if ((i.name + (i.sub ?? "")).toLowerCase().includes(k)) {
      keep.add(i.id)
      let cur: PickerEntity | undefined = i
      while (cur && cur.parentId != null && byId.has(cur.parentId)) {
        keep.add(cur.parentId)
        cur = byId.get(cur.parentId)
      }
    }
  }
  return items.filter((i) => keep.has(i.id))
}

export function MultiPicker({
  cats, selected, onChange,
}: {
  cats: PickerCat[]
  selected: Set<string>
  onChange: (next: Set<string>) => void
}) {
  const [tab, setTab] = React.useState(cats[0]?.key ?? "")
  const [q, setQ] = React.useState("")
  React.useEffect(() => { if (cats.length && !cats.some((c) => c.key === tab)) setTab(cats[0].key) }, [cats, tab])

  const toggle = (key: string) => {
    const next = new Set(selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }
  const cat = cats.find((c) => c.key === tab)
  const items = filterPickerItems(cat?.items || [], q)
  const forest = React.useMemo(() => (cat?.tree ? buildPickerForest(items) : []), [cat?.tree, items])
  const expandIds = React.useMemo(() => (cat?.tree ? items.map((i) => String(i.id)) : []), [cat?.tree, items])

  return (
    <div className="rounded-lg border">
      <div className="flex items-center gap-2 border-b p-2">
        <div className="flex gap-1">
          {cats.map((c) => (
            <button key={c.key} type="button" onClick={() => setTab(c.key)}
              className={cn("rounded-md px-2.5 py-1 text-xs font-medium", tab === c.key ? "bg-primary text-primary-foreground" : "hover:bg-accent")}>
              {c.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto max-w-[220px] flex-1">
          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" className="h-8 pl-7 text-sm" />
        </div>
      </div>
      <ScrollArea className="h-64">
        <div className="p-1.5">
          {items.length === 0 ? (
            <div className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配项</div>
          ) : cat?.tree ? (
            // Hierarchical categories (用户组 / 部门 / 资产组) render as a real tree.
            <TreeList<PickerTreeNode>
              key={`${cat.key}:${q}`}
              nodes={forest}
              getId={(n) => String(n.id)}
              getChildren={(n) => (n.children.length ? n.children : undefined)}
              defaultExpandedIds={expandIds}
              indent={16}
              renderRow={(n) => {
                const key = `${cat.key}:${n.id}`
                return (
                  <label className="flex cursor-pointer items-center gap-2 py-1 pr-1 text-sm" onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selected.has(key)} onCheckedChange={() => toggle(key)} />
                    <span className="flex-1 truncate font-medium">{n.name}</span>
                  </label>
                )
              }}
            />
          ) : (
            items.map((i) => {
              const key = `${cat!.key}:${i.id}`
              return (
                <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                  <Checkbox checked={selected.has(key)} onCheckedChange={() => toggle(key)} />
                  <span className="flex-1 truncate">{i.name}</span>
                  {i.sub ? <span className="font-mono text-xs text-muted-foreground">{i.sub}</span> : null}
                </label>
              )
            })
          )}
        </div>
      </ScrollArea>
      {selected.size > 0 && (
        <div className="flex flex-wrap gap-1 border-t p-2">
          {[...selected].map((key) => {
            const { type, id } = parseRef(key)
            const item = cats.find((x) => x.key === type)?.items.find((x) => x.id === id)
            return (
              <Badge key={key} variant="secondary" className="cursor-pointer font-normal" onClick={() => toggle(key)}>
                {item?.name ?? key} ✕
              </Badge>
            )
          })}
        </div>
      )}
    </div>
  )
}
