import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { DesktopBackend } from "@/lib/desktop/types"

export type Protocol =
  | "ssh"
  | "telnet"
  | "dbcli"
  | "db_studio"
  | "rdp"
  | "rdp_next"
  | "vnc"
  | "sftp"
  | "tcp_forward"

export type TabStatus = "fresh" | "connecting" | "connected" | "closed" | "error"

// SideDock sub-tab key — which server-management panel is open inside a
// connection tab. Persisted per-tab so refresh restores the user's last view.
export type SubTab = "dashboard" | "firewall" | "docker" | "sessions" | "info"

// Chrome-style group palette. Eight muted tones keep the strip visually
// quiet even with three or four groups open simultaneously. Names live in
// the locale layer; the store only knows the slugs.
export type GroupColor =
  | "gray"
  | "blue"
  | "red"
  | "yellow"
  | "green"
  | "cyan"
  | "purple"
  | "orange"

export const GROUP_COLOR_ORDER: GroupColor[] = [
  "blue",
  "green",
  "purple",
  "orange",
  "red",
  "cyan",
  "yellow",
  "gray",
]

export type GroupingMode = "off" | "manual" | "by-node" | "by-protocol"

export interface TabGroup {
  id: string
  name: string
  color: GroupColor
  collapsed: boolean
}

export type WorkspaceTab = {
  id: string
  nodeId: number
  protocol: Protocol
  // Only used by rdp_next. Chooses the implementation behind DesktopDisplay.
  rdpBackend?: DesktopBackend
  title: string
  // Persisted snapshot of host/port so tab strip and recent list can render
  // without an extra node lookup; refreshed on demand.
  host?: string
  port?: number
  status: TabStatus
  createdAt: number
  // Workspace v2 — per-tab sub-panel state. Optional so pre-v2 persisted
  // payloads load cleanly.
  subTab?: SubTab
  dockOpen?: boolean
  // Live round-trip latency reported by the session renderer (webssh,
  // desktop, etc.). Transient — wiped on reload via `partialize` below
  // because the WS connection is gone anyway. `null` means
  // "unmeasurable" (e.g. IronRDP Wasm path) and renders as a dash;
  // `undefined` means "never reported yet" and hides the badge.
  latencyMs?: number | null
  // Phase 7 — group assignment (manual mode only; derived modes ignore).
  groupId?: string | null
  // Pinned tabs sort to the very left and skip "close" / "close others".
  pinned?: boolean
  // Muted tabs suppress toast notifications sourced from inside the tab.
  muted?: boolean
  // Set true after the user pops the tab into a standalone browser window.
  // The main-window placeholder renders a "已弹出" notice with a close
  // button rather than the live renderer.
  poppedOut?: boolean
  // Unread / activity flag — set by background event sources (decoder
  // errors, server-side disconnect) and cleared when the user activates
  // the tab. Used to drive the small accent dot in the tab strip.
  unread?: boolean
}

export type TreeView = "favorites" | "recent" | "groups" | "tags" | "protocols" | "all"

type OpenInput = {
  nodeId: number
  protocol: Protocol
  rdpBackend?: DesktopBackend
  title: string
  host?: string
  port?: number
  groupId?: string | null
  pinned?: boolean
}

const RECENT_LIMIT = 10

// User-visible workspace preferences. Persisted with the store so toggling
// "by node" survives a reload. Tab visual toggles default to "show" so
// upgrading from a pre-Phase 7 persisted store does not look broken.
export interface WorkspacePrefs {
  groupingMode: GroupingMode
  showProtocolIcon: boolean
  showHostPort: boolean
  showLatencyBadge: boolean
}

const DEFAULT_PREFS: WorkspacePrefs = {
  groupingMode: "off",
  showProtocolIcon: true,
  showHostPort: true,
  showLatencyBadge: true,
}

type State = {
  tabs: WorkspaceTab[]
  groups: TabGroup[]
  prefs: WorkspacePrefs
  activeId: string | null
  sidebarOpen: boolean
  treeView: TreeView
  // Not persisted — kept in memory so Ctrl+Shift+T works within a session.
  recentlyClosed: WorkspaceTab[]
}

type Actions = {
  open: (t: OpenInput) => string
  close: (id: string) => void
  closeOthers: (id: string) => void
  closeToRight: (id: string) => void
  closeAll: () => void
  duplicate: (id: string) => string | null
  rename: (id: string, title: string) => void
  setActive: (id: string) => void
  reorder: (from: number, to: number) => void
  setStatus: (id: string, status: TabStatus) => void
  // Live latency badge on the tab strip. `null` = unmeasurable
  // (renders as "—" so the user knows the channel is up but RTT isn't
  // available for this transport).
  setLatency: (id: string, latencyMs: number | null) => void
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  setTreeView: (view: TreeView) => void
  reopenLastClosed: () => string | null
  cycleTab: (delta: number) => void
  activateAt: (idx: number) => void
  // Workspace v2 — sub-tab control inside a connection tab.
  setSubTab: (id: string, sub: SubTab) => void
  toggleDock: (id: string) => void
  // Phase 7 — group, pin, mute, popout, unread.
  setGroupingMode: (mode: GroupingMode) => void
  createGroup: (name: string, color?: GroupColor) => string
  renameGroup: (id: string, name: string) => void
  recolorGroup: (id: string, color: GroupColor) => void
  toggleGroupCollapsed: (id: string) => void
  deleteGroup: (id: string) => void
  moveTabToGroup: (tabId: string, groupId: string | null) => void
  togglePin: (id: string) => void
  toggleMute: (id: string) => void
  setPoppedOut: (id: string, popped: boolean) => void
  markUnread: (id: string, unread: boolean) => void
  setPrefs: (patch: Partial<WorkspacePrefs>) => void
}

export type WorkspaceStore = State & Actions

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// findNextActive picks the tab that should receive focus after `removedId`
// closes. Honours the user's prior pick when still valid, otherwise lands
// on the closest remaining sibling so the keyboard focus pattern matches
// browser tabs.
function findNextActive(
  tabs: WorkspaceTab[],
  removedIdx: number,
  prevActive: string | null,
  removedId: string,
): string | null {
  if (tabs.length === 0) return null
  if (prevActive && prevActive !== removedId) {
    if (tabs.find((t) => t.id === prevActive)) return prevActive
  }
  if (removedIdx >= tabs.length) return tabs[tabs.length - 1].id
  return tabs[removedIdx].id
}

// pickNextGroupColor cycles through GROUP_COLOR_ORDER, picking the next
// hue not already used by another live group so the strip stays varied.
function pickNextGroupColor(groups: TabGroup[]): GroupColor {
  const used = new Set(groups.map((g) => g.color))
  for (const c of GROUP_COLOR_ORDER) {
    if (!used.has(c)) return c
  }
  return GROUP_COLOR_ORDER[groups.length % GROUP_COLOR_ORDER.length]
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      groups: [],
      prefs: DEFAULT_PREFS,
      activeId: null,
      sidebarOpen: true,
      treeView: "favorites",
      recentlyClosed: [],

      open: ({ nodeId, protocol, rdpBackend, title, host, port, groupId, pinned }) => {
        const id = genId()
        set((s) => ({
          tabs: [
            ...s.tabs,
            {
              id,
              nodeId,
              protocol,
              rdpBackend,
              title,
              host,
              port,
              status: "fresh",
              createdAt: Date.now(),
              groupId: groupId ?? null,
              pinned: !!pinned,
              muted: false,
              poppedOut: false,
              unread: false,
            },
          ],
          activeId: id,
        }))
        return id
      },

      close: (id) => {
        const { tabs, activeId, recentlyClosed } = get()
        const idx = tabs.findIndex((t) => t.id === id)
        if (idx < 0) return
        const removed = tabs[idx]
        // Pinned tabs ignore plain close — the user has to unpin first.
        if (removed.pinned) return
        const remaining = tabs.filter((t) => t.id !== id)
        set({
          tabs: remaining,
          activeId: findNextActive(remaining, idx, activeId, id),
          recentlyClosed: [removed, ...recentlyClosed].slice(0, RECENT_LIMIT),
        })
      },

      closeOthers: (id) => {
        const { tabs, recentlyClosed } = get()
        const keep = tabs.find((t) => t.id === id)
        if (!keep) return
        // Pinned tabs always survive closeOthers — that's the whole point.
        const survivors = tabs.filter((t) => t.id === id || t.pinned)
        const removed = tabs.filter((t) => t.id !== id && !t.pinned)
        set({
          tabs: survivors,
          activeId: id,
          recentlyClosed: [...removed, ...recentlyClosed].slice(0, RECENT_LIMIT),
        })
      },

      closeToRight: (id) => {
        const { tabs, activeId, recentlyClosed } = get()
        const idx = tabs.findIndex((t) => t.id === id)
        if (idx < 0) return
        const keep = [
          ...tabs.slice(0, idx + 1),
          ...tabs.slice(idx + 1).filter((t) => t.pinned),
        ]
        const removed = tabs.slice(idx + 1).filter((t) => !t.pinned)
        let nextActive = activeId
        if (activeId && !keep.find((t) => t.id === activeId)) nextActive = id
        set({
          tabs: keep,
          activeId: nextActive,
          recentlyClosed: [...removed, ...recentlyClosed].slice(0, RECENT_LIMIT),
        })
      },

      closeAll: () => {
        const { tabs, recentlyClosed } = get()
        const pinned = tabs.filter((t) => t.pinned)
        const removed = tabs.filter((t) => !t.pinned)
        set({
          tabs: pinned,
          activeId: pinned[0]?.id ?? null,
          recentlyClosed: [...removed, ...recentlyClosed].slice(0, RECENT_LIMIT),
        })
      },

      duplicate: (id) => {
        const src = get().tabs.find((t) => t.id === id)
        if (!src) return null
        return get().open({
          nodeId: src.nodeId,
          protocol: src.protocol,
          rdpBackend: src.rdpBackend,
          title: src.title,
          host: src.host,
          port: src.port,
          groupId: src.groupId ?? null,
        })
      },

      rename: (id, title) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, title: title || t.title } : t)),
        })),

      setActive: (id) =>
        set((s) => ({
          activeId: id,
          // Activating a tab clears its unread / activity dot.
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, unread: false } : t)),
        })),

      reorder: (from, to) =>
        set((s) => {
          if (from === to || from < 0 || to < 0 || from >= s.tabs.length || to >= s.tabs.length) return s
          const next = s.tabs.slice()
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          return { tabs: next }
        }),

      setStatus: (id, status) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, status } : t)),
        })),

      setLatency: (id, latencyMs) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, latencyMs } : t)),
        })),

      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setTreeView: (treeView) => set({ treeView }),

      reopenLastClosed: () => {
        const [head, ...rest] = get().recentlyClosed
        if (!head) return null
        set({ recentlyClosed: rest })
        return get().open({
          nodeId: head.nodeId,
          protocol: head.protocol,
          rdpBackend: head.rdpBackend,
          title: head.title,
          host: head.host,
          port: head.port,
          groupId: head.groupId ?? null,
          pinned: head.pinned,
        })
      },

      cycleTab: (delta) => {
        const { tabs, activeId } = get()
        if (tabs.length === 0) return
        const idx = activeId ? tabs.findIndex((t) => t.id === activeId) : -1
        const next = ((idx === -1 ? 0 : idx + delta) % tabs.length + tabs.length) % tabs.length
        set({ activeId: tabs[next].id })
      },

      activateAt: (idx) => {
        const { tabs } = get()
        if (idx < 0 || idx >= tabs.length) return
        set({ activeId: tabs[idx].id })
      },

      setSubTab: (id, sub) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, subTab: sub } : t)),
        })),

      toggleDock: (id) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === id ? { ...t, dockOpen: !(t.dockOpen ?? true) } : t,
          ),
        })),

      setGroupingMode: (mode) =>
        set((s) => ({
          prefs: { ...s.prefs, groupingMode: mode },
        })),

      createGroup: (name, color) => {
        const id = genId()
        set((s) => ({
          groups: [
            ...s.groups,
            {
              id,
              name: name.trim() || "新分组",
              color: color ?? pickNextGroupColor(s.groups),
              collapsed: false,
            },
          ],
          // Auto-switch to manual mode when the user makes a group; it
          // would be confusing to create a group invisible to the strip.
          prefs:
            s.prefs.groupingMode === "manual"
              ? s.prefs
              : { ...s.prefs, groupingMode: "manual" },
        }))
        return id
      },

      renameGroup: (id, name) =>
        set((s) => ({
          groups: s.groups.map((g) =>
            g.id === id ? { ...g, name: name.trim() || g.name } : g,
          ),
        })),

      recolorGroup: (id, color) =>
        set((s) => ({
          groups: s.groups.map((g) => (g.id === id ? { ...g, color } : g)),
        })),

      toggleGroupCollapsed: (id) =>
        set((s) => ({
          groups: s.groups.map((g) =>
            g.id === id ? { ...g, collapsed: !g.collapsed } : g,
          ),
        })),

      deleteGroup: (id) =>
        set((s) => ({
          groups: s.groups.filter((g) => g.id !== id),
          tabs: s.tabs.map((t) => (t.groupId === id ? { ...t, groupId: null } : t)),
        })),

      moveTabToGroup: (tabId, groupId) =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId ? { ...t, groupId: groupId ?? null } : t,
          ),
        })),

      togglePin: (id) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t)),
        })),

      toggleMute: (id) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, muted: !t.muted } : t)),
        })),

      setPoppedOut: (id, popped) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, poppedOut: popped } : t)),
        })),

      markUnread: (id, unread) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, unread } : t)),
        })),

      setPrefs: (patch) =>
        set((s) => ({
          prefs: { ...s.prefs, ...patch },
        })),
    }),
    {
      name: "workspace:v1",
      // After a refresh the WS connections are gone — reset status so the
      // user knows to click Reconnect. Drop the recently-closed stack
      // too. `latencyMs` is also transient (the channel that produced
      // the number is dead), so strip it off here. poppedOut is reset
      // too — the standalone browser window died with the tab, so the
      // main window should resume rendering the live view.
      partialize: (s) => ({
        tabs: s.tabs.map((t) => ({
          ...t,
          status: "fresh" as const,
          latencyMs: undefined,
          poppedOut: false,
          unread: false,
          // subTab, dockOpen, groupId, pinned, muted are part of WorkspaceTab and ride along.
        })),
        groups: s.groups,
        prefs: s.prefs,
        activeId: s.activeId,
        sidebarOpen: s.sidebarOpen,
        treeView: s.treeView,
      }),
      // Older payloads (Phase 6 and earlier) lack the new fields. Fill in
      // defaults so consumers can rely on the new shape without runtime
      // undefined-check chains. The return type is loose because partialize
      // produces a narrowed `status: "fresh"` literal — but inside the
      // migrate output we ultimately spread back into `State`, so the
      // shape is compatible at runtime.
      migrate: (persisted) => {
        if (!persisted || typeof persisted !== "object") return persisted
        const cast = persisted as Partial<State>
        const tabs = Array.isArray(cast.tabs)
          ? cast.tabs.map((t) => ({
              ...t,
              status: "fresh" as const,
              latencyMs: undefined,
              groupId: t.groupId ?? null,
              pinned: t.pinned ?? false,
              muted: t.muted ?? false,
              poppedOut: false,
              unread: false,
            }))
          : []
        const groups = Array.isArray(cast.groups) ? cast.groups : []
        const prefs: WorkspacePrefs = {
          ...DEFAULT_PREFS,
          ...(cast.prefs ?? {}),
        }
        return {
          tabs,
          groups,
          prefs,
          activeId: cast.activeId ?? null,
          sidebarOpen: cast.sidebarOpen ?? true,
          treeView: cast.treeView ?? "favorites",
        }
      },
      version: 2,
    },
  ),
)

// Convenience selector for components that need both the user's grouping
// mode and the raw groups. Re-exported because some test code mocks the
// store and needs the same shape.
export function selectGroupingMode(s: WorkspaceStore) { return s.prefs.groupingMode }
export function selectGroups(s: WorkspaceStore) { return s.groups }
