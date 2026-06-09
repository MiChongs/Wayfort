"use client"

import * as React from "react"
import { createRenderer, type CanvasRendererHandle } from "@/lib/desktop/canvas-renderer"
import { FrameClient } from "@/lib/desktop/frame-client"

// DesktopMonitor renders a read-only canvas fed by the desktop observe WS. It
// reuses the production decode/render pipeline (createRenderer + FrameClient),
// pointed at /ws/observe/desktop/:id, and never sends input — the server painted
// a full refresh on join so the canvas fills immediately.
export function DesktopMonitor({
  sessionId,
  onClosed,
}: {
  sessionId: string
  onClosed?: (reason: string) => void
}) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let renderer: CanvasRendererHandle | null = createRenderer(1280, 720)
    host.appendChild(renderer.canvas)

    const client = new FrameClient({
      sessionId,
      wsPath: `/ws/observe/desktop/${sessionId}`,
      onFrame: (f) => renderer?.paintFrame(f),
      onFrameBytes: (f, payload) => renderer?.paintFrameBytes(f, payload),
      onFrameBatch: (frames) => renderer?.paintFrameBatchBytes(frames),
      onCursor: (c) => renderer?.emitCursor(c),
      onStatus: (st) => {
        if (st.phase === "CLOSED" || st.phase === "ERROR") {
          onClosed?.(st.message || "会话已结束")
        }
      },
      onError: (msg) => onClosed?.(msg),
    })
    client.connect()

    return () => {
      client.close()
      renderer?.destroy()
      if (renderer?.canvas.parentNode === host) host.removeChild(renderer.canvas)
      renderer = null
    }
  }, [sessionId, onClosed])

  return (
    <div
      ref={hostRef}
      className="grid h-full w-full place-items-center overflow-auto bg-black p-2"
    />
  )
}
