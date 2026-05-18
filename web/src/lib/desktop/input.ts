// Plan 17 input capture. Attaches Mouse / Keyboard handlers to a host
// element and converts events into ClientMessage payloads suited for
// FreeRDP's keysym + button-mask wire format (already what guacd used,
// so the existing libfreerdp client paths in M2 will accept them).
//
// Coordinate mapping: events fire in CSS-pixel host space. We convert to
// remote pixels by dividing by the current scale factor (canvas width /
// host width). The caller passes a `getScale()` so this module never
// needs to peek at the canvas style itself.

import {
  MOUSE_BUTTON_LEFT,
  MOUSE_BUTTON_MIDDLE,
  MOUSE_BUTTON_RIGHT,
  type ClientMessage,
} from "./types"

export interface InputDeps {
  host: HTMLElement
  send(msg: ClientMessage): void
  // Returns the current canvas → host ratio (so a 640px-wide canvas
  // shown in a 1280px host returns 0.5).
  getScale(): { x: number; y: number }
}

export function attachInputs(deps: InputDeps): () => void {
  const host = deps.host
  let pressedButtons = 0

  function toRemote(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = host.getBoundingClientRect()
    const sx = deps.getScale().x || 1
    const sy = deps.getScale().y || 1
    return {
      x: Math.round((e.clientX - rect.left) / sx),
      y: Math.round((e.clientY - rect.top) / sy),
    }
  }

  function buttonMask(button: number): number {
    if (button === 0) return MOUSE_BUTTON_LEFT
    if (button === 1) return MOUSE_BUTTON_MIDDLE
    if (button === 2) return MOUSE_BUTTON_RIGHT
    return 0
  }

  const onMove = (e: MouseEvent) => {
    const { x, y } = toRemote(e)
    deps.send({ mouse: { x, y, buttons: pressedButtons, wheel: 0 } })
  }
  const onDown = (e: MouseEvent) => {
    pressedButtons |= buttonMask(e.button)
    const { x, y } = toRemote(e)
    deps.send({ mouse: { x, y, buttons: pressedButtons, wheel: 0 } })
    e.preventDefault()
  }
  const onUp = (e: MouseEvent) => {
    pressedButtons &= ~buttonMask(e.button)
    const { x, y } = toRemote(e)
    deps.send({ mouse: { x, y, buttons: pressedButtons, wheel: 0 } })
  }
  const onWheel = (e: WheelEvent) => {
    const { x, y } = toRemote(e)
    deps.send({ mouse: { x, y, buttons: pressedButtons, wheel: e.deltaY > 0 ? -1 : 1 } })
    e.preventDefault()
  }
  const onContext = (e: MouseEvent) => e.preventDefault()
  const onKeyDown = (e: KeyboardEvent) => {
    const ks = keysymForEvent(e)
    if (ks > 0) {
      deps.send({ key: { keysym: ks, pressed: true } })
      e.preventDefault()
    }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    const ks = keysymForEvent(e)
    if (ks > 0) {
      deps.send({ key: { keysym: ks, pressed: false } })
      e.preventDefault()
    }
  }

  host.addEventListener("mousemove", onMove)
  host.addEventListener("mousedown", onDown)
  host.addEventListener("mouseup", onUp)
  host.addEventListener("wheel", onWheel, { passive: false })
  host.addEventListener("contextmenu", onContext)
  // Keyboard binds to window so it works even when focus drifted to a
  // toolbar button. We early-out if the active element is an <input>.
  window.addEventListener("keydown", onKeyDown)
  window.addEventListener("keyup", onKeyUp)

  return () => {
    host.removeEventListener("mousemove", onMove)
    host.removeEventListener("mousedown", onDown)
    host.removeEventListener("mouseup", onUp)
    host.removeEventListener("wheel", onWheel)
    host.removeEventListener("contextmenu", onContext)
    window.removeEventListener("keydown", onKeyDown)
    window.removeEventListener("keyup", onKeyUp)
  }
}

// Minimal X11 keysym translation. Covers printable ASCII + the common
// editing keys. Full coverage (function keys, NumLock variants, locale-
// specific dead keys) is Plan 17 M4 follow-up.
function keysymForEvent(e: KeyboardEvent): number {
  // Skip when a UI input is focused so the desktop doesn't steal the
  // user's typing into form fields.
  const active = document.activeElement
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) {
    if (!(active as HTMLElement).hasAttribute("data-desktop-passthrough")) {
      return 0
    }
  }
  // Single character keys (letters, digits, punctuation).
  if (e.key.length === 1) {
    const code = e.key.charCodeAt(0)
    if (code >= 0x20 && code <= 0x7e) return code
  }
  switch (e.key) {
    case "Backspace": return 0xff08
    case "Tab":       return 0xff09
    case "Enter":     return 0xff0d
    case "Escape":    return 0xff1b
    case "Delete":    return 0xffff
    case "Insert":    return 0xff63
    case "Home":      return 0xff50
    case "End":       return 0xff57
    case "PageUp":    return 0xff55
    case "PageDown":  return 0xff56
    case "ArrowLeft": return 0xff51
    case "ArrowUp":   return 0xff52
    case "ArrowRight":return 0xff53
    case "ArrowDown": return 0xff54
    case "Shift":     return 0xffe1
    case "Control":   return 0xffe3
    case "Alt":       return 0xffe9
    case "Meta":      return 0xffeb
    case "F1": return 0xffbe
    case "F2": return 0xffbf
    case "F3": return 0xffc0
    case "F4": return 0xffc1
    case "F5": return 0xffc2
    case "F6": return 0xffc3
    case "F7": return 0xffc4
    case "F8": return 0xffc5
    case "F9": return 0xffc6
    case "F10":return 0xffc7
    case "F11":return 0xffc8
    case "F12":return 0xffc9
  }
  return 0
}
