"use client"

import * as React from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { motion, AnimatePresence } from "motion/react"
import {
  FolderPlus,
  Hash,
  Layers,
  Pencil,
  Plus,
  Search,
  Tag as TagIcon,
  Trash2,
} from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { EmptyState } from "@/components/common/empty-state"
import { confirmDialog } from "@/components/common/confirm-dialog"
import { TagBadge } from "@/components/tags/tag-badge"
import { ColorSwatchPicker } from "@/components/tags/color-emoji"
import { IconPicker } from "@/components/icons/icon-picker"
import { tagService, tagGroupService } from "@/lib/api/services"
import { resolveTagColor, type TagColorToken } from "@/lib/tags/palette"
import { cn } from "@/lib/utils"
import type { AssetTag, AssetTagGroup } from "@/lib/api/types"

type TagDraft = { id?: number; name: string; color: string; icon: string; description: string; group_id: number | null }
type GroupDraft = { id?: number; name: string; color: string; icon: string; sort_order: number }

export default function TagsPage() {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ["tags"], queryFn: tagService.list })
  const tags = React.useMemo(() => list.data?.tags ?? [], [list.data])
  const groups = React.useMemo(() => list.data?.groups ?? [], [list.data])

  const [q, setQ] = React.useState("")
  const [tagDraft, setTagDraft] = React.useState<TagDraft | null>(null)
  const [groupDraft, setGroupDraft] = React.useState<GroupDraft | null>(null)

  const refresh = React.useCallback(() => {
    qc.invalidateQueries({ queryKey: ["tags"] })
    qc.invalidateQueries({ queryKey: ["admin", "tags"] }) // grant wizard et al.
    qc.invalidateQueries({ queryKey: ["nodes"] })
    qc.invalidateQueries({ queryKey: ["node"] })
  }, [qc])

  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return tags
    return tags.filter(
      (t) =>
        t.name.toLowerCase().includes(s) ||
        (t.description || "").toLowerCase().includes(s),
    )
  }, [tags, q])

  const { byGroup, ungrouped } = React.useMemo(() => {
    const byGroup = new Map<number, AssetTag[]>()
    const ungrouped: AssetTag[] = []
    for (const t of filtered) {
      if (t.group_id) {
        const arr = byGroup.get(t.group_id) ?? []
        arr.push(t)
        byGroup.set(t.group_id, arr)
      } else ungrouped.push(t)
    }
    return { byGroup, ungrouped }
  }, [filtered])

  const totalAssignments = tags.reduce((acc, t) => acc + (t.count || 0), 0)
  const unusedCount = tags.filter((t) => !t.count).length
  const isEmpty = !list.isLoading && tags.length === 0
  const noMatches = !isEmpty && filtered.length === 0

  function newTag(groupId?: number) {
    setTagDraft({ name: "", color: "coral", icon: "", description: "", group_id: groupId ?? null })
  }
  function editTag(t: AssetTag) {
    setTagDraft({
      id: t.id,
      name: t.name,
      color: t.color || "coral",
      icon: t.icon || "",
      description: t.description || "",
      group_id: t.group_id ?? null,
    })
  }

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <TagIcon className="h-5 w-5 text-primary" /> 标签
          </h1>
          <p className="text-sm text-muted-foreground">
            为资产打上彩色标签，统一管理、按标签授权与浏览。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setGroupDraft({ name: "", color: "slate", icon: "", sort_order: groups.length })}>
            <FolderPlus className="h-4 w-4" /> 新建分组
          </Button>
          <Button onClick={() => newTag()}>
            <Plus className="h-4 w-4" /> 新建标签
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={TagIcon} label="标签" value={tags.length} />
        <StatCard icon={Layers} label="分组" value={groups.length} />
        <StatCard icon={Hash} label="资产关联" value={totalAssignments} />
        <StatCard icon={TagIcon} label="未使用" value={unusedCount} tone={unusedCount > 0 ? "muted" : undefined} />
      </div>

      {/* Search */}
      {!isEmpty && (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索标签或描述…"
            className="pl-9"
          />
        </div>
      )}

      {/* Body */}
      {isEmpty && (
        <EmptyState
          icon={TagIcon}
          title="还没有任何标签"
          description="创建第一个彩色标签，开始整理你的资产。"
          action={
            <Button onClick={() => newTag()}>
              <Plus className="h-4 w-4" /> 新建标签
            </Button>
          }
        />
      )}

      {noMatches && (
        <div className="rounded-xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          没有匹配「{q}」的标签
        </div>
      )}

      {!isEmpty && !noMatches && (
        <div className="space-y-4">
          {groups.map((g) => {
            const items = byGroup.get(g.id) ?? []
            if (q.trim() && items.length === 0) return null
            return (
              <GroupSection
                key={g.id}
                group={g}
                tags={items}
                onEditGroup={() =>
                  setGroupDraft({ id: g.id, name: g.name, color: g.color || "slate", icon: g.icon || "", sort_order: g.sort_order ?? 0 })
                }
                onAddTag={() => newTag(g.id)}
                onEditTag={editTag}
              />
            )
          })}

          {ungrouped.length > 0 && (
            <GroupSection
              tags={ungrouped}
              onAddTag={() => newTag()}
              onEditTag={editTag}
            />
          )}
        </div>
      )}

      <TagEditorSheet
        draft={tagDraft}
        groups={groups}
        onClose={() => setTagDraft(null)}
        onSaved={() => {
          setTagDraft(null)
          refresh()
        }}
      />
      <GroupEditorDialog
        draft={groupDraft}
        onClose={() => setGroupDraft(null)}
        onSaved={() => {
          setGroupDraft(null)
          refresh()
        }}
      />
    </div>
  )
}

// ----- Stat card -----

function StatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof TagIcon
  label: string
  value: number
  tone?: "muted"
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <div className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "muted" && "text-muted-foreground")}>
        {value}
      </div>
    </div>
  )
}

// ----- Group section -----

function GroupSection({
  group,
  tags,
  onEditGroup,
  onAddTag,
  onEditTag,
}: {
  group?: AssetTagGroup
  tags: AssetTag[]
  onEditGroup?: () => void
  onAddTag: () => void
  onEditTag: (t: AssetTag) => void
}) {
  const accent = group ? resolveTagColor(group.color, group.name) : null
  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
        {group ? (
          <>
            <span
              aria-hidden
              style={accent?.inline?.dot}
              className={cn("h-2.5 w-2.5 rounded-full", !accent?.inline && accent?.style.dot)}
            />
            <span className="text-sm font-semibold">
              {group.icon ? `${group.icon} ` : ""}
              {group.name}
            </span>
          </>
        ) : (
          <span className="text-sm font-semibold text-muted-foreground">未分组</span>
        )}
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          {tags.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {group && onEditGroup && (
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={onEditGroup} aria-label="编辑分组">
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 gap-1 text-muted-foreground hover:text-foreground" onClick={onAddTag}>
            <Plus className="h-3.5 w-3.5" /> 标签
          </Button>
        </div>
      </header>
      <div className="flex flex-wrap gap-2 p-4">
        <AnimatePresence initial={false}>
          {tags.map((t) => (
            <motion.button
              key={t.id}
              type="button"
              layout
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: "spring", stiffness: 420, damping: 32 }}
              onClick={() => onEditTag(t)}
              className="group inline-flex items-center gap-1.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              title={t.description || t.name}
            >
              <TagBadge tag={t} size="md" showDot className="group-hover:brightness-105" />
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t.count || 0}
              </span>
            </motion.button>
          ))}
        </AnimatePresence>
        {tags.length === 0 && (
          <button
            type="button"
            onClick={onAddTag}
            className="rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
          >
            + 添加标签
          </button>
        )}
      </div>
    </section>
  )
}

// ----- Tag editor (Sheet) -----

function TagEditorSheet({
  draft,
  groups,
  onClose,
  onSaved,
}: {
  draft: TagDraft | null
  groups: AssetTagGroup[]
  onClose: () => void
  onSaved: () => void
}) {
  const qc = useQueryClient()
  const [d, setD] = React.useState<TagDraft | null>(draft)
  React.useEffect(() => setD(draft), [draft])

  const save = useMutation({
    mutationFn: () => {
      if (!d) throw new Error("no draft")
      const body = {
        name: d.name.trim(),
        color: d.color,
        icon: d.icon,
        description: d.description,
        group_id: d.group_id,
      }
      return d.id ? tagService.update(d.id, body) : tagService.create(body)
    },
    onSuccess: () => {
      toast.success(d?.id ? "已保存标签" : "已创建标签")
      onSaved()
    },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })

  const remove = useMutation({
    mutationFn: () => tagService.remove(d!.id!),
    onSuccess: () => {
      toast.success("已删除标签")
      qc.invalidateQueries({ queryKey: ["tags"] })
      onSaved()
    },
    onError: (e: unknown) => toast.error("删除失败", { description: (e as Error).message }),
  })

  async function askDelete() {
    if (!d?.id) return
    const ok = await confirmDialog({
      title: `删除标签「${d.name}」？`,
      description: "此操作不可恢复；使用该标签的资产会自动解除关联。",
      destructive: true,
    })
    if (ok) remove.mutate()
  }

  const open = !!draft
  const valid = !!d && d.name.trim().length > 0

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{d?.id ? "编辑标签" : "新建标签"}</SheetTitle>
          <SheetDescription>颜色与 emoji 会在所有资产上同步生效。</SheetDescription>
        </SheetHeader>

        {d && (
          <div className="flex-1 space-y-5 overflow-y-auto px-4 py-5">
            {/* Live preview */}
            <div className="flex items-center justify-center rounded-xl border border-dashed border-border bg-muted/30 py-6">
              <TagBadge
                tag={{ name: d.name.trim() || "预览标签", color: d.color, icon: d.icon }}
                size="md"
                showDot
              />
            </div>

            <div className="space-y-1.5">
              <Label>名称</Label>
              <Input
                autoFocus
                value={d.name}
                onChange={(e) => setD({ ...d, name: e.target.value })}
                placeholder="如 prod、生产环境、db-primary"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && valid) save.mutate()
                }}
              />
            </div>

            <div className="space-y-1.5">
              <Label>颜色</Label>
              <ColorSwatchPicker
                value={d.color}
                onChange={(t: TagColorToken) => setD({ ...d, color: t })}
              />
            </div>

            <div className="space-y-1.5">
              <Label>图标</Label>
              <div className="flex items-center gap-2">
                <IconPicker value={d.icon} onChange={(t) => setD({ ...d, icon: t })} placeholder="选择图标" />
                <span className="text-xs text-muted-foreground">线性 / 品牌 / Emoji / 文字</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>分组</Label>
              <Select
                value={d.group_id ? String(d.group_id) : "none"}
                onValueChange={(v) => setD({ ...d, group_id: v === "none" ? null : Number(v) })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">未分组</SelectItem>
                  {groups.map((g) => (
                    <SelectItem key={g.id} value={String(g.id)}>
                      {g.icon ? `${g.icon} ` : ""}
                      {g.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>描述</Label>
              <Textarea
                value={d.description}
                onChange={(e) => setD({ ...d, description: e.target.value })}
                placeholder="一句话说明这个标签代表什么"
                className="min-h-[72px] resize-none"
              />
            </div>
          </div>
        )}

        <SheetFooter className="flex-row items-center gap-2 border-t border-border px-4 py-3">
          {d?.id && (
            <Button
              variant="ghost"
              size="icon"
              onClick={askDelete}
              disabled={remove.isPending}
              className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label="删除标签"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending}>
            {d?.id ? "保存" : "创建"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// ----- Group editor (Dialog) -----

function GroupEditorDialog({
  draft,
  onClose,
  onSaved,
}: {
  draft: GroupDraft | null
  onClose: () => void
  onSaved: () => void
}) {
  const [d, setD] = React.useState<GroupDraft | null>(draft)
  React.useEffect(() => setD(draft), [draft])

  const save = useMutation({
    mutationFn: () => {
      if (!d) throw new Error("no draft")
      const body = { name: d.name.trim(), color: d.color, icon: d.icon, sort_order: d.sort_order }
      return d.id ? tagGroupService.update(d.id, body) : tagGroupService.create(body)
    },
    onSuccess: () => {
      toast.success(d?.id ? "已保存分组" : "已创建分组")
      onSaved()
    },
    onError: (e: unknown) => toast.error("保存失败", { description: (e as Error).message }),
  })
  const remove = useMutation({
    mutationFn: () => tagGroupService.remove(d!.id!),
    onSuccess: () => {
      toast.success("已删除分组（标签已转为未分组）")
      onSaved()
    },
    onError: (e: unknown) => toast.error("删除失败", { description: (e as Error).message }),
  })

  async function askDelete() {
    if (!d?.id) return
    const ok = await confirmDialog({
      title: `删除分组「${d.name}」？`,
      description: "分组内的标签不会被删除，会转为「未分组」。",
      destructive: true,
    })
    if (ok) remove.mutate()
  }

  const open = !!draft
  const valid = !!d && d.name.trim().length > 0

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{d?.id ? "编辑分组" : "新建分组"}</DialogTitle>
        </DialogHeader>
        {d && (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>名称</Label>
              <Input
                autoFocus
                value={d.name}
                onChange={(e) => setD({ ...d, name: e.target.value })}
                placeholder="如 环境、团队、地域"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && valid) save.mutate()
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>默认颜色</Label>
              <ColorSwatchPicker value={d.color} onChange={(t) => setD({ ...d, color: t })} />
            </div>
            <div className="flex items-end gap-4">
              <div className="space-y-1.5">
                <Label>图标</Label>
                <IconPicker value={d.icon} onChange={(t) => setD({ ...d, icon: t })} placeholder="选择图标" />
              </div>
              <div className="flex-1 space-y-1.5">
                <Label>排序</Label>
                <Input
                  type="number"
                  value={d.sort_order}
                  onChange={(e) => setD({ ...d, sort_order: Number(e.target.value) || 0 })}
                />
              </div>
            </div>
          </div>
        )}
        <DialogFooter className="flex-row items-center gap-2">
          {d?.id && (
            <Button
              variant="ghost"
              size="icon"
              onClick={askDelete}
              disabled={remove.isPending}
              className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label="删除分组"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={() => save.mutate()} disabled={!valid || save.isPending}>
            {d?.id ? "保存" : "创建"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
