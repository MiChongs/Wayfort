// Maps X11 system cursor names (the value the server emits when it sends
// "use a built-in shape" instead of a bitmap) to CSS cursor keywords.
//
// Reference: /usr/include/X11/cursorfont.h. We also list the FreeRDP
// pointer-system names (default | progress | precision | text | …)
// because the worker may forward them as-is from SET_DEFAULT / SET_NULL
// PDU translation. ~95% of X11 shapes have a direct CSS equivalent;
// everything else falls back to "default".

const MAP: Record<string, string> = {
  // FreeRDP system cursors (Plan 17 M2 emits these)
  default: "default",
  pointer: "pointer",
  text: "text",
  wait: "wait",
  progress: "progress",
  crosshair: "crosshair",
  move: "move",
  "not-allowed": "not-allowed",
  grab: "grab",
  grabbing: "grabbing",
  help: "help",
  hidden: "none",

  // X11 cursorfont names (canonical lowercase form)
  arrow: "default",
  left_ptr: "default",
  top_left_arrow: "default",
  hand: "pointer",
  hand1: "pointer",
  hand2: "pointer",
  pointing_hand: "pointer",
  xterm: "text",
  ibeam: "text",
  watch: "wait",
  cross: "crosshair",
  crosshair_x: "crosshair",
  fleur: "move",
  size_all: "move",
  forbidden: "not-allowed",
  pirate: "not-allowed",
  question_arrow: "help",
  whats_this: "help",
  hand_open: "grab",
  hand_closed: "grabbing",

  // Resize cursors
  sb_h_double_arrow: "ew-resize",
  size_horizontal: "ew-resize",
  ew_resize: "ew-resize",
  sb_v_double_arrow: "ns-resize",
  size_vertical: "ns-resize",
  ns_resize: "ns-resize",
  size_fdiag: "nwse-resize",
  bottom_right_corner: "nwse-resize",
  top_left_corner: "nwse-resize",
  size_bdiag: "nesw-resize",
  bottom_left_corner: "nesw-resize",
  top_right_corner: "nesw-resize",
  bottom_side: "s-resize",
  top_side: "n-resize",
  left_side: "w-resize",
  right_side: "e-resize",

  // App-Starting / busy
  left_ptr_watch: "progress",
  app_starting: "progress",
}

// Resolve an X11 / FreeRDP system cursor name to a CSS cursor keyword.
// Returns "default" when the name is unknown — calling code can pass
// that straight to `element.style.cursor`.
export function x11CursorToCss(name: string | undefined | null): string {
  if (!name) return "default"
  const key = name.trim().toLowerCase().replace(/-/g, "_")
  return MAP[key] ?? MAP[name.toLowerCase()] ?? "default"
}

// Build the `cursor:` CSS value for a server-supplied bitmap cursor
// (data: URL with hotspot). Includes a "default" fallback per CSS spec
// so browsers that reject the URL still show a usable pointer.
export function bitmapCursorCss(pngBase64: string, hotspotX: number, hotspotY: number): string {
  return `url(data:image/png;base64,${pngBase64}) ${hotspotX} ${hotspotY}, default`
}
