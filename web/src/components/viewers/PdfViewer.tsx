"use client"

import * as React from "react"
import { Document, Page, pdfjs } from "react-pdf"
import "react-pdf/dist/Page/AnnotationLayer.css"
import "react-pdf/dist/Page/TextLayer.css"
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RotateCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

// pdf.js worker is served from /public so it loads same-origin (no CDN — the
// bastion runs air-gapped). cMaps + standard fonts live under /pdf for proper
// CJK / embedded-font rendering.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs"

const PDF_OPTIONS = {
  cMapUrl: "/pdf/cmaps/",
  cMapPacked: true,
  standardFontDataUrl: "/pdf/standard_fonts/",
}

export function PdfViewer({ url, onDownload }: { url: string; onDownload?: () => void }) {
  const [numPages, setNumPages] = React.useState(0)
  const [page, setPage] = React.useState(1)
  const [pageInput, setPageInput] = React.useState("1")
  const [scale, setScale] = React.useState(1.1)
  const [rotate, setRotate] = React.useState(0)
  const [error, setError] = React.useState<string | null>(null)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  const file = React.useMemo(() => ({ url }), [url])

  const goTo = (p: number) => {
    const clamped = Math.min(Math.max(1, p), numPages || 1)
    setPage(clamped)
    setPageInput(String(clamped))
    scrollRef.current?.scrollTo({ top: 0 })
  }
  React.useEffect(() => setPageInput(String(page)), [page])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center gap-1 border-b bg-card px-3 py-1.5">
        <Button size="icon" variant="ghost" className="h-8 w-8" disabled={page <= 1} onClick={() => goTo(page - 1)} aria-label="上一页">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="flex items-center gap-1 text-sm">
          <Input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter") goTo(Number(pageInput) || 1)
            }}
            onBlur={() => goTo(Number(pageInput) || 1)}
            className="h-8 w-12 text-center text-sm"
            aria-label="页码"
          />
          <span className="text-muted-foreground">/ {numPages || "…"}</span>
        </div>
        <Button size="icon" variant="ghost" className="h-8 w-8" disabled={page >= numPages} onClick={() => goTo(page + 1)} aria-label="下一页">
          <ChevronRight className="h-4 w-4" />
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button size="icon" variant="ghost" className="h-8 w-8" disabled={scale <= 0.5} onClick={() => setScale((s) => Math.max(0.5, +(s - 0.15).toFixed(2)))} aria-label="缩小">
          <Minus className="h-4 w-4" />
        </Button>
        <span className="w-12 text-center text-xs tabular-nums text-muted-foreground">{Math.round(scale * 100)}%</span>
        <Button size="icon" variant="ghost" className="h-8 w-8" disabled={scale >= 3} onClick={() => setScale((s) => Math.min(3, +(s + 0.15).toFixed(2)))} aria-label="放大">
          <Plus className="h-4 w-4" />
        </Button>
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setScale(1.1)} aria-label="适应">
          <Maximize2 className="h-4 w-4" />
        </Button>

        <Separator orientation="vertical" className="mx-1 h-5" />

        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setRotate((r) => (r + 90) % 360)} aria-label="旋转">
          <RotateCw className="h-4 w-4" />
        </Button>

        <div className="ml-auto">
          {onDownload && (
            <Button size="sm" variant="outline" className="h-8" onClick={onDownload}>
              <Download className="h-3.5 w-3.5" /> 下载
            </Button>
          )}
        </div>
      </div>

      {/* Canvas */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-muted/40 p-4">
        {error ? (
          <div className="grid h-full place-items-center text-sm text-destructive">{error}</div>
        ) : (
          <Document
            file={file}
            options={PDF_OPTIONS}
            onLoadSuccess={({ numPages: n }) => {
              setNumPages(n)
              setError(null)
            }}
            onLoadError={(e) => setError(e.message || "无法打开 PDF")}
            loading={
              <div className="grid h-full place-items-center py-20 text-sm text-muted-foreground">
                <span className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> 正在解析 PDF…
                </span>
              </div>
            }
            error={<div className="py-20 text-center text-sm text-destructive">无法打开 PDF</div>}
            className="flex justify-center"
          >
            <div className={cn("overflow-hidden rounded-md shadow-lg ring-1 ring-border")}>
              <Page
                pageNumber={page}
                scale={scale}
                rotate={rotate}
                renderTextLayer
                renderAnnotationLayer
                loading={
                  <div className="grid place-items-center py-20">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                }
              />
            </div>
          </Document>
        )}
      </div>
    </div>
  )
}
