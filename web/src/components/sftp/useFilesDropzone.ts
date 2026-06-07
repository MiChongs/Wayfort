import * as React from "react"

// Tracks an OS file-drag over a region and surfaces the dropped File[]. Depth
// counting keeps the overlay stable as the pointer crosses child elements.
// Internal entry moves carry a custom MIME type and are ignored here.
export function useFilesDropzone(onFiles: (files: File[]) => void) {
  const [dragFiles, setDragFiles] = React.useState(false)
  const depth = React.useRef(0)
  const onFilesRef = React.useRef(onFiles)
  onFilesRef.current = onFiles

  const dropProps = React.useMemo(
    () => ({
      onDragEnter: (e: React.DragEvent) => {
        if (!e.dataTransfer?.types.includes("Files")) return
        depth.current++
        setDragFiles(true)
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setDragFiles(false)
      },
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer?.types.includes("Files")) e.preventDefault()
      },
      onDrop: (e: React.DragEvent) => {
        if (!e.dataTransfer?.types.includes("Files")) return
        e.preventDefault()
        depth.current = 0
        setDragFiles(false)
        const files = Array.from(e.dataTransfer.files || [])
        if (files.length) onFilesRef.current(files)
      },
    }),
    [],
  )

  return { dragFiles, dropProps }
}
