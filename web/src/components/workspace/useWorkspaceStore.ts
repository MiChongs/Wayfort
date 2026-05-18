import { create } from "zustand"
import { persist } from "zustand/middleware"

export type Protocol =
  | "ssh"
  | "telnet"
  | "dbcli"
  | "rdp"
  | "rdp_next"
  | "vnc"
  | "sftp"
  | "tcp_forward"

export type TabStatus = "fresh" | "connecting" | "connected" | "closed" | "error"

// SideDock sub-tab key — which server-management panel is open inside a
// connection tab. Persisted per-tab so refresh restores the user's last view.
export type SubTab = "dashboard" | "firewall" | "docker" | "sessions" | "info"

export type WorkspaceTab = {
  id: string
  nodeId: number
  protocol: Protocol
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
}

export type TreeView = "favorites" | "recent" | "groups" | "tags" | "protocols" | "all"

type OpenInput = {
  nodeId: number
  protocol: Protocol
  title: string
  host?: string
  port?: number
}

const RECENT_LIMIT = 10

type State = {
  tabs: WorkspaceTab[]
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
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  setTreeView: (view: TreeView) => void
  reopenLastClosed: () => string | null
  cycleTab: (delta: number) => void
  activateAt: (idx: number) => void
  // Workspace v2 — sub-tab control inside a connection tab.
  setSubTab: (id: string, sub: SubTab) => void
  toggleDock: (id: string) => void
}

export type WorkspaceStore = State & Actions

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function findNextActive(tabs: WorkspaceTab[], removedIdx: number, prevActive: string | null, removedId: string): string | null {
  if (tabs.length === 0) return null
  if (prevActive && prevActive !== removedId) {
    if (tabs.find((t) => t.id === prevActive)) return prevActive
  }
  if (removedIdx >= tabs.length) return tabs[tabs.length - 1].id
  return tabs[removedIdx].id
}

export const useWorkspaceStore = create<WorkspaceStore>()(
  persist(
    (set, get) => ({
      tabs: [],
      activeId: null,
      sidebarOpen: true,
      treeView: "favorites",
      recentlyClosed: [],

      open: ({ nodeId, protocol, title, host, port }) => {
        const id = genId()
        set((s) => ({
          tabs: [
            ...s.tabs,
            {
              id,
              nodeId,
              protocol,
              title,
              host,
              port,
              status: "fresh",
              createdAt: Date.now(),
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
        const removed = tabs.filter((t) => t.id !== id)
        set({
          tabs: [keep],
          activeId: id,
          recentlyClosed: [...removed, ...recentlyClosed].slice(0, RECENT_LIMIT),
        })
      },

      closeToRight: (id) => {
        const { tabs, activeId, recentlyClosed } = get()
        const idx = tabs.findIndex((t) => t.id === id)
        if (idx < 0) return
        const keep = tabs.slice(0, idx + 1)
        const removed = tabs.slice(idx + 1)
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
        set({
          tabs: [],
          activeId: null,
          recentlyClosed: [...tabs, ...recentlyClosed].slice(0, RECENT_LIMIT),
        })
      },

      duplicate: (id) => {
        const src = get().tabs.find((t) => t.id === id)
        if (!src) return null
        return get().open({
          nodeId: src.nodeId,
          protocol: src.protocol,
          title: src.title,
          host: src.host,
          port: src.port,
        })
      },

      rename: (id, title) =>
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === id ? { ...t, title: title || t.title } : t)),
        })),

      setActive: (id) => set({ activeId: id }),

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
          title: head.title,
          host: head.host,
          port: head.port,
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
    }),
    {
      name: "workspace:v1",
      // After a refresh the WS connections are gone — reset status so the
      // user knows to click Reconnect. Drop the recently-closed stack too.
      partialize: (s) => ({
        tabs: s.tabs.map((t) => ({
          ...t,
          status: "fresh" as const,
          // subTab and dockOpen are part of WorkspaceTab and ride along.
        })),
        activeId: s.activeId,
        sidebarOpen: s.sidebarOpen,
        treeView: s.treeView,
      }),
    },
  ),
)
