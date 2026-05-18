// Curated set of xterm.js theme presets. Each preset is a complete xterm
// `ITheme` (background / foreground / cursor / 16 ANSI colors).
//
// The `system` entry is special — it resolves to `dark` or `light` based on
// the active app theme from next-themes (resolveTheme below).

export type TerminalThemeName =
  | "system"
  | "dark"
  | "light"
  | "vscode-dark"
  | "dracula"
  | "solarized-dark"
  | "solarized-light"
  | "nord"
  | "one-dark"
  | "tokyo-night"
  | "github-dark"
  | "monokai"

// Subset of xterm's ITheme — copied so we don't need a runtime import of
// the xterm types in non-terminal files (e.g. settings sheet).
export interface XtermTheme {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface TerminalThemePreset {
  name: TerminalThemeName
  display: string
  isDark: boolean
  colors: XtermTheme
}

const DARK: XtermTheme = {
  background: "#09090b",
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  cursorAccent: "#09090b",
  selectionBackground: "#3b82f680",
  black: "#0f0f10",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#d4d4d8",
  brightBlack: "#52525b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde68a",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
}

const LIGHT: XtermTheme = {
  background: "#ffffff",
  foreground: "#18181b",
  cursor: "#18181b",
  cursorAccent: "#ffffff",
  selectionBackground: "#3b82f640",
  black: "#27272a",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#a1a1aa",
  brightBlack: "#71717a",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#52525b",
}

const VSCODE_DARK: XtermTheme = {
  background: "#1e1e1e",
  foreground: "#cccccc",
  cursor: "#aeafad",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
}

const DRACULA: XtermTheme = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#f8f8f0",
  cursorAccent: "#282a36",
  selectionBackground: "#44475a",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
}

const SOLARIZED_DARK: XtermTheme = {
  background: "#002b36",
  foreground: "#839496",
  cursor: "#93a1a1",
  cursorAccent: "#002b36",
  selectionBackground: "#073642",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
}

const SOLARIZED_LIGHT: XtermTheme = {
  background: "#fdf6e3",
  foreground: "#657b83",
  cursor: "#586e75",
  cursorAccent: "#fdf6e3",
  selectionBackground: "#eee8d5",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#002b36",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
}

const NORD: XtermTheme = {
  background: "#2e3440",
  foreground: "#d8dee9",
  cursor: "#d8dee9",
  cursorAccent: "#2e3440",
  selectionBackground: "#434c5e",
  black: "#3b4252",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  magenta: "#b48ead",
  cyan: "#88c0d0",
  white: "#e5e9f0",
  brightBlack: "#4c566a",
  brightRed: "#bf616a",
  brightGreen: "#a3be8c",
  brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1",
  brightMagenta: "#b48ead",
  brightCyan: "#8fbcbb",
  brightWhite: "#eceff4",
}

const ONE_DARK: XtermTheme = {
  background: "#282c34",
  foreground: "#abb2bf",
  cursor: "#abb2bf",
  cursorAccent: "#282c34",
  selectionBackground: "#3e4451",
  black: "#1e2127",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
}

const TOKYO_NIGHT: XtermTheme = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  cursor: "#c0caf5",
  cursorAccent: "#1a1b26",
  selectionBackground: "#33467c",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#c0caf5",
}

const GITHUB_DARK: XtermTheme = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#c9d1d9",
  cursorAccent: "#0d1117",
  selectionBackground: "#1f6feb66",
  black: "#484f58",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#b1bac4",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
}

const MONOKAI: XtermTheme = {
  background: "#272822",
  foreground: "#f8f8f2",
  cursor: "#f8f8f0",
  cursorAccent: "#272822",
  selectionBackground: "#49483e",
  black: "#272822",
  red: "#f92672",
  green: "#a6e22e",
  yellow: "#f4bf75",
  blue: "#66d9ef",
  magenta: "#ae81ff",
  cyan: "#a1efe4",
  white: "#f8f8f2",
  brightBlack: "#75715e",
  brightRed: "#f92672",
  brightGreen: "#a6e22e",
  brightYellow: "#f4bf75",
  brightBlue: "#66d9ef",
  brightMagenta: "#ae81ff",
  brightCyan: "#a1efe4",
  brightWhite: "#f9f8f5",
}

export const TERMINAL_THEMES: Record<TerminalThemeName, TerminalThemePreset> = {
  system: { name: "system", display: "跟随系统", isDark: true, colors: DARK },
  dark: { name: "dark", display: "深色 (默认)", isDark: true, colors: DARK },
  light: { name: "light", display: "浅色 (默认)", isDark: false, colors: LIGHT },
  "vscode-dark": { name: "vscode-dark", display: "VS Code Dark+", isDark: true, colors: VSCODE_DARK },
  dracula: { name: "dracula", display: "Dracula", isDark: true, colors: DRACULA },
  "solarized-dark": { name: "solarized-dark", display: "Solarized Dark", isDark: true, colors: SOLARIZED_DARK },
  "solarized-light": { name: "solarized-light", display: "Solarized Light", isDark: false, colors: SOLARIZED_LIGHT },
  nord: { name: "nord", display: "Nord", isDark: true, colors: NORD },
  "one-dark": { name: "one-dark", display: "One Dark", isDark: true, colors: ONE_DARK },
  "tokyo-night": { name: "tokyo-night", display: "Tokyo Night", isDark: true, colors: TOKYO_NIGHT },
  "github-dark": { name: "github-dark", display: "GitHub Dark", isDark: true, colors: GITHUB_DARK },
  monokai: { name: "monokai", display: "Monokai", isDark: true, colors: MONOKAI },
}

// Ordered list for UI rendering (Select / RadioGroup).
export const TERMINAL_THEME_ORDER: TerminalThemeName[] = [
  "system",
  "dark",
  "light",
  "vscode-dark",
  "dracula",
  "solarized-dark",
  "solarized-light",
  "nord",
  "one-dark",
  "tokyo-night",
  "github-dark",
  "monokai",
]

// Resolves the theme name into the actual color palette. `system` reads the
// current `dark`/`light` state from next-themes and picks accordingly.
export function resolveTerminalTheme(name: TerminalThemeName, sysIsDark: boolean): TerminalThemePreset {
  if (name !== "system") return TERMINAL_THEMES[name]
  return TERMINAL_THEMES[sysIsDark ? "dark" : "light"]
}
