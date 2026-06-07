"use client"

import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { Command, FolderTree, Layers, LayoutGrid } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useWorkspaceStore, type ActivePanel } from "./useWorkspaceStore"
import { UserMenu } from "./UserMenu"

type PanelDef = {
  key: ActivePanel
  label: string
  icon: React.ComponentType<{ className?: string }>
}

// Side panels reachable from the rail. assets ships now; sessions / monitor
// are added in a later phase (their icons appear here then).
const PANELS: PanelDef[] = [
  { key: "assets", label: "资产", icon: FolderTree },
  { key: "sessions", label: "会话总览", icon: Layers },
]

type Props = {
  onOpenLauncher: () => void
  onShowShortcuts: () => void
}

// VS Code-style activity bar — a fixed 48px rail that selects which side panel
// shows and carries the command-palette entry + account menu at its foot. It is
// NOT inside the resizable Group, so it never resizes.
export function ActivityBar({ onOpenLauncher, onShowShortcuts }: Props) {
  const activePanel = useWorkspaceStore((s) => s.activePanel)
  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen)
  const setActivePanel = useWorkspaceStore((s) => s.setActivePanel)
  const setSidebarOpen = useWorkspaceStore((s) => s.setSidebarOpen)
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar)
  const reduced = useReducedMotion()

  const pick = (key: ActivePanel) => {
    // Re-clicking the open panel collapses the side panel (VS Code behaviour);
    // clicking another switches to it and ensures the panel is open.
    if (sidebarOpen && activePanel === key) {
      toggleSidebar()
    } else {
      setActivePanel(key)
      setSidebarOpen(true)
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <nav
        aria-label="工作台导航"
        className="flex w-12 shrink-0 flex-col items-center border-r bg-card/40 py-2"
      >
        <div
          className="mb-2 grid h-8 w-8 place-items-center rounded-md bg-primary/12 text-primary"
          title="工作台"
        >
          <LayoutGrid className="h-4 w-4" />
        </div>
        <div className="flex flex-col items-center gap-1">
          {PANELS.map((p) => (
            <RailButton
              key={p.key}
              icon={p.icon}
              label={p.label}
              selected={sidebarOpen && activePanel === p.key}
              onClick={() => pick(p.key)}
              reduced={!!reduced}
            />
          ))}
        </div>
        <div className="flex-1" />
        <div className="flex flex-col items-center gap-1">
          <RailButton
            icon={Command}
            label="命令面板 · Ctrl K"
            onClick={onOpenLauncher}
            reduced={!!reduced}
          />
          <UserMenu onShowShortcuts={onShowShortcuts} />
        </div>
      </nav>
    </TooltipProvider>
  )
}

function RailButton({
  icon: Icon,
  label,
  selected,
  onClick,
  reduced,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  selected?: boolean
  onClick: () => void
  reduced: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={selected}
          whileTap={reduced ? undefined : { scale: 0.9 }}
          className={cn(
            "relative grid h-9 w-9 place-items-center rounded-md transition-colors",
            selected
              ? "bg-primary/12 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          {selected && (
            <motion.span
              layoutId="activity-rail-active"
              className="absolute -left-2 h-5 w-0.5 rounded-r-full bg-primary"
              transition={{ type: "spring", stiffness: 500, damping: 40 }}
            />
          )}
          <Icon className="h-[18px] w-[18px]" />
        </motion.button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}
