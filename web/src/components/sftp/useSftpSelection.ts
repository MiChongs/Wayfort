import * as React from "react"
import type { SftpEntry } from "@/lib/api/services"

export type SelectionAction = "set" | "toggle" | "range"

// Stable selection across re-renders, keyed by entry path. Tracks lastIndex so
// shift-click extends from the previous anchor like in a typical file
// browser. The hook also exposes helpers for select-all / clear / batch info
// (count and total size) so the toolbar and status bar can read it cheaply.
export function useSftpSelection(entries: SftpEntry[]) {
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set())
  const [lastIndex, setLastIndex] = React.useState<number | null>(null)

  // Prune entries that disappeared (e.g. after refresh removed a path).
  React.useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev
      const present = new Set(entries.map((e) => e.path))
      let changed = false
      const next = new Set<string>()
      for (const p of prev) {
        if (present.has(p)) next.add(p)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [entries])

  const select = React.useCallback(
    (entry: SftpEntry, index: number, action: SelectionAction) => {
      setSelected((prev) => {
        const next = new Set(prev)
        switch (action) {
          case "set":
            next.clear()
            next.add(entry.path)
            break
          case "toggle":
            if (next.has(entry.path)) next.delete(entry.path)
            else next.add(entry.path)
            break
          case "range": {
            if (lastIndex == null) {
              next.add(entry.path)
            } else {
              const [from, to] = lastIndex < index ? [lastIndex, index] : [index, lastIndex]
              for (let i = from; i <= to; i++) next.add(entries[i].path)
            }
            break
          }
        }
        return next
      })
      if (action !== "range") setLastIndex(index)
    },
    [entries, lastIndex],
  )

  const clear = React.useCallback(() => {
    setSelected(new Set())
    setLastIndex(null)
  }, [])

  const selectAll = React.useCallback(() => {
    setSelected(new Set(entries.map((e) => e.path)))
  }, [entries])

  const isSelected = React.useCallback((p: string) => selected.has(p), [selected])

  const selectedEntries = React.useMemo(
    () => entries.filter((e) => selected.has(e.path)),
    [entries, selected],
  )

  const totalSize = React.useMemo(
    () => selectedEntries.reduce((s, e) => s + (e.is_dir ? 0 : e.size), 0),
    [selectedEntries],
  )

  return {
    selected,
    selectedEntries,
    count: selected.size,
    totalSize,
    select,
    clear,
    selectAll,
    isSelected,
  }
}
