import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { DesktopBackend } from "@/lib/desktop/types"
import { SLOT_COUNT, type SplitLayout, type SplitState } from "./lib/splitGeometry"

export type Protocol =
  | "ssh"
  | "telnet"
  | "dbcli"
  | "db_studio"
  | "rdp"
  | "rdp_next"
  | "vnc"
  | "sftp"
  | "oss"
  | "tcp_forward"

export type TabStatus = "fresh" | "connecting" | "connected" | "closed" | "error" | "approval"

// SideDock sub-tab key — which server-management panel is open inside a
// connection tab. Persisted per-tab so refresh restores the user's last view.
export type SubTab =
  | "dashboard"
  | "processes"
  | "performance"
  | "logs"
  | "services"
  | "docker"
  | "cron"
  | "packages"
  | "runner"
  | "network"
  | "storage"
  | "kernel"
  | "hardware"
  | "firewall"
  | "users"
  | "security"
  | "sessions"
  | "info"
  | "wireguard"
  | "files"
  | "loganalytics"
  | "backup"
  | "capture"

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

// Tab strip visual idiom. Replaces the old Chrome-style floating card.
//   vscode → 满高矩形页 + 激活左侧 2px 主题色竖条(VS Code 编辑器页)
//   warp   → 圆角段 + 激活填充 + 底部 2px 主题色下划线(Warp 终端页)
// 两者都走「沉稳 IDE」语言:单色协议图标、语义状态点、仅 120ms 淡入。
export type TabStyle = "vscode" | "warp"

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

export type TreeView = "favorites" | "recent" | "directory" | "groups" | "tags" | "protocols" | "all"

// Which panel the activity bar has selected. The side panel renders one of
// these at a time. "assets" is the asset tree; "sessions" / "monitor" arrive
// in a later phase but the field ships now so persisted state is forward-ready.
export type ActivePanel = "assets" | "sessions" | "monitor"

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
  tabStyle: TabStyle
  showProtocolIcon: boolean
  showHostPort: boolean
  showLatencyBadge: boolean
}

const DEFAULT_PREFS: WorkspacePrefs = {
  groupingMode: "off",
  tabStyle: "vscode",
  showProtocolIcon: true,
  showHostPort: true,
  showLatencyBadge: true,
}

type State = {
  tabs: WorkspaceTab[]
  groups: TabGroup[]
  prefs: WorkspacePrefs
  activeId: string | null
  // Side panel open/closed. The activity bar toggles this; the name stays
  // `sidebarOpen` so every existing toggleSidebar / setSidebarOpen call site
  // keeps working unchanged.
  sidebarOpen: boolean
  treeView: TreeView
  // Activity-bar selection — which panel the side panel shows.
  activePanel: ActivePanel
  // Per-node last-used protocol so the launcher / quick-connect can default to
  // what the user actually picks for each machine.
  protocolMemory: Record<number, { protocol: Protocol; rdpBackend?: DesktopBackend }>
  // Not persisted — kept in memory so Ctrl+Shift+T works within a session.
  recentlyClosed: WorkspaceTab[]
  // Split view. `split.layout` picks the grid; `split.slots` map panes to tabs
  // (slots[0] mirrors the active tab); `split.ratio` is the two-pane divider
  // fraction. Kept at the top level (not in prefs) so dragging doesn't churn
  // prefs subscribers. layout/slots reset to single on reload (sessions die).
  split: SplitState
}

type Actions = {
  open: (t: OpenInput) => string
  close: (id: string) => void
  closeOthers: (id: string) => void
  closeToRight: (id: string) => void
  closeAll: () => void
  reconnectAll: () => void
  closeErrored: () => void
  duplicate: (id: string) => string | null
  rename: (id: string, title: string) => void
  setActive: (id: string) => void
  reorder: (from: number, to: number) => void
  setStatus: (id: string, status: TabStatus) => void
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  setTreeView: (view: TreeView) => void
  setActivePanel: (panel: ActivePanel) => void
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
  // Split view.
  setSplit: (id: string | null) => void
  toggleSplit: () => void
  swapSplit: () => void
  setSplitDir: (dir: "row" | "col") => void
  setSplitRatio: (ratio: number) => void
  setLayout: (layout: SplitLayout) => void
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

// pruneSplit drops closed tabs from split slots and collapses to single when
// fewer than two live panes remain.
function pruneSplit(split: SplitState, valid: Set<string>): SplitState {
  if (split.layout === "single") return split
  const slots = split.slots.map((id) => (id && valid.has(id) ? id : null))
  if (slots.filter(Boolean).length <= 1) return { ...split, layout: "single", slots: [] }
  return { ...split, slots }
}

// fillSlots packs `count` panes: the active tab first, then the existing slot
// order, then the most-recently-created remaining tabs; pads with null.
function fillSlots(
  tabs: WorkspaceTab[],
  activeId: string | null,
  existing: (string | null)[],
  count: number,
): (string | null)[] {
  const out: (string | null)[] = []
  const seen = new Set<string>()
  const ids = new Set(tabs.map((t) => t.id))
  const push = (id: string | null | undefined) => {
    if (out.length >= count || !id || seen.has(id) || !ids.has(id)) return
    out.push(id)
    seen.add(id)
  }
  push(activeId)
  for (const id of existing) push(id)
  for (const t of [...tabs].reverse()) push(t.id)
  while (out.length < count) out.push(null)
  return out
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
      activePanel: "assets",
      protocolMemory: {},
      recentlyClosed: [],
      split: { layout: "single", slots: [], ratio: 0.5 },

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
          // Remember the protocol the user opened this node with.
          protocolMemory: { ...s.protocolMemory, [nodeId]: { protocol, rdpBackend } },
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
        const nextActive = findNextActive(remaining, idx, activeId, id)
        set((s) => ({
          tabs: remaining,
          activeId: nextActive,
          // Prune the closed tab from any split slot; collapse to single when
          // fewer than two live panes remain.
          split: pruneSplit(s.split, new Set(remaining.map((t) => t.id))),
          recentlyClosed: [removed, ...recentlyClosed].slice(0, RECENT_LIMIT),
        }))
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
          split: pruneSplit(get().split, new Set(survivors.map((t) => t.id))),
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
          split: pruneSplit(get().split, new Set(keep.map((t) => t.id))),
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
          split: pruneSplit(get().split, new Set(pinned.map((t) => t.id))),
          recentlyClosed: [...removed, ...recentlyClosed].slice(0, RECENT_LIMIT),
        })
      },

      // Bulk reconnect — nudge every connected/error/closed tab back to
      // "connecting"; each protocol component watches its status and re-opens.
      reconnectAll: () =>
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.status === "connected" || t.status === "error" || t.status === "closed"
              ? { ...t, status: "connecting" as const }
              : t,
          ),
        })),

      // Close every errored (non-pinned) tab in one go.
      closeErrored: () => {
        const { tabs, activeId, recentlyClosed } = get()
        const removed = tabs.filter((t) => t.status === "error" && !t.pinned)
        if (removed.length === 0) return
        const remaining = tabs.filter((t) => !(t.status === "error" && !t.pinned))
        const valid = new Set(remaining.map((t) => t.id))
        set({
          tabs: remaining,
          activeId: valid.has(activeId ?? "") ? activeId : (remaining[remaining.length - 1]?.id ?? null),
          split: pruneSplit(get().split, valid),
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
        set((s) => {
          // slots[0] mirrors the active tab. If the tab is already a non-primary
          // pane, swap it into the primary slot; otherwise it takes over slot 0.
          let split = s.split
          if (split.layout !== "single" && split.slots.length) {
            const slots = [...split.slots]
            const j = slots.indexOf(id)
            if (j > 0) {
              ;[slots[0], slots[j]] = [slots[j], slots[0]]
            } else if (j < 0) {
              slots[0] = id
            }
            split = { ...split, slots }
          }
          return {
            activeId: id,
            split,
            // Activating a tab clears its unread / activity dot.
            tabs: s.tabs.map((t) => (t.id === id ? { ...t, unread: false } : t)),
          }
        }),

      reorder: (from, to) =>
        set((s) => {
          if (from === to || from < 0 || to < 0 || from >= s.tabs.length || to >= s.tabs.length) return s
          const next = s.tabs.slice()
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          return { tabs: next }
        }),

      setStatus: (id, status) =>
        set((s) => {
          // Idempotent: skip the update (return the same state) when the status
          // is unchanged, so repeated setStatus calls can't drive a render loop.
          const cur = s.tabs.find((t) => t.id === id)
          if (!cur || cur.status === status) return s
          return { tabs: s.tabs.map((t) => (t.id === id ? { ...t, status } : t)) }
        }),

      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setTreeView: (treeView) => set({ treeView }),
      setActivePanel: (activePanel) => set({ activePanel }),

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

      setSplit: (id) =>
        set((s) => {
          if (!id || id === s.activeId || !s.activeId || !s.tabs.find((t) => t.id === id)) {
            return { split: { ...s.split, layout: "single", slots: [] } }
          }
          return { split: { ...s.split, layout: "row-2", slots: [s.activeId, id] } }
        }),

      toggleSplit: () =>
        set((s) => {
          if (s.split.layout !== "single") {
            return { split: { ...s.split, layout: "single", slots: [] } }
          }
          // Split the active tab with the most-recently-created other tab.
          const other = [...s.tabs].reverse().find((t) => t.id !== s.activeId)
          if (!s.activeId || !other) return s
          return { split: { ...s.split, layout: "row-2", slots: [s.activeId, other.id] } }
        }),

      swapSplit: () =>
        set((s) => {
          if (s.split.layout === "single" || s.split.slots.length < 2) return s
          const slots = [...s.split.slots]
          ;[slots[0], slots[1]] = [slots[1], slots[0]]
          return { activeId: slots[0] ?? s.activeId, split: { ...s.split, slots } }
        }),

      // Flip the current 2-/3-pane layout between row and column orientation.
      setSplitDir: (dir) =>
        set((s) => {
          const l = s.split.layout
          const next: SplitLayout =
            dir === "row"
              ? l === "col-2"
                ? "row-2"
                : l === "col-3"
                  ? "row-3"
                  : l
              : l === "row-2"
                ? "col-2"
                : l === "row-3"
                  ? "col-3"
                  : l
          return next === l ? s : { split: { ...s.split, layout: next } }
        }),

      setSplitRatio: (ratio) =>
        set((s) => ({ split: { ...s.split, ratio: Math.max(0.2, Math.min(0.8, ratio)) } })),

      setLayout: (layout) =>
        set((s) => {
          if (layout === "single") return { split: { ...s.split, layout, slots: [] } }
          return {
            split: {
              ...s.split,
              layout,
              slots: fillSlots(s.tabs, s.activeId, s.split.slots, SLOT_COUNT[layout]),
            },
          }
        }),
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
          poppedOut: false,
          unread: false,
          // subTab, dockOpen, groupId, pinned, muted are part of WorkspaceTab and ride along.
        })),
        groups: s.groups,
        prefs: s.prefs,
        activeId: s.activeId,
        sidebarOpen: s.sidebarOpen,
        treeView: s.treeView,
        activePanel: s.activePanel,
        protocolMemory: s.protocolMemory,
        // Remember only the divider ratio; layout/slots reset to single on
        // reload (both sessions are dead anyway).
        split: { layout: "single" as const, slots: [], ratio: s.split.ratio },
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
          activePanel: cast.activePanel ?? "assets",
          protocolMemory: cast.protocolMemory ?? {},
          split: {
            layout: "single" as const,
            slots: [],
            ratio:
              typeof cast.split?.ratio === "number"
                ? cast.split.ratio
                : typeof (cast as { splitRatio?: number }).splitRatio === "number"
                  ? (cast as { splitRatio?: number }).splitRatio!
                  : 0.5,
          },
        }
      },
      // v5 — adds prefs.tabStyle. migrate spreads DEFAULT_PREFS so existing
      // payloads default to "vscode" without a bespoke migration branch.
      version: 5,
    },
  ),
)

// Convenience selector for components that need both the user's grouping
// mode and the raw groups. Re-exported because some test code mocks the
// store and needs the same shape.
export function selectGroupingMode(s: WorkspaceStore) { return s.prefs.groupingMode }
export function selectGroups(s: WorkspaceStore) { return s.groups }
