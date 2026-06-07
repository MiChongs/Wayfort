"use client"

import * as React from "react"
import type { Node } from "@/lib/api/types"
import type { DesktopBackend } from "@/lib/desktop/types"
import { AssetTree } from "./AssetTree"
import { SessionOverviewPanel } from "./SessionOverviewPanel"
import { useWorkspaceStore, type Protocol } from "./useWorkspaceStore"

type Props = {
  onOpenTab: (node: Node, protocol: Protocol, rdpBackend?: DesktopBackend) => void
}

// Host for the activity-bar panels. The selected panel renders here, sharing
// one resizable column. assets ships now; sessions / monitor land in a later
// phase and slot into the switch below.
export function SidePanel({ onOpenTab }: Props) {
  const activePanel = useWorkspaceStore((s) => s.activePanel)

  switch (activePanel) {
    case "sessions":
      return <SessionOverviewPanel />
    case "assets":
    default:
      return <AssetTree onOpenTab={onOpenTab} />
  }
}
