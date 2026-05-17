"use client"

import * as React from "react"
import { toast } from "sonner"
import { connectGuacamole } from "@/lib/ws/guacamole-client"

export function GuacamoleDisplay({ protocol, nodeId }: { protocol: "rdp" | "vnc"; nodeId: number }) {
  const ref = React.useRef<HTMLDivElement | null>(null)
  const [status, setStatus] = React.useState<"connecting" | "open" | "closed">("connecting")

  React.useEffect(() => {
    let disposed = false
    let handle: { disconnect(): void } | undefined
    ;(async () => {
      try {
        const el = ref.current!
        const w = Math.max(800, el.clientWidth)
        const h = Math.max(600, el.clientHeight)
        handle = await connectGuacamole({
          protocol, nodeId, container: el, width: w, height: h,
          onStateChange: (s) => {
            // 3 = connected (per guacamole STATE codes)
            if (s === 3) setStatus("open")
            else if (s === 5) setStatus("closed")
          },
          onError: (m) => toast.error("远程桌面错误", { description: m }),
        })
        if (disposed) handle.disconnect()
      } catch (e: unknown) {
        toast.error("无法加载 Guacamole 客户端", { description: String(e) })
      }
    })()
    return () => {
      disposed = true
      handle?.disconnect()
    }
  }, [protocol, nodeId])

  return (
    <div className="relative h-full w-full bg-black overflow-auto">
      {status === "connecting" && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-400">正在连接远程桌面…</div>
      )}
      <div ref={ref} className="h-full w-full" />
    </div>
  )
}
