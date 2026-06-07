"use client"

import * as React from "react"
import { Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { OfficeConfigResponse } from "@/lib/api/services"

export type { OfficeConfigResponse }

declare global {
  interface Window {
    DocsAPI?: {
      DocEditor: new (id: string, config: Record<string, unknown>) => { destroyEditor?: () => void }
    }
  }
}

const loaded = new Set<string>()

function loadDocsApi(src: string): Promise<void> {
  if (loaded.has(src) && window.DocsAPI) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-onlyoffice="${src}"]`)
    if (existing && window.DocsAPI) {
      resolve()
      return
    }
    const s = document.createElement("script")
    s.src = src
    s.async = true
    s.dataset.onlyoffice = src
    s.onload = () => {
      loaded.add(src)
      resolve()
    }
    s.onerror = () => reject(new Error("无法加载文档服务器脚本"))
    document.body.appendChild(s)
  })
}

// Mounts an OnlyOffice Document Server editor. The full editor config (document
// url, callback url, signing token, permissions) is built and JWT-signed by the
// backend; this component only loads the Document Server's api.js and hands it
// the config. Saves flow back through the backend callback, not the browser.
export function OfficeEditor({
  config,
  name,
  onClose,
}: {
  config: OfficeConfigResponse
  name: string
  onClose: () => void
}) {
  const [err, setErr] = React.useState<string | null>(null)
  const [ready, setReady] = React.useState(false)
  const editorRef = React.useRef<{ destroyEditor?: () => void } | null>(null)
  const elId = React.useId().replace(/:/g, "_")

  React.useEffect(() => {
    let cancelled = false
    const base = config.document_server_url.replace(/\/$/, "")
    const apiUrl = `${base}/web-apps/apps/api/documents/api.js`

    loadDocsApi(apiUrl)
      .then(() => {
        if (cancelled) return
        if (!window.DocsAPI) {
          setErr("文档服务器未就绪")
          return
        }
        try {
          editorRef.current = new window.DocsAPI.DocEditor(elId, {
            ...config.config,
            width: "100%",
            height: "100%",
            events: {
              onAppReady: () => setReady(true),
              onRequestClose: onClose,
              onError: () => setErr("文档服务器返回错误"),
            },
          })
        } catch (e) {
          setErr((e as Error).message || "初始化编辑器失败")
        }
      })
      .catch((e) => !cancelled && setErr((e as Error).message))

    return () => {
      cancelled = true
      try {
        editorRef.current?.destroyEditor?.()
      } catch {
        /* editor already torn down */
      }
    }
  }, [config, elId, onClose])

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <span className="truncate text-sm font-medium">{config.config.document?.title || name}</span>
        {!ready && !err && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在打开文档…
          </span>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          <X className="h-3.5 w-3.5" /> 关闭
        </Button>
      </div>
      {err ? (
        <div className="grid flex-1 place-items-center p-8 text-center text-sm text-destructive">{err}</div>
      ) : (
        <div id={elId} className="min-h-0 flex-1" />
      )}
    </div>
  )
}
