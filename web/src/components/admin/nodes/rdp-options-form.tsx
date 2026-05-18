"use client"

import * as React from "react"
import { Info } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { RdpProtoOptions, RdpSecurity } from "@/lib/api/types"
import { parseProtoOptions, serializeProtoOptions } from "@/lib/desktop/proto-options"

type Props = {
  // The raw proto_options JSON string from the node row. Empty / null = no
  // overrides; the form falls back to displaying worker defaults so the
  // operator sees what behaviour will actually be applied.
  value?: string | null
  onChange: (json: string) => void
}

export function RdpOptionsForm({ value, onChange }: Props) {
  const env = React.useMemo(() => parseProtoOptions(value), [value])
  const opts: RdpProtoOptions = env.rdp ?? {}

  const update = React.useCallback(
    (patch: Partial<RdpProtoOptions>) => {
      const next: RdpProtoOptions = { ...opts, ...patch }
      // Drop fields whose value matches "no override" semantics so the
      // serialized JSON stays minimal and the diff against the on-disk
      // state is easy to scan.
      for (const k of Object.keys(patch) as Array<keyof RdpProtoOptions>) {
        const v = next[k]
        if (v === undefined || v === "") delete next[k]
      }
      onChange(serializeProtoOptions({ rdp: next }))
    },
    [opts, onChange],
  )

  return (
    <Tabs defaultValue="security" className="w-full">
      <TabsList className="grid grid-cols-5 w-full">
        <TabsTrigger value="security" className="text-xs">安全</TabsTrigger>
        <TabsTrigger value="display" className="text-xs">显示</TabsTrigger>
        <TabsTrigger value="experience" className="text-xs">性能 / 体验</TabsTrigger>
        <TabsTrigger value="redirect" className="text-xs">重定向</TabsTrigger>
        <TabsTrigger value="network" className="text-xs">网络</TabsTrigger>
      </TabsList>

      <TabsContent value="security" className="space-y-3 pt-3">
        <Field label="安全模式" hint="决定与远端协商的加密层。默认自动协商成功率最高;固定单一模式适用于服务器只支持某一种。">
          <Select
            value={opts.security ?? "any"}
            onValueChange={(v) => update({ security: v as RdpSecurity })}
          >
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="any" className="text-xs">自动协商 (NLA → TLS → RDP)</SelectItem>
              <SelectItem value="nla" className="text-xs">仅 NLA(凭据必须正确)</SelectItem>
              <SelectItem value="tls" className="text-xs">仅 TLS(NLA 被关掉的老 Windows)</SelectItem>
              <SelectItem value="rdp" className="text-xs">仅 RDP Security(legacy XOR/RC4)</SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <Field label={`TLS 安全级别  ${opts.tls_sec_level ?? 0}`} hint="0 = 接受 TLS 1.0+(Server 2008/2012R2 兼容);≥3 = OpenSSL 默认严格(不接受老协议)。">
          <input
            type="range"
            min={0}
            max={5}
            step={1}
            value={opts.tls_sec_level ?? 0}
            onChange={(e) => update({ tls_sec_level: Number(e.target.value) })}
            className="w-full"
          />
        </Field>

        <SwitchField
          label="忽略服务器证书"
          description="不校验证书有效性。自签 / 过期证书需要开启。"
          checked={opts.ignore_cert ?? true}
          onChange={(v) => update({ ignore_cert: v })}
        />

        <Field label="Windows 域(可选)" hint="设了之后用 DOMAIN\\username 鉴权,适用于 AD 加域机器。">
          <Input
            className="h-8 text-xs"
            value={opts.domain ?? ""}
            placeholder="WORKGROUP"
            onChange={(e) => update({ domain: e.target.value || undefined })}
          />
        </Field>
      </TabsContent>

      <TabsContent value="display" className="space-y-3 pt-3">
        <Field label="颜色深度" hint="32 适合现代 Windows 视觉效果;16 在低带宽下可显著省流量。">
          <ToggleGroup
            type="single"
            value={String(opts.color_depth ?? 32)}
            onValueChange={(v) => {
              if (!v) return
              update({ color_depth: Number(v) as 16 | 24 | 32 })
            }}
            size="sm"
          >
            <ToggleGroupItem value="16" className="text-xs">16 bit</ToggleGroupItem>
            <ToggleGroupItem value="24" className="text-xs">24 bit</ToggleGroupItem>
            <ToggleGroupItem value="32" className="text-xs">32 bit</ToggleGroupItem>
          </ToggleGroup>
        </Field>

        <SwitchField
          label="使用 Console 会话 (/admin)"
          description="直接附加到远端 RDS 物理控制台,而不是新建虚拟会话。"
          checked={opts.console_session ?? false}
          onChange={(v) => update({ console_session: v })}
        />

        <Field label="键盘布局(可选)" hint="留空使用浏览器布局。常用:en-us / zh-cn / ja-jp。">
          <Input
            className="h-8 text-xs font-mono"
            value={opts.keyboard ?? ""}
            placeholder="en-us"
            onChange={(e) => update({ keyboard: e.target.value || undefined })}
          />
        </Field>
      </TabsContent>

      <TabsContent value="experience" className="space-y-3 pt-3">
        <Group title="编解码">
          <SwitchField
            label="启用 RemoteFX 编解码"
            description="高质量、对 CPU 友好的现代编解码,默认开。"
            checked={opts.enable_remote_fx ?? true}
            onChange={(v) => update({ enable_remote_fx: v })}
          />
          <SwitchField
            label="启用 NSCodec"
            description="基于 H.264 的桌面编解码,默认开。"
            checked={opts.enable_nscodec ?? true}
            onChange={(v) => update({ enable_nscodec: v })}
          />
          <SwitchField
            label="启用 H.264 GFX 管道"
            description="视频画面用 H.264 编码,适合播放视频。"
            checked={opts.enable_h264 ?? true}
            onChange={(v) => update({ enable_h264: v })}
          />
          <SwitchField
            label="启用 Graphics Pipeline"
            description="使用 MS-RDPEGFX 现代图形管道。关掉走老式 BitmapCache,兼容性更好但体验差。"
            checked={opts.enable_graphics_pipeline ?? true}
            onChange={(v) => update({ enable_graphics_pipeline: v })}
          />
        </Group>

        <Separator />

        <Group title="视觉简化(省带宽)">
          <SwitchField
            label="禁用桌面壁纸"
            description="远端桌面变成纯色背景。"
            checked={opts.disable_wallpaper ?? false}
            onChange={(v) => update({ disable_wallpaper: v })}
          />
          <SwitchField
            label="禁用全窗口拖动"
            description="拖窗口时只显示边框。"
            checked={opts.disable_full_window_drag ?? false}
            onChange={(v) => update({ disable_full_window_drag: v })}
          />
          <SwitchField
            label="禁用菜单动画"
            checked={opts.disable_menu_anims ?? false}
            onChange={(v) => update({ disable_menu_anims: v })}
          />
          <SwitchField
            label="禁用主题样式"
            description="远端使用经典 Windows 主题,无圆角阴影。"
            checked={opts.disable_themes ?? false}
            onChange={(v) => update({ disable_themes: v })}
          />
          <SwitchField
            label="允许字体平滑"
            description="ClearType 文字渲染,默认开。"
            checked={opts.allow_font_smoothing ?? true}
            onChange={(v) => update({ allow_font_smoothing: v })}
          />
          <SwitchField
            label="允许桌面合成"
            description="Aero / DWM 视觉效果,默认开。"
            checked={opts.allow_desktop_composition ?? true}
            onChange={(v) => update({ allow_desktop_composition: v })}
          />
        </Group>
      </TabsContent>

      <TabsContent value="redirect" className="space-y-3 pt-3">
        <SwitchField
          label="剪贴板重定向"
          description="本地 ↔ 远端剪贴板双向同步(MS-RDPECLIP)。"
          checked={opts.redirect_clipboard ?? true}
          onChange={(v) => update({ redirect_clipboard: v })}
        />
        <SwitchField
          label="音频回放"
          description="远端桌面发出的音频通过 RDPSND 传到浏览器。"
          checked={opts.audio_playback ?? true}
          onChange={(v) => update({ audio_playback: v })}
        />
        <SwitchField
          label="设备重定向"
          description="磁盘 / 打印机 / 智能卡通道(RDPDR)。"
          checked={opts.device_redirection ?? true}
          onChange={(v) => update({ device_redirection: v })}
        />
      </TabsContent>

      <TabsContent value="network" className="space-y-3 pt-3">
        <Field label={`TCP 连接超时  ${opts.tcp_connect_timeout_ms ?? 8000} ms`} hint="到达不可达主机时多快返回错误。8s 适合公网。">
          <input
            type="range"
            min={3000}
            max={30000}
            step={1000}
            value={opts.tcp_connect_timeout_ms ?? 8000}
            onChange={(e) => update({ tcp_connect_timeout_ms: Number(e.target.value) })}
            className="w-full"
          />
        </Field>
        <Field label={`TCP ACK 超时  ${opts.tcp_ack_timeout_ms ?? 9000} ms`}>
          <input
            type="range"
            min={3000}
            max={30000}
            step={1000}
            value={opts.tcp_ack_timeout_ms ?? 9000}
            onChange={(e) => update({ tcp_ack_timeout_ms: Number(e.target.value) })}
            className="w-full"
          />
        </Field>
      </TabsContent>
    </Tabs>
  )
}

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && (
        <p className="text-[11px] text-muted-foreground inline-flex items-start gap-1 leading-snug">
          <Info className="w-3 h-3 mt-0.5 shrink-0 opacity-60" /> {hint}
        </p>
      )}
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

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      <div className="space-y-2.5">{children}</div>
    </section>
  )
}
