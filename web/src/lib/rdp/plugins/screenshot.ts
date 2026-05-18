// ScreenshotPlugin — Plan 15.D.5. Captures the full Pixi stage (remote
// desktop + any annotation overlays) as a PNG. Two output paths:
//   • clipboard: writes a `image/png` ClipboardItem
//   • download: triggers a blob URL download
//
// The screenshot includes whatever is on the Pixi stage at the moment of
// capture — so annotations drawn by the user are baked in, which is exactly
// what users want for "share what I'm pointing at".

import type { RDPPlugin, RDPPluginContext } from "../types"

export interface ScreenshotResult {
  blob: Blob
  filename: string
}

export class ScreenshotPlugin implements RDPPlugin {
  readonly name = "screenshot"
  private ctx: RDPPluginContext | null = null
  private nodeName: string

  constructor(nodeName: string) {
    this.nodeName = nodeName || "remote"
  }

  init(ctx: RDPPluginContext): void {
    this.ctx = ctx
  }

  destroy(): void {
    this.ctx = null
  }

  async capture(): Promise<ScreenshotResult> {
    if (!this.ctx) throw new Error("screenshot plugin not initialised")
    const blob = await this.ctx.snapshot()
    const ts = new Date().toISOString().replace(/[:.]/g, "-")
    return { blob, filename: `${this.nodeName}-${ts}.png` }
  }

  async downloadCurrent(): Promise<void> {
    const { blob, filename } = await this.capture()
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    // Revoke after a tick — Chrome needs the URL alive long enough to start
    // the download. 1s is comfortable.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async copyToClipboard(): Promise<void> {
    const { blob } = await this.capture()
    // ClipboardItem requires HTTPS or localhost.
    type ClipItemCtor = new (items: Record<string, Blob>) => unknown
    const Item = (window as unknown as { ClipboardItem?: ClipItemCtor }).ClipboardItem
    if (!Item || !navigator.clipboard?.write) {
      throw new Error("剪贴板 API 不可用（需要 HTTPS）")
    }
    await navigator.clipboard.write([
      new Item({ "image/png": blob }) as unknown as ClipboardItem,
    ])
  }
}
