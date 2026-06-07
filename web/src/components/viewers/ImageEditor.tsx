"use client"

import * as React from "react"
import FilerobotImageEditor, { TABS, TOOLS } from "react-filerobot-image-editor"
import { toast } from "@/components/ui/sonner"

// In-browser raster editor (filerobot). The image is fetched same-origin, every
// edit happens on-canvas, and the export is streamed straight back to the
// origin store via onSave — nothing leaves the network. onBeforeSave returns
// false to bypass filerobot's own "save as" download dialog.
export function ImageEditor({
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
  const savingRef = React.useRef(false)

  return (
    <div className="fixed inset-0 z-50 bg-background">
      <FilerobotImageEditor
        source={src}
        onClose={onClose}
        onBeforeSave={() => false}
        onSave={async (edited: { imageBase64?: string; fullName?: string }) => {
          if (savingRef.current) return
          savingRef.current = true
          try {
            const dataUrl = edited.imageBase64
            if (!dataUrl) throw new Error("导出失败")
            const blob = await (await fetch(dataUrl)).blob()
            await onSave(blob, edited.fullName || name)
            toast.success("已保存回原位置")
            onClose()
          } catch (e) {
            toast.error("保存失败", { description: (e as Error).message })
          } finally {
            savingRef.current = false
          }
        }}
        tabsIds={[TABS.ADJUST, TABS.FINETUNE, TABS.FILTERS, TABS.ANNOTATE, TABS.WATERMARK, TABS.RESIZE]}
        defaultTabId={TABS.ADJUST}
        defaultToolId={TOOLS.CROP}
        savingPixelRatio={0}
        previewPixelRatio={0}
        annotationsCommon={{ fill: "#cc785c" }}
        Crop={{ presetsItems: [] }}
        theme={{
          palette: {
            "accent-primary": "#cc785c",
            "accent-primary-active": "#a9583e",
          },
        }}
      />
    </div>
  )
}
