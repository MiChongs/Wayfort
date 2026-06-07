// Shared types used across the terminal sub-components. Lives in its own
// file so subcomponents don't import from the main webssh-terminal.tsx
// (which would create a circular dep through the toolbar/sheet/etc).

export type Status = "connecting" | "open" | "reconnecting" | "closed" | "error"

export interface SearchOptions {
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
}
