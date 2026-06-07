"use client"

import * as React from "react"
import { useMutation } from "@tanstack/react-query"
import { Check, Cloud, Loader2, Search } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ossService } from "@/lib/api/services"
import { fmtBytes } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { OssBucket, OssProvider } from "@/lib/api/types"

type OssOpts = {
  provider: OssProvider
  endpoint: string
  region: string
  bucket: string
  path_style?: boolean
  insecure_tls?: boolean
}

const PROVIDERS: {
  value: OssProvider
  label: string
  endpointHint: string
  regionHint: string
  endpointRequired: boolean
}[] = [
  {
    value: "aliyun",
    label: "阿里云 OSS",
    endpointHint: "oss-cn-hangzhou.aliyuncs.com",
    regionHint: "cn-hangzhou（可留空，由 endpoint 推断）",
    endpointRequired: true,
  },
  {
    value: "tencent",
    label: "腾讯云 COS",
    endpointHint: "（按地域自动，无需填写）",
    regionHint: "ap-guangzhou（必填）",
    endpointRequired: false,
  },
  {
    value: "s3",
    label: "AWS S3 / MinIO / 兼容",
    endpointHint: "https://s3.amazonaws.com 或自建地址",
    regionHint: "us-east-1（MinIO 可填任意值）",
    endpointRequired: true,
  },
]

function parse(value: string): OssOpts {
  try {
    const env = JSON.parse(value || "{}") as { oss?: OssOpts } & Partial<OssOpts>
    const o = env.oss ?? (env as OssOpts)
    return {
      provider: (o.provider as OssProvider) || "aliyun",
      endpoint: o.endpoint || "",
      region: o.region || "",
      bucket: o.bucket || "",
      path_style: o.path_style,
      insecure_tls: o.insecure_tls,
    }
  } catch {
    return { provider: "aliyun", endpoint: "", region: "", bucket: "" }
  }
}

// OssOptionsForm — the humanized "add OSS node" sub-form: pick provider, enter
// endpoint/region, then "test & discover" to visually pick a default bucket.
// Serialises into Node.proto_options ({"oss":{...}}) and lifts host/region/port
// so the parent node form's required fields are satisfied automatically.
export function OssOptionsForm({
  value,
  credentialId,
  proxyChain,
  onChange,
}: {
  value: string
  credentialId?: number
  proxyChain?: string
  onChange: (next: { proto_options: string; host: string; region: string; port: number }) => void
}) {
  const opts = React.useMemo(() => parse(value), [value])
  const meta = PROVIDERS.find((p) => p.value === opts.provider) ?? PROVIDERS[0]
  const [discovered, setDiscovered] = React.useState<OssBucket[] | null>(null)

  const emit = (next: OssOpts) => {
    const proto = JSON.stringify({ oss: next })
    const host = next.endpoint || next.region || next.provider
    onChange({ proto_options: proto, host, region: next.region, port: 443 })
  }
  const set = (patch: Partial<OssOpts>) => emit({ ...opts, ...patch })

  const discover = useMutation({
    mutationFn: () => {
      if (!credentialId) throw new Error("请先在上方「认证」选择访问密钥凭据")
      return ossService.discover({
        provider: opts.provider,
        endpoint: opts.endpoint || undefined,
        region: opts.region || undefined,
        credential_id: credentialId,
        proxy_chain: proxyChain || undefined,
        insecure_tls: opts.insecure_tls,
        path_style: opts.path_style,
      })
    },
    onSuccess: (d) => {
      setDiscovered(d.buckets ?? [])
      toast.success(`连接成功，发现 ${d.buckets?.length ?? 0} 个 Bucket`)
    },
    onError: (e: unknown) => toast.error("连接失败", { description: (e as Error).message }),
  })

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">服务商</Label>
          <Select value={opts.provider} onValueChange={(v) => set({ provider: v as OssProvider })}>
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">区域 Region</Label>
          <Input
            value={opts.region}
            onChange={(e) => set({ region: e.target.value })}
            placeholder={meta.regionHint}
            className="h-9"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">
          Endpoint {meta.endpointRequired ? <span className="text-destructive">*</span> : "（可选）"}
        </Label>
        <Input
          value={opts.endpoint}
          onChange={(e) => set({ endpoint: e.target.value })}
          placeholder={meta.endpointHint}
          className="h-9 font-mono text-xs"
        />
      </div>

      {opts.provider === "s3" && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg bg-muted/40 px-3 py-2">
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Switch checked={!!opts.path_style} onCheckedChange={(v) => set({ path_style: v })} />
            Path-style 寻址（MinIO / Ceph）
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <Switch checked={!!opts.insecure_tls} onCheckedChange={(v) => set({ insecure_tls: v })} />
            跳过 TLS 校验（自签证书）
          </label>
        </div>
      )}

      {/* Discover */}
      <div className="rounded-lg border border-border bg-card p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            选好凭据后，测试连通性并列出可访问的 Bucket，点击即可设为默认入口。
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={discover.isPending}
            onClick={() => discover.mutate()}
          >
            {discover.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            测试并发现
          </Button>
        </div>

        {discovered && (
          <div className="mt-3 max-h-44 space-y-1 overflow-y-auto">
            {discovered.length === 0 ? (
              <div className="py-4 text-center text-xs text-muted-foreground">未发现 Bucket（凭据可能无列举权限）</div>
            ) : (
              discovered.map((b) => {
                const active = b.name === opts.bucket
                return (
                  <button
                    key={b.name}
                    type="button"
                    onClick={() => set({ bucket: b.name, region: opts.region || b.region || "" })}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      active ? "bg-primary/[0.08] ring-1 ring-primary/30" : "hover:bg-accent/60",
                    )}
                  >
                    <Cloud className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate">{b.name}</span>
                    {b.region && <span className="shrink-0 text-[11px] text-muted-foreground">{b.region}</span>}
                    {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
                  </button>
                )
              })
            )}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">默认 Bucket（入口）</Label>
        <Input
          value={opts.bucket}
          onChange={(e) => set({ bucket: e.target.value })}
          placeholder="可在上方发现后点击选择，或手动填写"
          className="h-9 font-mono text-xs"
        />
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        提示：节点 = 一套访问密钥 + Endpoint/Region，工作区里可浏览该账号下<b>所有</b> Bucket；默认 Bucket 只是打开时的入口。
        授权请到「访问策略」按节点授予 connect / download / upload。
      </p>
    </div>
  )
}
