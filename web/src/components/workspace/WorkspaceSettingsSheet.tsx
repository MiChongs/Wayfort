"use client"

// Workspace settings drawer. Currently exposes the three knobs the user
// can drive without a redeploy: how tabs are grouped, and which extra
// chrome (protocol icon, host:port, latency chip) the tab strip renders.
// Designed as a Sheet so it slides in from the side without taking the
// user out of the workspace context.

import * as React from "react"
import { Folder, Globe, Layers, type LucideIcon } from "lucide-react"
import { motion } from "motion/react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import {
  useWorkspaceStore,
  type GroupingMode,
} from "./useWorkspaceStore"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

interface ModeOption {
  value: GroupingMode
  title: string
  description: string
  icon: LucideIcon
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: "off",
    title: "不分组",
    description: "扁平显示所有 Tab。",
    icon: Layers,
  },
  {
    value: "manual",
    title: "手动分组",
    description: "右键 Tab 加入或新建分组，色块自定义。",
    icon: Folder,
  },
  {
    value: "by-node",
    title: "按节点自动分组",
    description: "同一目标节点的所有 Tab（SSH / SFTP / 端口转发等）合并成一组。",
    icon: Globe,
  },
  {
    value: "by-protocol",
    title: "按协议自动分组",
    description: "SSH / RDP / 端口转发等各成一组。",
    icon: Layers,
  },
]

export function WorkspaceSettingsSheet({ open, onOpenChange }: Props) {
  const prefs = useWorkspaceStore((s) => s.prefs)
  const setGroupingMode = useWorkspaceStore((s) => s.setGroupingMode)
  const setPrefs = useWorkspaceStore((s) => s.setPrefs)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>工作台设置</SheetTitle>
          <SheetDescription>
            调整 Tab 分组方式与视觉细节。设置保存在本地浏览器。
          </SheetDescription>
        </SheetHeader>

        <div className="p-4 space-y-6">
          <section className="space-y-2">
            <h3 className="text-sm font-medium">分组方式</h3>
            <RadioGroup
              value={prefs.groupingMode}
              onValueChange={(v) => setGroupingMode(v as GroupingMode)}
              className="space-y-2"
            >
              {MODE_OPTIONS.map((opt) => {
                const Icon = opt.icon
                const checked = prefs.groupingMode === opt.value
                return (
                  <motion.label
                    key={opt.value}
                    htmlFor={`mode-${opt.value}`}
                    layout
                    className={cn(
                      "flex items-start gap-3 rounded-md border p-3 cursor-pointer",
                      "transition-colors",
                      checked
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-accent/40",
                    )}
                  >
                    <RadioGroupItem
                      id={`mode-${opt.value}`}
                      value={opt.value}
                      className="mt-1"
                    />
                    <div className="space-y-0.5 flex-1">
                      <div className="text-sm font-medium inline-flex items-center gap-1.5">
                        <Icon className="w-3.5 h-3.5" />
                        {opt.title}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {opt.description}
                      </div>
                    </div>
                  </motion.label>
                )
              })}
            </RadioGroup>
          </section>

          <Separator />

          <section className="space-y-3">
            <h3 className="text-sm font-medium">Tab 视觉</h3>
            <ToggleRow
              label="显示协议图标"
              description="在 Tab 标题左侧画一个 SSH / RDP / VNC 等小图标。"
              checked={prefs.showProtocolIcon}
              onChange={(v) => setPrefs({ showProtocolIcon: v })}
            />
            <ToggleRow
              label="标题悬停显示 host:port"
              description="鼠标悬停在 Tab 上时，浏览器原生 title 显示目标地址。"
              checked={prefs.showHostPort}
              onChange={(v) => setPrefs({ showHostPort: v })}
            />
            <ToggleRow
              label="显示延迟徽章"
              description="已连接的 Tab 右侧展示 RTT 毫秒数。"
              checked={prefs.showLatencyBadge}
              onChange={(v) => setPrefs({ showLatencyBadge: v })}
            />
          </section>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5">
        <Label className="text-sm font-medium">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}
