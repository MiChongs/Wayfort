"use client"

import * as React from "react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  type TerminalSettings,
} from "./use-terminal-settings"
import { TERMINAL_THEMES, TERMINAL_THEME_ORDER } from "./terminal-themes"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: TerminalSettings
  onChange: (patch: Partial<TerminalSettings>) => void
  onReset: () => void
}

export function TerminalSettingsSheet({ open, onOpenChange, settings, onChange, onReset }: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[420px] sm:max-w-[420px] flex flex-col gap-0 p-0">
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle>终端设置</SheetTitle>
          <SheetDescription>所有设置实时生效并自动保存到本地。</SheetDescription>
        </SheetHeader>
        <Separator />
        <ScrollArea className="flex-1">
          <div className="px-5 py-4 space-y-6">
            <Section title="外观">
              <Field label="主题">
                <Select
                  value={settings.themeName}
                  onValueChange={(v) =>
                    onChange({ themeName: v as TerminalSettings["themeName"] })
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TERMINAL_THEME_ORDER.map((name) => (
                      <SelectItem key={name} value={name} className="text-xs">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="inline-block w-3 h-3 rounded-sm border border-border/60"
                            style={{ background: TERMINAL_THEMES[name].colors.background }}
                          />
                          {TERMINAL_THEMES[name].display}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="字体">
                <Input
                  className="h-8 text-xs font-mono"
                  value={settings.fontFamily}
                  onChange={(e) => onChange({ fontFamily: e.target.value })}
                  spellCheck={false}
                />
              </Field>

              <Field label={`字号  ${settings.fontSize} px`}>
                <input
                  type="range"
                  min={FONT_SIZE_MIN}
                  max={FONT_SIZE_MAX}
                  step={1}
                  value={settings.fontSize}
                  onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
                  className="w-full"
                />
              </Field>

              <Field label={`行高  ×${settings.lineHeight.toFixed(2)}`}>
                <input
                  type="range"
                  min={1.0}
                  max={1.8}
                  step={0.05}
                  value={settings.lineHeight}
                  onChange={(e) => onChange({ lineHeight: Number(e.target.value) })}
                  className="w-full"
                />
              </Field>

              <Field label={`字距  ${settings.letterSpacing}`}>
                <input
                  type="range"
                  min={-2}
                  max={4}
                  step={0.5}
                  value={settings.letterSpacing}
                  onChange={(e) => onChange({ letterSpacing: Number(e.target.value) })}
                  className="w-full"
                />
              </Field>
            </Section>

            <Section title="光标">
              <Field label="样式">
                <ToggleGroup
                  type="single"
                  value={settings.cursorStyle}
                  onValueChange={(v) => {
                    if (v) onChange({ cursorStyle: v as TerminalSettings["cursorStyle"] })
                  }}
                  size="sm"
                >
                  <ToggleGroupItem value="block" className="text-xs">
                    块状
                  </ToggleGroupItem>
                  <ToggleGroupItem value="underline" className="text-xs">
                    下划线
                  </ToggleGroupItem>
                  <ToggleGroupItem value="bar" className="text-xs">
                    竖线
                  </ToggleGroupItem>
                </ToggleGroup>
              </Field>

              <SwitchField
                label="光标闪烁"
                checked={settings.cursorBlink}
                onChange={(v) => onChange({ cursorBlink: v })}
              />
            </Section>

            <Section title="行为">
              <Field label={`回滚行数  ${settings.scrollback}`}>
                <input
                  type="range"
                  min={SCROLLBACK_MIN}
                  max={SCROLLBACK_MAX}
                  step={1000}
                  value={settings.scrollback}
                  onChange={(e) => onChange({ scrollback: Number(e.target.value) })}
                  className="w-full"
                />
              </Field>

              <SwitchField
                label="蜂鸣提示音"
                description="远端发送 BEL (\\a) 时播放短促提示音。"
                checked={settings.bellEnabled}
                onChange={(v) => onChange({ bellEnabled: v })}
              />

              <SwitchField
                label="编程连字"
                description="JetBrains Mono / Fira Code 等字体的 ==> != >= 渲染为连字符号。"
                checked={settings.ligaturesEnabled}
                onChange={(v) => onChange({ ligaturesEnabled: v })}
              />

              <SwitchField
                label="WebGL 加速"
                description="使用 GPU 渲染,长会话和高速输出更流畅。WebGL 不可用时自动降级到默认渲染。"
                checked={settings.webglEnabled}
                onChange={(v) => onChange({ webglEnabled: v })}
              />
            </Section>
          </div>
        </ScrollArea>
        <Separator />
        <SheetFooter className="px-5 py-3 flex-row sm:flex-row sm:justify-between">
          <Button variant="outline" size="sm" onClick={onReset}>
            恢复默认
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            完成
          </Button>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
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
