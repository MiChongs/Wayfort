"use client"

import * as React from "react"
import { Loader2, Save, X } from "lucide-react"
import { toast } from "@/components/ui/sonner"
import { Button } from "@/components/ui/button"

// Full layer-based editing via an embedded Photopea instance. The image is read
// same-origin as an ArrayBuffer and handed to Photopea over postMessage (no CORS
// fetch of internal URLs); the export comes back the same way and is written to
// the origin store. Photopea itself loads from photopea.com — this path needs
// outbound network and is the user-acknowledged data-egress option.
export function PhotopeaEditor({
  src,
  name,
  onClose,
  onSave,
}: {
  src: string
  name: string
  onClose: () => void
  onSave: (blob: Blob, name: string) => Promise<void>
}) {
  const iframeRef = React.useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const savingRef = React.useRef(false)
  const loadedRef = React.useRef(false)

  React.useEffect(() => {
    const handler = async (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return
      const data = e.data

      // Export result arrives as binary.
      if (data instanceof ArrayBuffer) {
        if (!savingRef.current) return
        savingRef.current = false
        try {
          await onSave(new Blob([data], { type: "image/png" }), name)
          toast.success("已保存回原位置")
          onClose()
        } catch (err) {
          toast.error("保存失败", { description: (err as Error).message })
        } finally {
          setSaving(false)
        }
        return
      }

      // Any string ("done") signals the editor is alive — load the image once.
      if (typeof data === "string" && !loadedRef.current) {
        loadedRef.current = true
        setReady(true)
        try {
          const buf = await (await fetch(src)).arrayBuffer()
          iframeRef.current?.contentWindow?.postMessage(buf, "*")
        } catch {
          toast.error("无法把图片加载到 Photopea")
        }
      }
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [src, name, onClose, onSave])

  const doSave = () => {
    if (saving || !ready) return
    setSaving(true)
    savingRef.current = true
    iframeRef.current?.contentWindow?.postMessage('app.activeDocument.saveToOE("png");', "*")
  }

  const config = encodeURIComponent(
    JSON.stringify({ environment: { theme: "dark", lang: "zh", menus: [[true]] } }),
  )

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <span className="truncate text-sm font-medium">Photopea · {name}</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">完整图层编辑 · 由 photopea.com 提供</span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" onClick={doSave} disabled={!ready || saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            保存回原位置
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-3.5 w-3.5" /> 关闭
          </Button>
        </div>
      </div>
      {!ready && (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在连接 Photopea（需要外网访问）…
        </div>
      )}
      <iframe
        ref={iframeRef}
        src={`https://www.photopea.com#${config}`}
        className="min-h-0 flex-1 border-0"
        title="Photopea"
        allow="fullscreen"
      />
    </div>
  )
}
