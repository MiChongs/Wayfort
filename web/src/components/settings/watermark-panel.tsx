"use client"

// Group-level extras for the 界面水印 settings section: a live WYSIWYG preview
// of the current (draft) policy and a blind-watermark forensic decoder. Both
// sit above the schema-driven field rows in the settings page.

import * as React from "react"
import { Droplets, ScanSearch, Sun, Moon, Upload, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { SettingField, WatermarkRuntime } from "@/lib/api/types"
import { mountWatermark, type WatermarkEngine, type Surface } from "@/components/watermark/engine"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"

function useFieldValues(fields: SettingField[], valueOf: (f: SettingField) => unknown) {
  return React.useMemo(() => {
    const byKey = new Map(fields.map((f) => [f.key, f]))
    const num = (k: string, d: number) => {
      const f = byKey.get(k)
      const n = Number(f ? valueOf(f) : NaN)
      return Number.isFinite(n) ? n : d
    }
    const str = (k: string, d: string) => {
      const f = byKey.get(k)
      const v = f ? valueOf(f) : undefined
      return typeof v === "string" && v.length > 0 ? v : d
    }
    const bool = (k: string, d: boolean) => {
      const f = byKey.get(k)
      const v = f ? valueOf(f) : undefined
      return typeof v === "boolean" ? v : d
    }
    return { num, str, bool }
    // valueOf changes identity when the draft changes — that's the signal we want.
  }, [fields, valueOf])
}

// Substitute sample identity tokens; leave {date}/{time}/{datetime} for the engine.
function sampleText(template: string): string {
  return template
    .replace(/\{username\}/g, "zhangsan")
    .replace(/\{name\}/g, "张三")
    .replace(/\{email\}/g, "z***@corp.com")
    .replace(/\{phone\}/g, "138****5678")
    .replace(/\{ip\}/g, "10.0.0.5")
}

export function WatermarkSettingsPanel({
  fields,
  valueOf,
}: {
  fields: SettingField[]
  valueOf: (f: SettingField) => unknown
}) {
  const { num, str, bool } = useFieldValues(fields, valueOf)
  const enabled = bool("watermark.enabled", true)

  const runtime: WatermarkRuntime = React.useMemo(
    () => ({
      enabled: true,
      scope: "all",
      text: sampleText(str("watermark.content", "{name}\n{email}\n{ip}  {datetime}")),
      style: {
        opacity: num("watermark.opacity", 16),
        fontSize: num("watermark.font_size", 15),
        color: str("watermark.font_color", "#141413"),
        rotation: num("watermark.rotation", -45),
        gapX: num("watermark.gap_x", 240),
        gapY: num("watermark.gap_y", 180),
      },
      blind: { enabled: false, text: "" },
      features: {
        antiTamper: false,
        hardened: false,
        liveClock: bool("watermark.live_clock", true),
        refreshSec: num("watermark.refresh_sec", 60),
      },
    }),
    [num, str, bool],
  )

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <PreviewCard runtime={runtime} disabled={!enabled} />
      <BlindDecodeTool />
    </div>
  )
}

function PreviewCard({ runtime, disabled }: { runtime: WatermarkRuntime; disabled: boolean }) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const [surface, setSurface] = React.useState<Surface>("light")
  const signature = JSON.stringify(runtime)

  // Debounce remounts so dragging a slider stays smooth — only rebuild ~120ms
  // after the value settles.
  const [settled, setSettled] = React.useState(signature)
  React.useEffect(() => {
    const t = window.setTimeout(() => setSettled(signature), 120)
    return () => window.clearTimeout(t)
  }, [signature])

  React.useEffect(() => {
    const el = ref.current
    if (!el || disabled) return
    let engine: WatermarkEngine | null = null
    let cancelled = false
    void mountWatermark(el, runtime, surface).then((e) => {
      if (cancelled) {
        e?.destroy()
        return
      }
      engine = e
    })
    return () => {
      cancelled = true
      engine?.destroy()
    }
    // `settled` (debounced signature) captures every visual field; surface
    // toggles light/dark. runtime is read fresh on each settled change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, surface, disabled])

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Droplets className="h-4 w-4 text-primary" /> 实时预览
        </div>
        <div className="inline-flex rounded-lg border border-border bg-secondary/50 p-0.5">
          {(
            [
              { v: "light" as const, icon: Sun, label: "浅色" },
              { v: "dark" as const, icon: Moon, label: "深色" },
            ]
          ).map(({ v, icon: Icon, label }) => (
            <button
              key={v}
              type="button"
              onClick={() => setSurface(v)}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                surface === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={ref}
        className={cn(
          "relative h-52 w-full overflow-hidden rounded-lg border border-border",
          surface === "dark" ? "bg-[#181715]" : "bg-[#faf9f5]",
        )}
      >
        {disabled && (
          <div className="absolute inset-0 z-[1] flex items-center justify-center text-xs text-muted-foreground">
            水印已关闭
          </div>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        示例身份（张三 / z***@corp.com / 10.0.0.5）。真实水印按登录用户与来源 IP 解析；时间实时刷新。
      </p>
    </div>
  )
}

function BlindDecodeTool() {
  const [decoded, setDecoded] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)

  const decode = React.useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("请拖入图片文件")
      return
    }
    setBusy(true)
    setDecoded(null)
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = () => reject(fr.error)
        fr.readAsDataURL(file)
      })
      const { BlindWatermark } = await import("watermark-js-plus")
      BlindWatermark.decode({
        url,
        onSuccess: (img: string) => {
          setDecoded(img)
          setBusy(false)
        },
      })
      // Safety net: decode is fire-and-forget; clear the spinner if the image
      // never loads (e.g. corrupt file).
      window.setTimeout(() => setBusy(false), 4000)
    } catch (e) {
      setBusy(false)
      toast.error("解码失败", { description: (e as { message?: string }).message })
    }
  }, [])

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ScanSearch className="h-4 w-4 text-primary" /> 盲水印取证
        </div>
        {decoded && (
          <Button variant="ghost" size="sm" onClick={() => setDecoded(null)}>
            <X className="h-3.5 w-3.5" /> 清除
          </Button>
        )}
      </div>

      {decoded ? (
        <div className="relative h-52 w-full overflow-hidden rounded-lg border border-border bg-[#181715]">
          {/* color-burn reveal — the embedded identity surfaces in the image */}
          <img src={decoded} alt="解码结果" className="h-full w-full object-contain" />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const f = e.dataTransfer.files?.[0]
            if (f) void decode(f)
          }}
          className={cn(
            "flex h-52 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-center transition-colors",
            dragging ? "border-primary bg-primary/5" : "border-border bg-secondary/30 hover:bg-secondary/50",
          )}
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-secondary text-muted-foreground">
            <Upload className="h-5 w-5" />
          </span>
          <span className="text-sm text-foreground">{busy ? "解码中…" : "拖入或点击上传截图"}</span>
          <span className="max-w-[16rem] text-xs text-muted-foreground">
            还原嵌入在截图中的隐写身份，定位泄密者
          </span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void decode(f)
          e.target.value = ""
        }}
      />
    </div>
  )
}
