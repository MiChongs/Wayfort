"use client"

import * as React from "react"
import { useHotkeys } from "react-hotkeys-hook"
import { useWorkspaceStore } from "./useWorkspaceStore"

type Props = {
  onNewTab: () => void
}

// Centralises every workspace-scoped hotkey. Lives at the root of the
// workspace tree so it's mounted exactly once. We let the hotkeys fire even
// from inside form fields (terminal inputs, search boxes) because users
// expect Ctrl+T / Ctrl+W to always work like in a browser.
export function WorkspaceShortcuts({ onNewTab }: Props) {
  const close = useWorkspaceStore((s) => s.close)
  const activeId = useWorkspaceStore((s) => s.activeId)
  const cycleTab = useWorkspaceStore((s) => s.cycleTab)
  const activateAt = useWorkspaceStore((s) => s.activateAt)
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar)
  const reopenLastClosed = useWorkspaceStore((s) => s.reopenLastClosed)
  const toggleSplit = useWorkspaceStore((s) => s.toggleSplit)

  useHotkeys(
    "mod+t",
    (e) => {
      e.preventDefault()
      onNewTab()
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  )

  useHotkeys(
    "mod+w",
    (e) => {
      e.preventDefault()
      if (activeId) close(activeId)
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
    [activeId, close],
  )

  useHotkeys(
    "mod+shift+t",
    (e) => {
      e.preventDefault()
      reopenLastClosed()
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  )

  useHotkeys(
    "mod+b",
    (e) => {
      e.preventDefault()
      toggleSidebar()
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  )

  useHotkeys(
    "mod+backslash",
    (e) => {
      e.preventDefault()
      toggleSplit()
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  )

  useHotkeys(
    "ctrl+tab",
    (e) => {
      e.preventDefault()
      cycleTab(1)
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  )
  useHotkeys(
    "ctrl+shift+tab",
    (e) => {
      e.preventDefault()
      cycleTab(-1)
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  )

  useHotkeys(
    "mod+1,mod+2,mod+3,mod+4,mod+5,mod+6,mod+7,mod+8,mod+9",
    (e, handler) => {
      const key = handler.keys?.[0]
      if (!key) return
      const idx = Number(key) - 1
      if (Number.isFinite(idx)) {
        e.preventDefault()
        activateAt(idx)
      }
    },
    { enableOnFormTags: true, enableOnContentEditable: true },
  )

  return null
}
