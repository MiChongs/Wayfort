"use client"

import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Check, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { groupService, nodeService, tagService, credentialService, userService } from "@/lib/api/services"
import type { AccessRuleScope } from "@/lib/api/types"

type Option = { id: number; label: string; hint?: string }

// EntityMultiSelect — a Popover + checkbox-list multi picker. Self-contained so it
// stays consistent with the design system (no raw ID inputs).
function EntityMultiSelect({
  placeholder,
  options,
  value,
  onChange,
  loading,
}: {
  placeholder: string
  options: Option[]
  value: number[]
  onChange: (v: number[]) => void
  loading?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [q, setQ] = React.useState("")
  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return options
    return options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(s))
  }, [options, q])

  const toggle = (id: number) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="h-9 w-full justify-between font-normal">
          <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
            {value.length === 0 ? placeholder : `已选 ${value.length} 项`}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
        <div className="border-b p-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索…" className="h-8" />
        </div>
        <ScrollArea className="max-h-56">
          <div className="p-1">
            {loading ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">加载中…</div>
            ) : filtered.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">无匹配项</div>
            ) : (
              filtered.map((o) => {
                const checked = value.includes(o.id)
                return (
                  <button
                    type="button"
                    key={o.id}
                    onClick={() => toggle(o.id)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <Checkbox checked={checked} className="pointer-events-none" />
                    <span className="min-w-0 flex-1 truncate">{o.label}</span>
                    {o.hint && <span className="truncate text-xs text-muted-foreground">{o.hint}</span>}
                    {checked && <Check className="h-3.5 w-3.5 text-primary" />}
                  </button>
                )
              })
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}

// chip row of selected labels (so the admin sees what's chosen without opening).
function SelectedChips({ ids, options }: { ids: number[]; options: Option[] }) {
  if (ids.length === 0) return null
  const byId = new Map(options.map((o) => [o.id, o.label]))
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <Badge key={id} variant="soft" className="rounded-full font-normal">
          {byId.get(id) ?? `#${id}`}
        </Badge>
      ))}
    </div>
  )
}

const DIM_TITLE: Record<ScopeDimension, string> = {
  users: "用户",
  assets: "资产",
  accounts: "账号(凭据)",
}

export type ScopeDimension = "users" | "assets" | "accounts"

// ScopeField renders one dimension as 所有 / 指定 with multi-selects for the
// relevant entity types. Empty/all ⇒ {all:true}.
export function ScopeField({
  dimension,
  value,
  onChange,
}: {
  dimension: ScopeDimension
  value: AccessRuleScope
  onChange: (v: AccessRuleScope) => void
}) {
  const isAll = value.all !== false
  const setAll = (all: boolean) => onChange(all ? { all: true } : { all: false })
  const patch = (p: Partial<AccessRuleScope>) => onChange({ ...value, all: false, ...p })

  // Entity lists — fetched only when this dimension is in "指定" mode.
  const enabled = !isAll
  const groups = useQuery({ queryKey: ["groups"], queryFn: groupService.list, enabled: enabled && dimension === "users" })
  const users = useQuery({ queryKey: ["users", "scope"], queryFn: () => userService.list({ limit: 500 }), enabled: enabled && dimension === "users" })
  const nodes = useQuery({ queryKey: ["nodes"], queryFn: nodeService.list, enabled: enabled && dimension === "assets" })
  const tags = useQuery({ queryKey: ["tags"], queryFn: tagService.list, enabled: enabled && dimension === "assets" })
  const creds = useQuery({ queryKey: ["credentials"], queryFn: credentialService.list, enabled: enabled && dimension === "accounts" })

  const userOpts: Option[] = (users.data?.users ?? []).map((u) => ({ id: u.id, label: u.display_name || u.username, hint: u.username }))
  const groupOpts: Option[] = (groups.data?.groups ?? []).map((g) => ({ id: g.id, label: g.name }))
  const nodeOpts: Option[] = (nodes.data?.nodes ?? []).map((n) => ({ id: n.id, label: n.name, hint: n.host }))
  const tagOpts: Option[] = (tags.data?.tags ?? []).map((t) => ({ id: t.id, label: t.name }))
  const credOpts: Option[] = (creds.data?.credentials ?? []).map((c) => ({ id: c.id, label: c.name }))

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{DIM_TITLE[dimension]}</span>
        <div className="inline-flex rounded-md border p-0.5">
          {[
            { v: true, t: "所有" },
            { v: false, t: "指定" },
          ].map((o) => (
            <button
              key={o.t}
              type="button"
              onClick={() => setAll(o.v)}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-medium transition-colors",
                isAll === o.v ? "bg-primary/12 text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.t}
            </button>
          ))}
        </div>
      </div>

      {!isAll && (
        <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
          {dimension === "users" && (
            <>
              <EntityMultiSelect placeholder="选择用户…" options={userOpts} loading={users.isLoading} value={value.user_ids ?? []} onChange={(v) => patch({ user_ids: v })} />
              <SelectedChips ids={value.user_ids ?? []} options={userOpts} />
              <EntityMultiSelect placeholder="选择用户组…" options={groupOpts} loading={groups.isLoading} value={value.group_ids ?? []} onChange={(v) => patch({ group_ids: v })} />
              <SelectedChips ids={value.group_ids ?? []} options={groupOpts} />
            </>
          )}
          {dimension === "assets" && (
            <>
              <EntityMultiSelect placeholder="选择节点…" options={nodeOpts} loading={nodes.isLoading} value={value.node_ids ?? []} onChange={(v) => patch({ node_ids: v })} />
              <SelectedChips ids={value.node_ids ?? []} options={nodeOpts} />
              <EntityMultiSelect placeholder="选择标签…" options={tagOpts} loading={tags.isLoading} value={value.tag_ids ?? []} onChange={(v) => patch({ tag_ids: v })} />
              <SelectedChips ids={value.tag_ids ?? []} options={tagOpts} />
            </>
          )}
          {dimension === "accounts" && (
            <>
              <EntityMultiSelect placeholder="选择凭据…" options={credOpts} loading={creds.isLoading} value={value.credential_ids ?? []} onChange={(v) => patch({ credential_ids: v })} />
              <SelectedChips ids={value.credential_ids ?? []} options={credOpts} />
            </>
          )}
          <p className="text-xs text-muted-foreground">未选择任何项时该维度不匹配；切回「所有」表示不限制。</p>
        </div>
      )}
    </div>
  )
}
