"use client"

// Drive upload transfer queue — a real state machine, lifted into a zustand
// store so it survives the file panel opening/closing and can be read by both
// the panel (full queue UI) and the toolbar (progress ring). Models concurrent
// uploads, per-file progress / cancel / retry, and folder uploads (recreating
// the directory tree on the server before pushing each file).
//
// File handles + AbortControllers live in a non-reactive module Map keyed by
// task id, so progress ticks only re-render what reads `transfers`.

import { create } from "zustand"
import { desktopDriveService } from "@/lib/api/services"

export type TransferStatus = "queued" | "uploading" | "done" | "error" | "canceled"

export interface Transfer {
  id: string
  name: string // basename shown in the queue row
  relPath: string // folder uploads: "sub/dir/file.txt" relative to the batch root; "" for flat
  destPath: string // server directory to upload into (base + parent(relPath))
  size: number
  sent: number
  status: TransferStatus
  error?: string
  startedAt?: number
  finishedAt?: number
}

type DropFile = File & { path?: string; webkitRelativePath?: string }

const CONCURRENCY = 3

// Non-reactive runtime: the File + its AbortController. Kept out of store state
// so a progress patch doesn't churn these heavy/unserialisable values.
const runtime = new Map<string, { file: File; ctrl: AbortController }>()
// Directories we've already created this batch, so a folder upload doesn't
// hammer mkdir for every file in the same folder. Cleared when the queue idles.
const ensuredDirs = new Set<string>()

interface State {
  transfers: Transfer[]
  enqueue: (files: File[], destBase: string) => number
  cancel: (id: string) => void
  cancelAll: () => void
  retry: (id: string) => void
  retryFailed: () => void
  clearFinished: () => void
  remove: (id: string) => void
}

function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/")
  return i < 0 ? "" : p.slice(0, i)
}
function joinPath(base: string, sub: string): string {
  if (!sub) return base
  return base ? `${base}/${sub}` : sub
}

export const useDriveTransfers = create<State>((set, get) => {
  const patch = (id: string, p: Partial<Transfer>) =>
    set((s) => ({ transfers: s.transfers.map((t) => (t.id === id ? { ...t, ...p } : t)) }))

  async function ensureDir(dir: string) {
    if (!dir || ensuredDirs.has(dir)) return
    try {
      await desktopDriveService.mkdir(dir)
    } catch {
      // Already exists / raced another file in the same folder — fine. A real
      // failure surfaces on the upload itself.
    }
    ensuredDirs.add(dir)
  }

  async function runOne(id: string) {
    const rt = runtime.get(id)
    const t = get().transfers.find((x) => x.id === id)
    if (!rt || !t) return
    patch(id, { status: "uploading", startedAt: Date.now(), sent: 0, error: undefined })
    try {
      if (t.destPath) await ensureDir(t.destPath)
      await desktopDriveService.upload(rt.file, t.destPath, (sent) => patch(id, { sent }), rt.ctrl.signal)
      patch(id, { status: "done", sent: t.size, finishedAt: Date.now() })
      runtime.delete(id)
    } catch (e) {
      const msg = (e as { message?: string } | undefined)?.message
      const canceled = msg === "aborted"
      patch(id, {
        status: canceled ? "canceled" : "error",
        error: canceled ? undefined : msg || "上传失败",
        finishedAt: Date.now(),
      })
      // Keep the runtime entry on failure/cancel so "重试" can reuse the File.
    }
    pump()
  }

  function pump() {
    const snapshot = get().transfers
    let running = snapshot.filter((t) => t.status === "uploading").length
    const idle = running === 0 && !snapshot.some((t) => t.status === "queued")
    if (idle) ensuredDirs.clear()
    while (running < CONCURRENCY) {
      const next = get().transfers.find((t) => t.status === "queued")
      if (!next) break
      // runOne flips the task to "uploading" synchronously before its first
      // await, so the next loop iteration / get() won't pick it again.
      void runOne(next.id)
      running++
    }
  }

  return {
    transfers: [],

    enqueue: (files, destBase) => {
      const added: Transfer[] = []
      for (const f of files) {
        const raw = ((f as DropFile).path || (f as DropFile).webkitRelativePath || "").replace(/^[./]+/, "")
        const rel = raw.includes("/") ? raw : "" // only a real subpath counts as a folder upload
        const name = basename(f.name || raw)
        const destPath = rel ? joinPath(destBase, dirname(rel)) : destBase
        const id = genId()
        runtime.set(id, { file: f, ctrl: new AbortController() })
        added.push({ id, name, relPath: rel, destPath, size: f.size, sent: 0, status: "queued" })
      }
      if (added.length === 0) return 0
      set((s) => ({ transfers: [...s.transfers, ...added] }))
      pump()
      return added.length
    },

    cancel: (id) => {
      const t = get().transfers.find((x) => x.id === id)
      if (!t) return
      if (t.status === "uploading") runtime.get(id)?.ctrl.abort()
      else if (t.status === "queued") {
        patch(id, { status: "canceled", finishedAt: Date.now() })
        pump()
      }
    },

    cancelAll: () => {
      for (const t of get().transfers) {
        if (t.status === "uploading") runtime.get(t.id)?.ctrl.abort()
        else if (t.status === "queued") patch(t.id, { status: "canceled", finishedAt: Date.now() })
      }
    },

    retry: (id) => {
      const rt = runtime.get(id)
      if (!rt) return
      runtime.set(id, { file: rt.file, ctrl: new AbortController() })
      patch(id, { status: "queued", sent: 0, error: undefined, finishedAt: undefined })
      pump()
    },

    retryFailed: () => {
      for (const t of get().transfers) {
        if (t.status !== "error") continue
        const rt = runtime.get(t.id)
        if (!rt) continue
        runtime.set(t.id, { file: rt.file, ctrl: new AbortController() })
        patch(t.id, { status: "queued", sent: 0, error: undefined, finishedAt: undefined })
      }
      pump()
    },

    clearFinished: () => {
      const next = get().transfers.filter((t) => t.status === "queued" || t.status === "uploading")
      for (const t of get().transfers) {
        if (t.status !== "queued" && t.status !== "uploading") runtime.delete(t.id)
      }
      set({ transfers: next })
    },

    remove: (id) => {
      runtime.delete(id)
      set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) }))
    },
  }
})

export interface TransferSummary {
  activeCount: number
  uploadingCount: number
  doneCount: number
  failedCount: number
  canceledCount: number
  pct: number
  hasActive: boolean
}

// Derive the dock/ring summary. Byte-based percentage over the in-flight batch
// (active + completed), so the bar fills smoothly toward 100 as files land.
export function summarize(transfers: Transfer[]): TransferSummary {
  let activeBytes = 0
  let activeSent = 0
  let uploadingCount = 0
  let queuedCount = 0
  let doneCount = 0
  let failedCount = 0
  let canceledCount = 0
  for (const t of transfers) {
    switch (t.status) {
      case "uploading":
        uploadingCount++
        activeBytes += t.size
        activeSent += t.sent
        break
      case "queued":
        queuedCount++
        activeBytes += t.size
        break
      case "done":
        doneCount++
        activeBytes += t.size
        activeSent += t.size
        break
      case "error":
        failedCount++
        break
      case "canceled":
        canceledCount++
        break
    }
  }
  const activeCount = uploadingCount + queuedCount
  const pct = activeBytes > 0 ? Math.round((activeSent / activeBytes) * 100) : activeCount > 0 ? 0 : 100
  return { activeCount, uploadingCount, doneCount, failedCount, canceledCount, pct, hasActive: activeCount > 0 }
}
