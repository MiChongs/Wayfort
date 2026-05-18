// X11 keysym table for KeyboardEvent → wire-format conversion.
//
// The protocol uses X11 keysyms (the same set Guacamole / xrdp / FreeRDP
// consume), so this table mirrors /usr/include/X11/keysymdef.h. Coverage:
//   - Printable ASCII (0x20-0x7E) — sent as the code-point itself
//   - F1-F24
//   - Numpad (KP_0-9, KP_Decimal, KP_Add/Subtract/Multiply/Divide, KP_Enter)
//   - Editing keys (Backspace / Tab / Enter / Escape / Delete / Insert)
//   - Navigation (Home / End / PgUp / PgDn / arrows)
//   - Lock keys (CapsLock / NumLock / ScrollLock)
//   - Modifiers (Shift / Control / Alt / Meta — split L/R)
//   - System keys (Print / Pause / Menu)
//   - Browser keys (Forward / Back / Refresh / Stop)

const KEYSYM: Record<string, number> = {
  // Editing
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Return: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,

  // Navigation
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,

  // Modifiers (browsers emit only "Shift" / "Control" / "Alt" / "Meta",
  // not the L/R variants — pick the L sym since that's the more common
  // physical key)
  Shift: 0xffe1,
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  Control: 0xffe3,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  Alt: 0xffe9,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  Meta: 0xffeb,
  MetaLeft: 0xffeb,
  MetaRight: 0xffec,
  OS: 0xffeb,
  ContextMenu: 0xff67,
  AltGraph: 0xfe03,

  // Locks
  CapsLock: 0xffe5,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,

  // System
  PrintScreen: 0xff61,
  Pause: 0xff13,
  Help: 0xff6a,
  Cancel: 0xff69,

  // Function keys
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
  F13: 0xffca,
  F14: 0xffcb,
  F15: 0xffcc,
  F16: 0xffcd,
  F17: 0xffce,
  F18: 0xffcf,
  F19: 0xffd0,
  F20: 0xffd1,
  F21: 0xffd2,
  F22: 0xffd3,
  F23: 0xffd4,
  F24: 0xffd5,

  // Numpad (KeyboardEvent.code form so the table can match either key
  // or code — see lookupKey below)
  Numpad0: 0xffb0,
  Numpad1: 0xffb1,
  Numpad2: 0xffb2,
  Numpad3: 0xffb3,
  Numpad4: 0xffb4,
  Numpad5: 0xffb5,
  Numpad6: 0xffb6,
  Numpad7: 0xffb7,
  Numpad8: 0xffb8,
  Numpad9: 0xffb9,
  NumpadDecimal: 0xffae,
  NumpadAdd: 0xffab,
  NumpadSubtract: 0xffad,
  NumpadMultiply: 0xffaa,
  NumpadDivide: 0xffaf,
  NumpadEnter: 0xff8d,
  NumpadEqual: 0xffbd,

  // Browser keys
  BrowserBack: 0x1008ff26,
  BrowserForward: 0x1008ff27,
  BrowserRefresh: 0x1008ff29,
  BrowserStop: 0x1008ff28,
  BrowserSearch: 0x1008ff1b,
  BrowserHome: 0x1008ff18,

  // Media keys
  AudioVolumeMute: 0x1008ff12,
  AudioVolumeDown: 0x1008ff11,
  AudioVolumeUp: 0x1008ff13,
  MediaPlayPause: 0x1008ff14,
  MediaStop: 0x1008ff15,
  MediaTrackPrevious: 0x1008ff16,
  MediaTrackNext: 0x1008ff17,
}

export interface KeysymLookupOptions {
  // When the user is typing into a real <input> / <textarea>, we don't
  // want the desktop to also see the keys. The caller passes the focused
  // element; we return 0 unless it's tagged opt-in.
  activeElement?: Element | null
}

// keysymForEvent converts a KeyboardEvent to an X11 keysym, returning 0
// when the event should NOT be forwarded (focused input, composition in
// progress, modifier-only key without an explicit binding).
export function keysymForEvent(e: KeyboardEvent, opts: KeysymLookupOptions = {}): number {
  // IME composition: skip everything until the composition resolves into
  // a real text event. The composition `event.key === "Process"` and
  // `event.isComposing` cases both happen mid-typing.
  if (e.isComposing || e.key === "Process") return 0

  const active = opts.activeElement
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || (active as HTMLElement).isContentEditable)) {
    if (!(active as HTMLElement).hasAttribute("data-desktop-passthrough")) {
      return 0
    }
  }

  // Numpad keys use `event.code` (Numpad7) rather than `event.key`
  // (which is the digit "7"), because numlock-off makes key="Home"
  // which would collide with the navigation Home. Prefer code first.
  if (e.code && KEYSYM[e.code]) return KEYSYM[e.code]
  if (KEYSYM[e.key]) return KEYSYM[e.key]

  // Single printable character → its ASCII / Latin-1 code-point. For
  // characters outside Latin-1, X11 keysyms use UCS-encoded form
  // (0x01000000 | codepoint).
  if (e.key.length === 1) {
    const cp = e.key.codePointAt(0) ?? 0
    if (cp >= 0x20 && cp <= 0xff) return cp
    if (cp > 0xff) return 0x01000000 | cp
  }
  return 0
}

// keyTypeForCombo turns a "Ctrl+Alt+Del"-style spec into an ordered list
// of [keysym, pressed] frames suitable for the menu's "send combo"
// buttons. Press in order, then release in reverse. Caller iterates and
// sends each frame to the worker.
export function expandCombo(combo: string): Array<{ keysym: number; pressed: boolean }> {
  const tokens = combo.split("+").map((t) => t.trim())
  const symbols: number[] = []
  for (const tok of tokens) {
    if (KEYSYM[tok]) {
      symbols.push(KEYSYM[tok])
      continue
    }
    if (tok.length === 1) {
      symbols.push(tok.charCodeAt(0))
      continue
    }
    return [] // unknown token — refuse rather than send partial sequence
  }
  const frames: Array<{ keysym: number; pressed: boolean }> = []
  for (const s of symbols) frames.push({ keysym: s, pressed: true })
  for (let i = symbols.length - 1; i >= 0; i--) frames.push({ keysym: symbols[i], pressed: false })
  return frames
}

export const PRESET_COMBOS: ReadonlyArray<{ label: string; combo: string; hint?: string }> = [
  { label: "Ctrl + Alt + Del", combo: "Control+Alt+Delete", hint: "锁屏 / 切换用户" },
  { label: "Ctrl + Alt + End", combo: "Control+Alt+End", hint: "远端 Ctrl+Alt+Del 替代" },
  { label: "Alt + Tab", combo: "Alt+Tab", hint: "切换窗口" },
  { label: "Alt + F4", combo: "Alt+F4", hint: "关闭窗口" },
  { label: "Ctrl + Shift + Esc", combo: "Control+Shift+Escape", hint: "任务管理器" },
  { label: "Win + L", combo: "Meta+l", hint: "锁屏" },
  { label: "Win + D", combo: "Meta+d", hint: "显示桌面" },
  { label: "Win + E", combo: "Meta+e", hint: "资源管理器" },
  { label: "Win + R", combo: "Meta+r", hint: "运行..." },
  { label: "PrintScreen", combo: "PrintScreen", hint: "截图" },
]
