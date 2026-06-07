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

// ─────────────────────────────────────────────────────────────────────────
// Physical-key → RDP scancode (IBM PC AT set-1 make codes).
//
// Scancodes are the ONLY way modifier shortcuts (Ctrl+C, Alt+Tab, Win+L, …)
// work: the server composes them against the keyboard state, exactly like a real
// keyboard. Unicode keyboard events (used for plain text / IME) inject a
// character and DON'T register as a key press, so they can't form combos.
//
// We key off `event.code` (physical position, e.g. "KeyA" / "Digit1"), which is
// layout-independent — the server's keyboard layout (FreeRDP_KeyboardLayout,
// from the keyboardLayout setting) turns the scancode into the right character.
// Bit 0x100 flags an "extended" (0xE0-prefixed) key; scancodeForCode() unpacks
// it into the base code + extended flag the worker's wSendScancode expects.
// Values match cmd/freerdp-worker/rdp/keysym.go.
const EXT = 0x100
const CODE_TO_SCANCODE: Record<string, number> = {
  Escape: 0x01,
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,
  Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15,
  KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19,
  BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c,
  ControlLeft: 0x1d,
  KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23,
  KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  ShiftLeft: 0x2a, Backslash: 0x2b,
  KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32,
  Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36,
  NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a,
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40,
  F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46,
  Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a,
  Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e,
  Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
  IntlBackslash: 0x56, F11: 0x57, F12: 0x58,
  // JP / intl extras
  IntlYen: 0x7d, IntlRo: 0x73, Convert: 0x79, NonConvert: 0x7b, KanaMode: 0x70,
  // Extended (0xE0) keys
  NumpadEnter: 0x1c | EXT, ControlRight: 0x1d | EXT, NumpadDivide: 0x35 | EXT,
  AltRight: 0x38 | EXT,
  Home: 0x47 | EXT, ArrowUp: 0x48 | EXT, PageUp: 0x49 | EXT,
  ArrowLeft: 0x4b | EXT, ArrowRight: 0x4d | EXT,
  End: 0x4f | EXT, ArrowDown: 0x50 | EXT, PageDown: 0x51 | EXT,
  Insert: 0x52 | EXT, Delete: 0x53 | EXT,
  MetaLeft: 0x5b | EXT, MetaRight: 0x5c | EXT, ContextMenu: 0x5d | EXT,
  PrintScreen: 0x37 | EXT,
  // Common multimedia / browser keys (extended)
  BrowserSearch: 0x65 | EXT, BrowserHome: 0x32 | EXT, BrowserBack: 0x6a | EXT,
  BrowserForward: 0x69 | EXT, BrowserStop: 0x68 | EXT, BrowserRefresh: 0x67 | EXT,
  AudioVolumeMute: 0x20 | EXT, AudioVolumeDown: 0x2e | EXT, AudioVolumeUp: 0x30 | EXT,
  MediaPlayPause: 0x22 | EXT, MediaStop: 0x24 | EXT,
  MediaTrackPrevious: 0x10 | EXT, MediaTrackNext: 0x19 | EXT,
}

export interface Scancode {
  scancode: number
  extended: boolean
}

// scancodeForCode resolves a KeyboardEvent.code to an RDP scancode + extended
// flag, or null when the physical key isn't in the table (caller falls back to
// the keysym/Unicode path).
export function scancodeForCode(code: string | undefined): Scancode | null {
  if (!code) return null
  const v = CODE_TO_SCANCODE[code]
  if (v === undefined) return null
  return { scancode: v & 0xff, extended: (v & EXT) !== 0 }
}

// tokenToScancode maps a combo token ("Control", "Alt", "Delete", "l", "F4", …)
// to a scancode by routing it through the physical-key table. Used by the
// toolbar / palette "send combo" buttons so those shortcuts compose correctly.
function tokenToScancode(token: string): Scancode | null {
  const code = COMBO_TOKEN_TO_CODE[token] ?? tokenToCodeGuess(token)
  return scancodeForCode(code)
}

const COMBO_TOKEN_TO_CODE: Record<string, string> = {
  Control: "ControlLeft", Ctrl: "ControlLeft",
  Alt: "AltLeft", AltGr: "AltRight",
  Shift: "ShiftLeft",
  Meta: "MetaLeft", Win: "MetaLeft", Super: "MetaLeft", Command: "MetaLeft",
  Delete: "Delete", Del: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Escape: "Escape", Esc: "Escape", Tab: "Tab", Enter: "Enter", Return: "Enter",
  Space: "Space", Backspace: "Backspace", PrintScreen: "PrintScreen",
  ContextMenu: "ContextMenu",
  ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
  Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight",
}

function tokenToCodeGuess(token: string): string | undefined {
  if (token.startsWith("F") && /^F\d{1,2}$/.test(token)) return token // F1..F12
  if (token.length === 1) {
    const c = token.toUpperCase()
    if (c >= "A" && c <= "Z") return `Key${c}`
    if (c >= "0" && c <= "9") return `Digit${c}`
  }
  return undefined
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
  // IME composition: skip everything until the composition resolves into a real
  // text event (delivered separately via compositionend → ClientMessage.text).
  // `isComposing` covers mid-composition keys; `key === "Process"` and the
  // legacy `keyCode === 229` catch the very FIRST composition keydown (where
  // isComposing is still false) across Chrome / Firefox / Safari — without this
  // the first pinyin letter leaks to the remote and preventDefault would block
  // the IME from starting.
  if (e.isComposing || e.key === "Process" || e.keyCode === 229) return 0

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

// expandCombo turns a "Ctrl+Alt+Del"-style spec into an ordered list of
// scancode frames for the menu's "send combo" buttons. Scancodes (not keysyms)
// so modifier combos actually compose on the server — Win+L, Ctrl+Shift+Esc,
// Alt+F4 etc. Press in order, then release in reverse. Returns [] (refuse) if
// any token can't resolve, so we never send a half combo that leaves a modifier
// stuck down.
export interface ComboFrame {
  scancode: number
  extended: boolean
  pressed: boolean
}
export function expandCombo(combo: string): ComboFrame[] {
  const tokens = combo.split("+").map((t) => t.trim()).filter(Boolean)
  const keys: Scancode[] = []
  for (const tok of tokens) {
    const sc = tokenToScancode(tok)
    if (!sc) return [] // unknown token — refuse rather than send a partial sequence
    keys.push(sc)
  }
  const frames: ComboFrame[] = []
  for (const k of keys) frames.push({ scancode: k.scancode, extended: k.extended, pressed: true })
  for (let i = keys.length - 1; i >= 0; i--) {
    frames.push({ scancode: keys[i].scancode, extended: keys[i].extended, pressed: false })
  }
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
