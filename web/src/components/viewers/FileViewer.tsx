"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import { Loader2, Download, ImageOff, Sparkles, Layers } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { isPaintableImage, isRasterEditable, viewerKind } from "./viewerKind"
import type { LightboxSlide } from "./ImageLightbox"
import type { OfficeConfigResponse } from "@/lib/api/services"
import type { MediaItem } from "./MediaViewer"

// Heavy, DOM-bound viewers load client-only.
const ImageLightbox = dynamic(() => import("./ImageLightbox").then((m) => m.ImageLightbox), { ssr: false })
const PdfViewer = dynamic(() => import("./PdfViewer").then((m) => m.PdfViewer), { ssr: false })
const MediaViewer = dynamic(() => import("./MediaViewer").then((m) => m.MediaViewer), { ssr: false })
const ImageEditor = dynamic(() => import("./ImageEditor").then((m) => m.ImageEditor), { ssr: false })
const PhotopeaEditor = dynamic(() => import("./PhotopeaEditor").then((m) => m.PhotopeaEditor), { ssr: false })
const OfficeEditor = dynamic(() => import("./OfficeEditor").then((m) => m.OfficeEditor), { ssr: false })

export type ViewerFile = { name: string; url: string; size?: number; ref?: string }

/** True when FileViewer owns this file type (vs. text/unknown, left to caller). */
export function isViewerSupported(name: string): boolean {
  const k = viewerKind(name)
  return k === "image" || k === "pdf" || k === "office" || k === "video" || k === "audio"
}

type EditMode = "choose" | "filerobot" | "photopea"

export function FileViewer({
  open,
  file,
  gallery,
  mediaGallery,
  onClose,
  onDownload,
  onSaveImage,
  loadOfficeConfig,
}: {
  open: boolean
  file: ViewerFile | null
  /** Sibling images for left/right gallery navigation; defaults to [file]. */
  gallery?: ViewerFile[]
  /** Sibling video/audio for the media playlist; defaults to [file]. */
  mediaGallery?: ViewerFile[]
  onClose: () => void
  onDownload?: (file: ViewerFile) => void
  /** Save an edited raster back to origin. Omit → editors are hidden. */
  onSaveImage?: (file: ViewerFile, blob: Blob, name: string) => Promise<void>
  /** Resolve an OnlyOffice editor config. Omit → office files offer download only. */
  loadOfficeConfig?: (file: ViewerFile) => Promise<OfficeConfigResponse>
}) {
  const kind = file ? viewerKind(file.name) : "unknown"
  const [edit, setEdit] = React.useState<{ file: ViewerFile; mode: EditMode } | null>(null)
  const [imgIndex, setImgIndex] = React.useState(0)

  const slides: LightboxSlide[] = React.useMemo(() => {
    const list = gallery && gallery.length ? gallery : file ? [file] : []
    return list.map((f) => ({ src: f.url, name: f.name, exifUrl: f.url, ref: f.ref, size: f.size }))
  }, [gallery, file])

  const startIndex = React.useMemo(() => {
    if (!file) return 0
    const i = slides.findIndex((s) => s.src === file.url)
    return i >= 0 ? i : 0
  }, [slides, file])

  React.useEffect(() => {
    if (open) setImgIndex(startIndex)
  }, [open, startIndex])

  const mediaPlaylist = React.useMemo<MediaItem[] | undefined>(() => {
    if (!mediaGallery || mediaGallery.length === 0) return undefined
    return mediaGallery.map((f) => ({
      name: f.name,
      url: f.url,
      kind: viewerKind(f.name) === "audio" ? "audio" : "video",
      size: f.size,
    }))
  }, [mediaGallery])
  const mediaIndex = React.useMemo(() => {
    if (!mediaGallery || !file) return 0
    const i = mediaGallery.findIndex((f) => f.url === file.url)
    return i >= 0 ? i : 0
  }, [mediaGallery, file])

  if (!open || !file) return null

  const slideToFile = (s: LightboxSlide): ViewerFile => ({ name: s.name, url: s.src, ref: s.ref })

  return (
    <>
      {/* IMAGE — lightbox; hidden while an editor is up so it doesn't fight z-index */}
      {kind === "image" && (
        isPaintableImage(file.name) ? (
          <ImageLightbox
            open={!edit}
            slides={slides}
            index={imgIndex}
            onClose={onClose}
            onIndexChange={setImgIndex}
            onDownload={onDownload ? (s) => onDownload(slideToFile(s)) : undefined}
            onEdit={
              onSaveImage && isRasterEditable(file.name)
                ? (s) => setEdit({ file: slideToFile(s), mode: "choose" })
                : undefined
            }
          />
        ) : (
          <OpaqueImageDialog file={file} onClose={onClose} onDownload={onDownload} />
        )
      )}

      {/* PDF */}
      {kind === "pdf" && (
        <ViewerDialog title={file.name} onClose={onClose}>
          <PdfViewer url={file.url} onDownload={onDownload ? () => onDownload(file) : undefined} />
        </ViewerDialog>
      )}

      {/* VIDEO / AUDIO */}
      {(kind === "video" || kind === "audio") && (
        <ViewerDialog title={file.name} onClose={onClose} bare>
          <MediaViewer
            url={file.url}
            name={file.name}
            kind={kind}
            playlist={mediaPlaylist}
            index={mediaIndex}
            onDownload={onDownload ? (m) => onDownload(mediaGallery?.find((g) => g.url === m.url) || file) : undefined}
          />
        </ViewerDialog>
      )}

      {/* OFFICE */}
      {kind === "office" && (
        <OfficeHost file={file} onClose={onClose} onDownload={onDownload} loadOfficeConfig={loadOfficeConfig} />
      )}

      {/* IMAGE EDITORS (overlay) */}
      {edit?.mode === "choose" && (
        <EditorChoice
          onPick={(mode) => setEdit({ file: edit.file, mode })}
          onCancel={() => setEdit(null)}
        />
      )}
      {edit?.mode === "filerobot" && onSaveImage && (
        <ImageEditor
          src={edit.file.url}
          name={edit.file.name}
          onClose={() => setEdit(null)}
          onSave={(blob, name) => onSaveImage(edit.file, blob, name)}
        />
      )}
      {edit?.mode === "photopea" && onSaveImage && (
        <PhotopeaEditor
          src={edit.file.url}
          name={edit.file.name}
          onClose={() => setEdit(null)}
          onSave={(blob, name) => onSaveImage(edit.file, blob, name)}
        />
      )}
    </>
  )
}

function ViewerDialog({
  title,
  onClose,
  children,
  bare,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  bare?: boolean
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] w-[min(1200px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className={cn("shrink-0 border-b px-4 py-2.5", bare && "sr-only")}>
          <DialogTitle className="truncate text-sm">{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1">{children}</div>
      </DialogContent>
    </Dialog>
  )
}

function OpaqueImageDialog({
  file,
  onClose,
  onDownload,
}: {
  file: ViewerFile
  onClose: () => void
  onDownload?: (f: ViewerFile) => void
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate">{file.name}</DialogTitle>
          <DialogDescription>这种图片格式浏览器无法直接显示，下载后用本地工具查看。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-4">
          <ImageOff className="h-10 w-10 text-muted-foreground/40" />
          {onDownload && (
            <Button onClick={() => onDownload(file)}>
              <Download className="h-4 w-4" /> 下载到本地
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function EditorChoice({
  onPick,
  onCancel,
}: {
  onPick: (mode: "filerobot" | "photopea") => void
  onCancel: () => void
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>选择编辑方式</DialogTitle>
          <DialogDescription>两种都能把结果存回原位置，区别在能力与数据走向。</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 pt-1">
          <button
            type="button"
            onClick={() => onPick("filerobot")}
            className="flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition-colors hover:border-primary hover:bg-accent/40"
          >
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/12 text-primary">
              <Sparkles className="h-4 w-4" />
            </span>
            <span className="text-sm font-medium">快速编辑</span>
            <span className="text-xs text-muted-foreground">裁剪 / 滤镜 / 标注 / 水印，全程在内网</span>
          </button>
          <button
            type="button"
            onClick={() => onPick("photopea")}
            className="flex flex-col items-start gap-1.5 rounded-xl border p-4 text-left transition-colors hover:border-primary hover:bg-accent/40"
          >
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/12 text-primary">
              <Layers className="h-4 w-4" />
            </span>
            <span className="text-sm font-medium">完整编辑</span>
            <span className="text-xs text-muted-foreground">图层 / 蒙版 / 滤镜库，需外网（Photopea）</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function OfficeHost({
  file,
  onClose,
  onDownload,
  loadOfficeConfig,
}: {
  file: ViewerFile
  onClose: () => void
  onDownload?: (f: ViewerFile) => void
  loadOfficeConfig?: (file: ViewerFile) => Promise<OfficeConfigResponse>
}) {
  const [config, setConfig] = React.useState<OfficeConfigResponse | null>(null)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!loadOfficeConfig) {
      setErr("unavailable")
      return
    }
    let cancelled = false
    loadOfficeConfig(file)
      .then((c) => !cancelled && setConfig(c))
      .catch((e) => !cancelled && setErr((e as Error)?.message || "无法打开文档"))
    return () => {
      cancelled = true
    }
  }, [file, loadOfficeConfig])

  if (config) return <OfficeEditor config={config} name={file.name} onClose={onClose} />

  if (err) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="truncate">{file.name}</DialogTitle>
            <DialogDescription>
              {err === "unavailable"
                ? "尚未配置在线文档服务器，暂时只能下载后用本地 Office 打开。"
                : `打开失败：${err}`}
            </DialogDescription>
          </DialogHeader>
          {onDownload && (
            <div className="flex justify-center pt-2">
              <Button onClick={() => onDownload(file)}>
                <Download className="h-4 w-4" /> 下载到本地
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/80">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> 正在准备文档…
      </span>
    </div>
  )
}
