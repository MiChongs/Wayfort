"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { DesktopSettings, ScaleMode, ClipboardDirection } from "./desktop-types"
import { KEYBOARD_LAYOUTS } from "./use-desktop-settings"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: DesktopSettings
  onChange: (patch: Partial<DesktopSettings>) => void
  onReset: () => void
}

export function DesktopSettingsSheet({ open, onOpenChange, settings, onChange, onReset }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px] flex flex-col gap-0 p-0">
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle>桌面设置</SheetTitle>
          <SheetDescription>所有设置实时生效并自动保存到本地。</SheetDescription>
        </SheetHeader>
        <Separator />
        <ScrollArea className="flex-1">
          <div className="px-5 py-4 space-y-6">
            <Section title="显示">
              <Field label="缩放模式">
                <ToggleGroup
                  type="single"
                  value={settings.scaleMode}
                  onValueChange={(v) => v && onChange({ scaleMode: v as ScaleMode })}
                  size="sm"
                  className="justify-start"
                >
                  <ToggleGroupItem value="fit" className="text-xs">适应</ToggleGroupItem>
                  <ToggleGroupItem value="actual" className="text-xs">原始</ToggleGroupItem>
                  <ToggleGroupItem value="center" className="text-xs">居中</ToggleGroupItem>
                  <ToggleGroupItem value="stretch" className="text-xs">拉伸</ToggleGroupItem>
                </ToggleGroup>
              </Field>

              <Field label="期望分辨率">
                <div className="flex gap-2">
                  <Select
                    value={String(settings.preferredWidth)}
                    onValueChange={(v) => onChange({ preferredWidth: Number(v) })}
                  >
                    <SelectTrigger className="h-8 text-xs w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1024" className="text-xs">1024</SelectItem>
                      <SelectItem value="1280" className="text-xs">1280</SelectItem>
                      <SelectItem value="1366" className="text-xs">1366</SelectItem>
                      <SelectItem value="1440" className="text-xs">1440</SelectItem>
                      <SelectItem value="1600" className="text-xs">1600</SelectItem>
                      <SelectItem value="1920" className="text-xs">1920</SelectItem>
                      <SelectItem value="2560" className="text-xs">2560</SelectItem>
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground self-center">×</span>
                  <Select
                    value={String(settings.preferredHeight)}
                    onValueChange={(v) => onChange({ preferredHeight: Number(v) })}
                  >
                    <SelectTrigger className="h-8 text-xs w-24"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="600" className="text-xs">600</SelectItem>
                      <SelectItem value="720" className="text-xs">720</SelectItem>
                      <SelectItem value="768" className="text-xs">768</SelectItem>
                      <SelectItem value="900" className="text-xs">900</SelectItem>
                      <SelectItem value="1024" className="text-xs">1024</SelectItem>
                      <SelectItem value="1080" className="text-xs">1080</SelectItem>
                      <SelectItem value="1440" className="text-xs">1440</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <p className="text-[10px] text-muted-foreground">下次连接生效。当前会话保持已协商的分辨率。</p>
              </Field>

              <Field label="颜色深度">
                <ToggleGroup
                  type="single"
                  value={String(settings.colorDepth)}
                  onValueChange={(v) => v && onChange({ colorDepth: Number(v) as 16 | 24 | 32 })}
                  size="sm"
                >
                  <ToggleGroupItem value="16" className="text-xs">16 bit</ToggleGroupItem>
                  <ToggleGroupItem value="24" className="text-xs">24 bit</ToggleGroupItem>
                  <ToggleGroupItem value="32" className="text-xs">32 bit</ToggleGroupItem>
                </ToggleGroup>
              </Field>

              <SwitchField
                label="平滑缩放"
                description="窗口缩放时启用画布抗锯齿。关闭后像素更锐利但锯齿可见。"
                checked={settings.smoothScaling}
                onChange={(v) => onChange({ smoothScaling: v })}
              />

              <Field label="光标模式">
                <ToggleGroup
                  type="single"
                  value={settings.cursorMode}
                  onValueChange={(v) =>
                    v && onChange({ cursorMode: v as DesktopSettings["cursorMode"] })
                  }
                  size="sm"
                >
                  <ToggleGroupItem value="remote" className="text-xs">服务器</ToggleGroupItem>
                  <ToggleGroupItem value="css-only" className="text-xs">本地</ToggleGroupItem>
                  <ToggleGroupItem value="hidden" className="text-xs">隐藏</ToggleGroupItem>
                </ToggleGroup>
                <p className="text-[10px] text-muted-foreground">
                  服务器:用远端发送的光标(bitmap 优先,无 bitmap 时用 CSS 兜底);本地:始终用浏览器系统光标。
                </p>
              </Field>
            </Section>

            <Section title="输入">
              <Field label="键盘布局">
                <Select
                  value={settings.keyboardLayout}
                  onValueChange={(v) => onChange({ keyboardLayout: v })}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {KEYBOARD_LAYOUTS.map((l) => (
                      <SelectItem key={l.value} value={l.value} className="text-xs">
                        {l.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <SwitchField
                label="同步锁定键"
                description="(重)连接时把浏览器的 CapsLock / NumLock / ScrollLock 状态同步到远端。"
                checked={settings.syncLocks}
                onChange={(v) => onChange({ syncLocks: v })}
              />

              <SwitchField
                label="中键映射为右键"
                description="点击鼠标中键时发送远端右键。适用于把中键当右键的工作流。"
                checked={settings.swapMiddleButton}
                onChange={(v) => onChange({ swapMiddleButton: v })}
              />
            </Section>

            <Section title="剪贴板 / 音频">
              <Field label="剪贴板方向">
                <ToggleGroup
                  type="single"
                  value={settings.clipboardDirection}
                  onValueChange={(v) =>
                    v && onChange({ clipboardDirection: v as ClipboardDirection })
                  }
                  size="sm"
                >
                  <ToggleGroupItem value="both" className="text-xs">双向</ToggleGroupItem>
                  <ToggleGroupItem value="in-only" className="text-xs">仅入</ToggleGroupItem>
                  <ToggleGroupItem value="out-only" className="text-xs">仅出</ToggleGroupItem>
                  <ToggleGroupItem value="off" className="text-xs">关闭</ToggleGroupItem>
                </ToggleGroup>
                <p className="text-[10px] text-muted-foreground">
                  双向:本地 ↔ 远端;仅入:远端 → 本地;仅出:本地 → 远端;关闭:两端隔离。
                </p>
              </Field>

              <Field
                label={
                  <span className="flex items-center justify-between gap-2">
                    <span>粘贴行数确认阈值</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {settings.clipboardConfirmLines || "关闭"}
                    </span>
                  </span>
                }
              >
                <Slider
                  min={0}
                  max={20}
                  step={1}
                  value={[settings.clipboardConfirmLines]}
                  onValueChange={(vals) => onChange({ clipboardConfirmLines: vals[0] ?? 0 })}
                />
                <p className="text-[10px] text-muted-foreground">
                  粘贴超过此行数前弹确认;0 表示从不弹。
                </p>
              </Field>

              <SwitchField
                label="远端音频"
                description="播放远端桌面发出的音频。下次连接生效。"
                checked={settings.audioPlayback}
                onChange={(v) => onChange({ audioPlayback: v })}
              />
            </Section>

            <Section title="稳定性">
              <SwitchField
                label="自动重连"
                description="WebSocket 意外断开时按 1s/2s/4s 退避重试 3 次。"
                checked={settings.reconnectOnDrop}
                onChange={(v) => onChange({ reconnectOnDrop: v })}
              />
            </Section>
          </div>
        </ScrollArea>
        <Separator />
        <SheetFooter className="px-5 py-3 flex-row sm:flex-row sm:justify-between">
          <Button variant="outline" size="sm" onClick={onReset}>恢复默认</Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>完成</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h3>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}

function SwitchField({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-0.5 min-w-0">
        <Label className="text-xs">{label}</Label>
        {description && (
          <p className="text-[11px] text-muted-foreground leading-snug">{description}</p>
        )}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5 shrink-0" />
    </div>
  )
}
