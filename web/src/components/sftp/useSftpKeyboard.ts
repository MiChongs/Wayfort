import * as React from "react"

// Lightweight global key handler scoped to the SFTP page. We deliberately
// don't reach for react-hotkeys-hook here so we can early-bail when focus is
// inside an input / textarea / contenteditable — otherwise typing in the
// path bar would also delete files.
export type SftpKeyHandlers = {
  onOpen?: () => void
  onUp?: () => void
  onDelete?: () => void
  onRename?: () => void
  onSelectAll?: () => void
  onFocusPath?: () => void
  onEscape?: () => void
  onRefresh?: () => void
}

function isInteractive(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
  if (el.isContentEditable) return true
  return false
}

export function useSftpKeyboard(handlers: SftpKeyHandlers, enabled = true) {
  const handlersRef = React.useRef(handlers)
  handlersRef.current = handlers

  React.useEffect(() => {
    if (!enabled) return
    const onKey = (ev: KeyboardEvent) => {
      const h = handlersRef.current
      const inField = isInteractive(ev.target)
      // Esc and Ctrl+L (focus path) still work inside fields; everything else
      // requires the file table to have focus.
      if (ev.key === "Escape") {
        h.onEscape?.()
        return
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "l") {
        ev.preventDefault()
        h.onFocusPath?.()
        return
      }
      if (inField) return
      switch (ev.key) {
        case "Enter":
          h.onOpen?.()
          ev.preventDefault()
          break
        case "Backspace":
          h.onUp?.()
          ev.preventDefault()
          break
        case "Delete":
          h.onDelete?.()
          ev.preventDefault()
          break
        case "F2":
          h.onRename?.()
          ev.preventDefault()
          break
        case "F5":
          h.onRefresh?.()
          ev.preventDefault()
          break
        default:
          if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "a") {
            ev.preventDefault()
            h.onSelectAll?.()
          }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [enabled])
}
