"use client"

import * as React from "react"
import {
  ArrowRight,
  DoorOpen,
  Gauge,
  Info,
  Monitor,
  Network,
  Server,
  Shield,
  SlidersHorizontal,
} from "lucide-react"
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
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import type { Credential, RdpProtoOptions, RdpSecurity } from "@/lib/api/types"
import { credentialService } from "@/lib/api/services"
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

  // RD Gateway credential picker source. Fetched lazily — only when a gateway is
  // configured AND it needs a dedicated (non-same) credential.
  const gatewayOn = !!opts.gateway_host
  const useSameCreds = opts.gateway_use_same_credentials ?? true
  const [pwCreds, setPwCreds] = React.useState<Credential[]>([])
  React.useEffect(() => {
    if (!gatewayOn || useSameCreds) return
    let alive = true
    credentialService
      .list()
      .then((r) => {
        if (alive) setPwCreds((r.credentials ?? []).filter((c) => c.kind === "password"))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [gatewayOn, useSameCreds])

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground leading-relaxed">
        <span className="font-medium text-foreground">这里配置 FreeRDP 新栈(rdp_next)</span>
        。工作台双击 RDP 节点默认走经典 Guacamole 模式,兼容性更广;FreeRDP 新栈
        作为右键备选(Beta)。新栈连接失败时,会话内有 "切换经典 RDP" 按钮一键回退。
      </div>
      <Tabs defaultValue="security" className="w-full">
      <TabsList className="grid grid-cols-5 w-full">
        <TabsTrigger value="security" className="text-xs gap-1"><Shield className="h-3.5 w-3.5" />安全</TabsTrigger>
        <TabsTrigger value="display" className="text-xs gap-1"><Monitor className="h-3.5 w-3.5" />显示</TabsTrigger>
        <TabsTrigger value="experience" className="text-xs gap-1"><Gauge className="h-3.5 w-3.5" />体验</TabsTrigger>
        <TabsTrigger value="redirect" className="text-xs gap-1"><SlidersHorizontal className="h-3.5 w-3.5" />重定向</TabsTrigger>
        <TabsTrigger value="network" className="text-xs gap-1"><Network className="h-3.5 w-3.5" />网络</TabsTrigger>
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

        <SliderField
          label="TLS 安全级别"
          hint="0 = 接受 TLS 1.0+(Server 2008/2012R2 兼容);≥3 = OpenSSL 默认严格(不接受老协议)。"
          min={0}
          max={5}
          step={1}
          value={opts.tls_sec_level ?? 0}
          onChange={(v) => update({ tls_sec_level: v })}
          format={(v) => (v === 0 ? "0 · 最宽松" : v >= 3 ? `${v} · 严格` : `${v} · 宽松`)}
        />

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

        <SwitchField
          label="高 DPI 缩放"
          description="按客户端设备像素比渲染:远端以物理像素分辨率绘制并应用 Windows 显示缩放,高分屏上文字与界面更锐利。默认开;个别对缩放兼容不佳的旧系统可关闭。仅 FreeRDP 后端。"
          checked={opts.high_dpi ?? true}
          onChange={(v) => update({ high_dpi: v ? undefined : false })}
        />

        {opts.high_dpi !== false && (
          <Field label="缩放上限(可选)" hint="限制单次会话的最大缩放百分比(如 200),防止超高分屏客户端拉高分辨率与带宽。留空不限制。">
            <Input
              className="h-8 w-28 text-xs font-mono"
              type="number"
              min={100}
              max={500}
              step={25}
              value={opts.max_scale ?? ""}
              placeholder="不限"
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                update({ max_scale: Number.isFinite(n) && n >= 100 ? n : undefined })
              }}
            />
          </Field>
        )}

        <Field label="键盘布局(可选)" hint="留空使用浏览器布局。常用:en-us / zh-cn / ja-jp。">
          <Input
            className="h-8 text-xs font-mono"
            value={opts.keyboard ?? ""}
            placeholder="en-us"
            onChange={(e) => update({ keyboard: e.target.value || undefined })}
          />
        </Field>

        <Separator />

        <SwitchField
          label="动态分辨率(跟随窗口)"
          description="浏览器窗口大小变化时,远端桌面分辨率实时跟随(DRDYNVC disp 通道),始终 1:1 无缩放模糊,VDI 体验最佳。需远端支持;默认关。会话内也可在「智能缩放」之间切换。"
          checked={opts.dynamic_resolution ?? false}
          onChange={(v) => update({ dynamic_resolution: v ? true : undefined })}
        />
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

          <Field
            label="GFX 编解码偏好"
            hint="位图路径的 RDPGFX 编解码倾向。AVC444 为 4:4:4 全彩(彩色文字最锐利):由服务器端 FreeRDP 解码后以无损/位图发给浏览器,无需浏览器支持、颜色正确,代价是服务器 CPU 解码 + 带宽略增。AVC420 单流(浏览器硬解);自动 = 当前行为。"
          >
            <Select
              value={opts.gfx_codec ?? "auto"}
              onValueChange={(v) =>
                update({
                  gfx_codec: v === "auto" ? undefined : (v as RdpProtoOptions["gfx_codec"]),
                })
              }
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto" className="text-xs">自动(H.264 / AVC420)</SelectItem>
                <SelectItem value="avc444" className="text-xs">AVC444 · 4:4:4 全彩(最锐利)</SelectItem>
                <SelectItem value="avc420" className="text-xs">AVC420 · 单流 H.264</SelectItem>
                <SelectItem value="rfx" className="text-xs">RemoteFX 渐进</SelectItem>
                <SelectItem value="nsc" className="text-xs">NSCodec</SelectItem>
                <SelectItem value="none" className="text-xs">不编码(Planar 表面)</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <SwitchField
            label="优先使用 AV1"
            description="可协商时优先走 AV1(Win11 24H2 主机透传 / 服务器软编),同画质比 H.264/VP9 更省流量;不可用时自动回退。浏览器 AV1 解码支持仍不均,默认关。"
            checked={opts.prefer_av1 ?? false}
            onChange={(v) => update({ prefer_av1: v ? true : undefined })}
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
        <Group title="网络预设(VDI 带宽档位)" icon={<Gauge className="h-3.5 w-3.5" />}>
          <Field
            label="链路档位"
            hint="一键套用一组带宽/画质默认(颜色深度、批量压缩、连接类型、视觉简化)。下方及其他标签页里任何手动项都会覆盖预设;选「手动」则完全按逐项设置。"
          >
            <Select
              value={opts.network_preset ?? "manual"}
              onValueChange={(v) =>
                update({
                  network_preset:
                    v === "manual" ? undefined : (v as RdpProtoOptions["network_preset"]),
                })
              }
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="manual" className="text-xs">手动(不套预设)</SelectItem>
                <SelectItem value="lan" className="text-xs">局域网 / 专线 · 满画质</SelectItem>
                <SelectItem value="broadband" className="text-xs">宽带 · 均衡</SelectItem>
                <SelectItem value="wan" className="text-xs">广域网 · 省流量</SelectItem>
                <SelectItem value="mobile" className="text-xs">移动 / 弱网 · 极致省流量</SelectItem>
                <SelectItem value="auto" className="text-xs">自动 · 满画质 + ABR 自适应</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field
            label="连接类型(高级覆盖)"
            hint="RDP CONNECTION_TYPE 提示,影响远端自身的画质/编解码取舍。留空跟随预设/默认(Broadband Low)。"
          >
            <Select
              value={opts.connection_type ? String(opts.connection_type) : "auto"}
              onValueChange={(v) =>
                update({
                  connection_type:
                    v === "auto" ? undefined : (Number(v) as RdpProtoOptions["connection_type"]),
                })
              }
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="auto" className="text-xs">跟随预设 / 默认</SelectItem>
                <SelectItem value="1" className="text-xs">1 · Modem (56K)</SelectItem>
                <SelectItem value="2" className="text-xs">2 · Broadband Low</SelectItem>
                <SelectItem value="3" className="text-xs">3 · Satellite</SelectItem>
                <SelectItem value="4" className="text-xs">4 · Broadband High</SelectItem>
                <SelectItem value="5" className="text-xs">5 · WAN</SelectItem>
                <SelectItem value="6" className="text-xs">6 · LAN</SelectItem>
                <SelectItem value="7" className="text-xs">7 · Auto-Detect</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <SwitchField
            label="批量数据压缩 (MPPC / RDP6)"
            description="用 CPU 换带宽,压缩老式位图/缓存通道。WAN/移动值得开,局域网无意义,对已压缩的 GFX/H.264/VP9 路径无效。"
            checked={opts.bulk_compression ?? false}
            onChange={(v) => update({ bulk_compression: v ? true : undefined })}
          />

          {opts.bulk_compression && (
            <SliderField
              label="压缩级别"
              hint="0=RDP4(8K 窗口) 1=RDP5(64K) 2=RDP6 3=RDP6.1。越高压缩比越好,也越吃 CPU/内存。"
              min={0}
              max={3}
              step={1}
              value={opts.compression_level ?? 2}
              onChange={(v) => update({ compression_level: v as 0 | 1 | 2 | 3 })}
              format={(v) =>
                ["0 · RDP4 8K", "1 · RDP5 64K", "2 · RDP6", "3 · RDP6.1"][v] ?? String(v)
              }
            />
          )}
        </Group>

        <Separator />

        <SliderField
          label="TCP 连接超时"
          hint="到达不可达主机时多快返回错误。8s 适合公网。"
          min={3000}
          max={30000}
          step={1000}
          value={opts.tcp_connect_timeout_ms ?? 8000}
          onChange={(v) => update({ tcp_connect_timeout_ms: v })}
          format={(v) => `${(v / 1000).toFixed(0)} 秒`}
        />
        <SliderField
          label="TCP ACK 超时"
          hint="等待远端确认的上限,超时即判定链路异常。"
          min={3000}
          max={30000}
          step={1000}
          value={opts.tcp_ack_timeout_ms ?? 9000}
          onChange={(v) => update({ tcp_ack_timeout_ms: v })}
          format={(v) => `${(v / 1000).toFixed(0)} 秒`}
        />

        <Separator />

        <Group title="RD Gateway (微软远程桌面网关)" icon={<DoorOpen className="h-3.5 w-3.5" />}>
          <Field
            label="网关地址(留空 = 不启用)"
            hint="目标主机只能经微软 RD Gateway(MS-TSGU,HTTPS 隧道)访问时填写,如 rdgw.corp.com。留空则直连或走代理链。与代理链(跳板/SOCKS)相互独立。"
          >
            <Input
              className="h-8 text-xs"
              value={opts.gateway_host ?? ""}
              placeholder="rdgw.example.com"
              onChange={(e) => {
                const v = e.target.value
                if (!v) {
                  update({
                    gateway_host: undefined,
                    gateway_port: undefined,
                    gateway_domain: undefined,
                    gateway_use_same_credentials: undefined,
                    gateway_credential_id: undefined,
                    gateway_transport: undefined,
                  })
                } else {
                  update({ gateway_host: v })
                }
              }}
            />
          </Field>

          {gatewayOn && (
            <>
              {/* 连接路径可视化 — 让"经网关到达目标"一眼可见 */}
              <div className="rounded-md border border-dashed border-primary/30 bg-primary/[0.03] p-2.5">
                <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  连接路径
                </div>
                <div className="flex items-stretch gap-1">
                  <PathNode icon={<Monitor className="h-4 w-4" />} label="本地" sub="浏览器" />
                  <PathArrow label={transportLabel(opts.gateway_transport)} />
                  <PathNode
                    icon={<DoorOpen className="h-4 w-4" />}
                    label="RD Gateway"
                    sub={`${opts.gateway_host}:${opts.gateway_port ?? 443}`}
                    highlight
                  />
                  <PathArrow label="RDP" />
                  <PathNode icon={<Server className="h-4 w-4" />} label="目标主机" sub="经网关到达" />
                </div>
              </div>

              <Field label="网关端口" hint="RD Gateway 默认 443 (HTTPS)。">
                <Input
                  type="number"
                  className="h-8 w-28 text-xs"
                  value={opts.gateway_port ?? 443}
                  min={1}
                  max={65535}
                  onChange={(e) => update({ gateway_port: Number(e.target.value) || undefined })}
                />
              </Field>

              <Field
                label="传输方式"
                hint="auto:先 HTTP/WebSocket,失败回退 RPC;http:仅现代 WebSocket;rpc:仅旧版 RPC-over-HTTP(Server 2008/2012)。"
              >
                <Select
                  value={opts.gateway_transport ?? "auto"}
                  onValueChange={(v) => update({ gateway_transport: v as "auto" | "http" | "rpc" })}
                >
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" className="text-xs">自动 (HTTP → RPC)</SelectItem>
                    <SelectItem value="http" className="text-xs">仅 HTTP / WebSocket</SelectItem>
                    <SelectItem value="rpc" className="text-xs">仅 RPC-over-HTTP</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <SwitchField
                label="网关复用目标凭据"
                description="用连接目标的同一账号登录网关(企业 AD 单账号常见)。关闭则为网关单独指定凭据。"
                checked={useSameCreds}
                onChange={(v) => update({ gateway_use_same_credentials: v })}
              />

              {!useSameCreds && (
                <Field label="网关凭据" hint="为网关登录单独选一份密码凭据;密码经凭据系统加密保存,不写入节点 proto_options。">
                  {pwCreds.length === 0 ? (
                    <div className="rounded-md border border-dashed border-amber-500/40 bg-amber-500/5 px-2.5 py-2 text-[11px] text-amber-700 dark:text-amber-400">
                      暂无密码凭据。请先到「凭据管理」创建一份密码凭据,再回来选择;或开启上方「复用目标凭据」。
                    </div>
                  ) : (
                    <Select
                      value={opts.gateway_credential_id ? String(opts.gateway_credential_id) : ""}
                      onValueChange={(v) => update({ gateway_credential_id: v ? Number(v) : undefined })}
                    >
                      <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="选择密码凭据" /></SelectTrigger>
                      <SelectContent>
                        {pwCreds.map((c) => (
                          <SelectItem key={c.id} value={String(c.id)} className="text-xs">
                            {c.name}{c.username ? ` (${c.username})` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              )}

              <Field label="网关域(可选)" hint="网关鉴权用的 AD 域,留空沿用目标域。">
                <Input
                  className="h-8 text-xs"
                  value={opts.gateway_domain ?? ""}
                  placeholder="CORP"
                  onChange={(e) => update({ gateway_domain: e.target.value || undefined })}
                />
              </Field>
            </>
          )}
        </Group>
      </TabsContent>
      </Tabs>
    </div>
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

function SliderField({
  label,
  hint,
  min,
  max,
  step,
  value,
  onChange,
  format,
}: {
  label: string
  hint?: string
  min: number
  max: number
  step: number
  value: number
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs">{label}</Label>
        <span className="font-mono text-[11px] tabular-nums rounded bg-muted px-1.5 py-0.5 text-foreground/80">
          {format ? format(value) : value}
        </span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(vals) => onChange(vals[0] ?? value)}
      />
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

function transportLabel(t?: string): string {
  switch (t) {
    case "http":
      return "WebSocket"
    case "rpc":
      return "RPC/HTTP"
    default:
      return "HTTPS 隧道"
  }
}

function PathNode({
  icon,
  label,
  sub,
  highlight,
}: {
  icon: React.ReactNode
  label: string
  sub: string
  highlight?: boolean
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-md border px-1.5 py-1.5 text-center",
        highlight
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border/60 bg-background/60 text-muted-foreground",
      )}
    >
      <span className={highlight ? "text-primary" : ""}>{icon}</span>
      <span className="text-[10px] font-medium leading-none">{label}</span>
      <span className="max-w-full truncate text-[9px] leading-none opacity-70" title={sub}>
        {sub}
      </span>
    </div>
  )
}

function PathArrow({ label }: { label: string }) {
  return (
    <div className="flex shrink-0 flex-col items-center justify-center gap-0.5 px-0.5">
      <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/50" />
      <span className="text-[8px] leading-none text-muted-foreground/60">{label}</span>
    </div>
  )
}

function Group({
  title,
  icon,
  children,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="space-y-2.5">
      <h4 className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {icon}
        {title}
      </h4>
      <div className="space-y-2.5">{children}</div>
    </section>
  )
}
