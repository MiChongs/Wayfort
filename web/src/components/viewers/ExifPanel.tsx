"use client"

import * as React from "react"
import exifr from "exifr"
import {
  Aperture,
  Camera,
  Check,
  ChevronDown,
  Clock,
  Compass,
  Copy,
  FileJson,
  Gauge,
  ImageIcon,
  Loader2,
  MapPin,
  Maximize2,
  Palette,
  Ruler,
  Scan,
  Search,
  Sparkles,
  Timer,
  Wrench,
  X,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Input } from "@/components/ui/input"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import {
  buildSummary,
  decodeTag,
  extractGeo,
  fmtVal,
  humanizeKey,
  SEGMENTS,
  toPlainEntries,
  type Dict,
  type GeoFix,
  type Segments,
  type SummaryIcon,
  type SummaryRow,
} from "./exifFormat"

const SUMMARY_ICON: Record<SummaryIcon, React.ComponentType<{ className?: string }>> = {
  dimensions: Maximize2,
  camera: Camera,
  lens: Scan,
  aperture: Aperture,
  shutter: Timer,
  iso: Gauge,
  focal: Ruler,
  flash: Sparkles,
  orientation: ImageIcon,
  clock: Clock,
  location: MapPin,
  software: Wrench,
  color: Palette,
}

// The metadata drawer. Goal: surface *everything* exifr can read, not a curated
// subset — a decoded shot summary up top (exposure triangle, camera, where &
// when), the embedded thumbnail, a GPS card with a compass + map links, then
// every raw field grouped by segment with per-field copy, live search, and a
// one-click JSON export.
export function ExifPanel({ url, name, className }: { url: string; name?: string; className?: string }) {
  const [seg, setSeg] = React.useState<Segments | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [err, setErr] = React.useState<string | null>(null)
  const [thumb, setThumb] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState("")

  React.useEffect(() => {
    let cancelled = false
    let createdThumb: string | null = null
    setLoading(true)
    setErr(null)
    setSeg(null)
    setThumb(null)
    setQuery("")

    // exifr's bundled .d.ts types some segment flags as FormatOptions-only and
    // rejects the documented `ifd0: true` shorthand; cast to the parse signature
    // so we can request every segment. sanitize:false keeps MakerNote / binary
    // blobs that the default pass would drop — completeness over tidiness.
    const opts = {
      tiff: true, ifd0: true, ifd1: true, exif: true, gps: true, interop: true,
      iptc: true, xmp: true, icc: true, jfif: true, ihdr: true, makerNote: true, userComment: true,
      mergeOutput: false,
      translateKeys: true,
      translateValues: false,
      reviveValues: true,
      sanitize: false,
    } as unknown as Parameters<typeof exifr.parse>[1]

    exifr
      .parse(url, opts)
      .then((d) => {
        if (cancelled) return
        setSeg((d as Segments) || {})
        setLoading(false)
      })
      .catch((e) => {
        if (!cancelled) {
          setErr((e as Error)?.message || "无法解析元数据")
          setLoading(false)
        }
      })

    // Embedded preview (JPEG/TIFF carry one in IFD1) — best-effort, separate pass.
    exifr
      .thumbnailUrl(url)
      .then((u) => {
        if (cancelled || !u) return
        createdThumb = u
        setThumb(u)
      })
      .catch(() => {})

    return () => {
      cancelled = true
      if (createdThumb) URL.revokeObjectURL(createdThumb)
    }
  }, [url])

  const summary = React.useMemo(() => (seg ? buildSummary(seg) : []), [seg])
  const geo = React.useMemo(() => (seg ? extractGeo(seg.gps) : null), [seg])

  const present = React.useMemo(() => {
    if (!seg) return []
    const known = new Set(SEGMENTS.map((s) => s.key))
    const ordered = SEGMENTS.filter((s) => seg[s.key] && Object.keys(seg[s.key]).length > 0)
    const extra = Object.keys(seg)
      .filter((k) => !known.has(k) && seg[k] && typeof seg[k] === "object" && Object.keys(seg[k] as Dict).length > 0)
      .map((k) => ({ key: k, label: k }))
    return [...ordered, ...extra]
  }, [seg])

  const totalFields = React.useMemo(
    () => present.reduce((n, s) => n + Object.keys(seg?.[s.key] || {}).length, 0),
    [present, seg],
  )

  const copyAll = React.useCallback(() => {
    if (!seg) return
    const text = toPlainEntries(seg)
      .map((e) => `${e.segment} · ${e.key}: ${e.value}`)
      .join("\n")
    void navigator.clipboard.writeText(text).then(
      () => toast.success("已复制全部元数据"),
      () => toast.error("复制失败"),
    )
  }, [seg])

  const exportJson = React.useCallback(() => {
    if (!seg) return
    const flat: Record<string, Record<string, string>> = {}
    for (const s of present) {
      const fields = seg[s.key] as Dict
      flat[s.label] = Object.fromEntries(Object.entries(fields).map(([k, v]) => [humanizeKey(k), fmtVal(v)]))
    }
    const blob = new Blob([JSON.stringify(flat, null, 2)], { type: "application/json" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = `${(name || "image").replace(/\.[^.]+$/, "")}.exif.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [seg, present, name])

  const hasFields = !loading && !err && present.length > 0

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">元数据 · EXIF</h3>
          {hasFields && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
              {totalFields}
            </span>
          )}
        </div>
        {hasFields && (
          <div className="flex items-center gap-0.5">
            <IconAction label="复制全部" icon={Copy} onClick={copyAll} />
            <IconAction label="导出 JSON" icon={FileJson} onClick={exportJson} />
          </div>
        )}
      </div>

      {hasFields && (
        <div className="shrink-0 border-b px-3 py-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索字段…"
              className="h-8 pl-8 pr-7 text-xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-muted"
                aria-label="清除搜索"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 px-4 py-4">
          {loading ? (
            <LoadingState />
          ) : err ? (
            <p className="py-6 text-sm text-muted-foreground">读取失败：{err}</p>
          ) : present.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <ImageIcon className="h-8 w-8 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">这张图片没有可读取的元数据。</p>
            </div>
          ) : (
            <>
              {!query && summary.length > 0 && <SummaryBlock rows={summary} />}
              {!query && thumb && <ThumbnailBlock src={thumb} />}
              {!query && geo && <GeoBlock geo={geo} />}

              <div>
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {query ? "搜索结果" : "全部字段"}
                </p>
                <div className="space-y-2">
                  {present.map((s, i) => (
                    <Segment
                      key={s.key}
                      label={s.label}
                      fields={seg?.[s.key] as Dict}
                      query={query}
                      defaultOpen={!!query || (SEGMENTS.find((x) => x.key === s.key)?.open ?? i < 2)}
                    />
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

/* --------------------------------------------------------------- blocks -- */

function SummaryBlock({ rows }: { rows: SummaryRow[] }) {
  const find = (label: string) => rows.find((r) => r.label === label)
  const aperture = find("光圈")
  const shutter = find("快门")
  const iso = find("感光度")
  const triangle = [aperture, shutter, iso].filter(Boolean) as SummaryRow[]
  const rest = rows.filter((r) => !triangle.includes(r))

  return (
    <div className="space-y-3">
      {triangle.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {triangle.map((r) => {
            const Icon = SUMMARY_ICON[r.icon]
            return (
              <div
                key={r.label}
                className="flex flex-col items-center gap-1 rounded-xl border bg-muted/30 px-2 py-2.5 text-center"
              >
                <Icon className="h-3.5 w-3.5 text-primary/80" />
                <span className="truncate text-sm font-medium tabular-nums" title={r.value}>{r.value}</span>
                <span className="text-[10px] text-muted-foreground">{r.label}</span>
              </div>
            )
          })}
        </div>
      )}
      {rest.length > 0 && (
        <div className="grid grid-cols-1 gap-1.5 rounded-xl border bg-muted/30 p-3">
          {rest.map((r) => {
            const Icon = SUMMARY_ICON[r.icon]
            return (
              <div key={r.label} className="flex items-baseline gap-2 text-sm">
                <Icon className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-muted-foreground" />
                <span className="shrink-0 text-muted-foreground">{r.label}</span>
                <span className="ml-auto min-w-0 truncate text-right font-medium" title={r.value}>
                  {r.value}
                  {r.hint && <span className="ml-1 text-[11px] font-normal text-muted-foreground">{r.hint}</span>}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ThumbnailBlock({ src }: { src: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">内嵌缩略图</p>
      <div className="overflow-hidden rounded-xl border bg-[length:16px_16px] bg-[linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%),linear-gradient(45deg,rgba(0,0,0,0.04)_25%,transparent_25%,transparent_75%,rgba(0,0,0,0.04)_75%)] bg-[position:0_0,8px_8px]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="内嵌缩略图" className="mx-auto max-h-40 object-contain" />
      </div>
    </div>
  )
}

function GeoBlock({ geo }: { geo: GeoFix }) {
  const osm = `https://www.openstreetmap.org/?mlat=${geo.lat}&mlon=${geo.lng}#map=15/${geo.lat}/${geo.lng}`
  const gmap = `https://maps.google.com/?q=${geo.lat},${geo.lng}`
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">GPS 定位</p>
      <div className="flex items-stretch gap-3 rounded-xl border bg-muted/30 p-3">
        <Compass2 heading={geo.direction} />
        <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 text-xs">
          <div className="flex items-center gap-1.5 font-medium tabular-nums">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-primary/80" />
            <span className="truncate">{geo.lat}, {geo.lng}</span>
          </div>
          <span className="text-muted-foreground">{geo.latDMS} · {geo.lngDMS}</span>
          <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-muted-foreground">
            {geo.altitude != null && <span>海拔 {geo.altitude} m</span>}
            {geo.direction != null && <span>朝向 {Math.round(geo.direction)}°</span>}
            {geo.speed != null && <span>速度 {geo.speed}{geo.speedUnit ? ` ${geo.speedUnit}` : ""}</span>}
          </div>
          <div className="mt-1 flex gap-2">
            <a href={osm} target="_blank" rel="noreferrer" className="text-primary hover:underline">OpenStreetMap</a>
            <a href={gmap} target="_blank" rel="noreferrer" className="text-primary hover:underline">Google 地图</a>
          </div>
        </div>
      </div>
    </div>
  )
}

// A small offline compass rose — no map tiles needed on an isolated network.
// The needle points to the recorded image heading; absent, it shows due north.
function Compass2({ heading }: { heading: number | null }) {
  const deg = heading ?? 0
  return (
    <div className="relative grid h-16 w-16 shrink-0 place-items-center rounded-full border bg-background">
      <Compass className="absolute h-14 w-14 text-muted-foreground/20" />
      <div className="absolute inset-0" style={{ transform: `rotate(${deg}deg)` }}>
        <span className="absolute left-1/2 top-1.5 h-5 w-px -translate-x-1/2 bg-primary" />
        <span className="absolute left-1/2 top-1 h-0 w-0 -translate-x-1/2 border-x-[3px] border-b-[5px] border-x-transparent border-b-primary" />
      </div>
      <span className="absolute top-0.5 text-[8px] font-medium text-muted-foreground">N</span>
      <span className="text-[9px] font-medium tabular-nums text-foreground">{heading != null ? `${Math.round(deg)}°` : "—"}</span>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 读取元数据…
      </div>
      <div className="grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-muted/60" />
        ))}
      </div>
      <div className="h-24 animate-pulse rounded-xl bg-muted/40" />
    </div>
  )
}

/* -------------------------------------------------------------- segment -- */

function Segment({
  label,
  fields,
  query,
  defaultOpen,
}: {
  label: string
  fields: Dict
  query: string
  defaultOpen?: boolean
}) {
  const q = query.trim().toLowerCase()
  const entries = React.useMemo(() => {
    const all = Object.entries(fields || {})
    if (!q) return all
    return all.filter(([k, v]) => {
      const human = humanizeKey(k).toLowerCase()
      return human.includes(q) || k.toLowerCase().includes(q) || fmtVal(v).toLowerCase().includes(q)
    })
  }, [fields, q])

  if (entries.length === 0) return null

  return (
    <Collapsible defaultOpen={defaultOpen} className="overflow-hidden rounded-lg border">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 bg-muted/40 px-3 py-2 text-left text-xs font-medium transition-colors hover:bg-muted/60">
        <span className="flex items-center gap-2">
          {label}
          <span className="rounded-full bg-background px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
            {entries.length}
          </span>
        </span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="divide-y">
          {entries.map(([k, v]) => (
            <Field key={k} rawKey={k} value={v} />
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}

function Field({ rawKey, value }: { rawKey: string; value: unknown }) {
  const [copied, setCopied] = React.useState(false)
  const raw = fmtVal(value)
  const decoded = typeof value === "number" || rawKey === "ComponentsConfiguration" ? decodeTag(rawKey, value) : null

  const copy = () => {
    void navigator.clipboard.writeText(`${humanizeKey(rawKey)}: ${decoded ? `${decoded} (${raw})` : raw}`).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="group/field flex items-baseline gap-2 px-3 py-1.5 text-xs">
      <dt className="w-28 shrink-0 truncate text-muted-foreground" title={humanizeKey(rawKey)}>
        {humanizeKey(rawKey)}
      </dt>
      <dd className="min-w-0 flex-1 text-right">
        {decoded ? (
          <>
            <span className="font-medium" title={decoded}>{decoded}</span>
            <span className="ml-1 break-words text-[11px] text-muted-foreground" title={raw}>({raw})</span>
          </>
        ) : (
          <span className="break-words font-medium" title={raw}>{raw}</span>
        )}
      </dd>
      <button
        type="button"
        onClick={copy}
        aria-label="复制字段"
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-muted group-hover/field:opacity-100"
      >
        {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  )
}

function IconAction({
  label,
  icon: Icon,
  onClick,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}
