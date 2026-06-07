"use client"

import * as React from "react"
import {
  ClipboardList,
  Keyboard,
  Monitor,
  ShieldCheck,
  SlidersHorizontal,
  Video,
} from "lucide-react"
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
import type {
  DesktopSettings,
  DpiScale,
  ScaleMode,
  ClipboardDirection,
  VideoTransport,
  VideoQuality,
} from "./desktop-types"
import { KEYBOARD_LAYOUTS, effectiveDpiScale } from "./use-desktop-settings"

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
          <SheetTitle className="flex items-center gap-2.5 text-base">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <SlidersHorizontal className="h-4 w-4" />
            </span>
            桌面设置
          </SheetTitle>
          <SheetDescription>改动实时生效并保存在本机，下次连接沿用。</SheetDescription>
        </SheetHeader>
        <Separator />
        <ScrollArea className="flex-1">
          <div className="px-5 py-4 space-y-7">
            <Section title="视频" icon={Video}>
              <Field label="传输方式">
                <ToggleGroup
                  type="single"
                  value={settings.videoTransport}
                  onValueChange={(v) => v && onChange({ videoTransport: v as VideoTransport })}
                  size="sm"
                  className="justify-start"
                >
                  <ToggleGroupItem value="auto" className="text-xs">自动</ToggleGroupItem>
                  <ToggleGroupItem value="webrtc" className="text-xs">WebRTC</ToggleGroupItem>
                  <ToggleGroupItem value="bitmap" className="text-xs">JS 解码</ToggleGroupItem>
                </ToggleGroup>
                <p className="text-[10px] text-muted-foreground">
                  WebRTC:浏览器硬件解码视频流,低延迟、低内存(推荐);JS 解码:逐帧位图,兼容性最好但更吃 CPU/内存;自动:能用 WebRTC 就用,失败回退。切换后下次连接生效。
                </p>
              </Field>

              <Field label="画质 (WebRTC)">
                <ToggleGroup
                  type="single"
                  value={settings.videoQuality}
                  onValueChange={(v) => v && onChange({ videoQuality: v as VideoQuality })}
                  size="sm"
                  className="justify-start"
                >
                  <ToggleGroupItem value="smooth" className="text-xs">流畅</ToggleGroupItem>
                  <ToggleGroupItem value="balanced" className="text-xs">均衡</ToggleGroupItem>
                  <ToggleGroupItem value="sharp" className="text-xs">高清</ToggleGroupItem>
                </ToggleGroup>
                <p className="text-[10px] text-muted-foreground">
                  流畅:低码率省带宽;均衡:默认;高清:高码率,文字更锐利。仅影响 WebRTC,下次连接生效。
                </p>
              </Field>
            </Section>

            <Section title="显示" icon={Monitor}>
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

              <Field label="分辨率模式">
                <ToggleGroup
                  type="single"
                  value={settings.dynamicResolution ? "dynamic" : "smart"}
                  onValueChange={(v) => v && onChange({ dynamicResolution: v === "dynamic" })}
                  size="sm"
                  className="justify-start"
                >
                  <ToggleGroupItem value="smart" className="text-xs">智能缩放</ToggleGroupItem>
                  <ToggleGroupItem value="dynamic" className="text-xs">动态分辨率</ToggleGroupItem>
                </ToggleGroup>
                <p className="text-[10px] text-muted-foreground">
                  智能缩放:远端分辨率固定,按上面的缩放模式贴合窗口。动态分辨率:远端跟随窗口实时改、始终 1:1 清晰(需节点开启 dynamic_resolution 且远端支持;否则下次连接生效)。
                </p>
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
                label="高 DPI"
                description="按设备像素比渲染:远端以物理像素分辨率绘制,文字与界面在高分屏上保持锐利,而非细小或放大模糊(FreeRDP 后端)。下次连接生效。"
                checked={settings.highDpi}
                onChange={(v) => onChange({ highDpi: v })}
              />

              {settings.highDpi && (
                <Field label="缩放比例">
                  <Select value={settings.dpiScale} onValueChange={(v) => onChange({ dpiScale: v as DpiScale })}>
                    <SelectTrigger className="h-8 text-xs w-36"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto" className="text-xs">自动 (跟随设备)</SelectItem>
                      <SelectItem value="100" className="text-xs">100%</SelectItem>
                      <SelectItem value="125" className="text-xs">125%</SelectItem>
                      <SelectItem value="150" className="text-xs">150%</SelectItem>
                      <SelectItem value="175" className="text-xs">175%</SelectItem>
                      <SelectItem value="200" className="text-xs">200%</SelectItem>
                      <SelectItem value="250" className="text-xs">250%</SelectItem>
                      <SelectItem value="300" className="text-xs">300%</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-[10px] text-muted-foreground">
                    {settings.dpiScale === "auto" ? `当前设备约 ${effectiveDpiScale(settings)}%,` : ""}
                    远端将以 {Math.round((settings.preferredWidth * effectiveDpiScale(settings)) / 100)}×
                    {Math.round((settings.preferredHeight * effectiveDpiScale(settings)) / 100)} 物理像素渲染。下次连接生效。
                  </p>
                </Field>
              )}

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

            <Section title="输入" icon={Keyboard}>
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

            <Section title="剪贴板 / 音频" icon={ClipboardList}>
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

            <Section title="稳定性" icon={ShieldCheck}>
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

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <h3 className="eyebrow flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground/80" />
        {title}
      </h3>
      <div className="space-y-3.5">{children}</div>
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
