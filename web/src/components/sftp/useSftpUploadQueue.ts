import * as React from "react"
import { sftpService } from "@/lib/api/services"
import { join, parent as parentPath } from "./pathUtil"

export type UploadStatus = "pending" | "uploading" | "done" | "error" | "cancelled"

export type UploadTask = {
  id: string
  file: File
  // `dest` is the directory we're uploading INTO; `name` is the (possibly
  // rewritten) filename in that directory. For folder uploads `dest` already
  // includes any intermediate directories that were created on the server.
  dest: string
  name: string
  size: number
  sent: number
  status: UploadStatus
  error?: string
  startedAt?: number
  finishedAt?: number
  abort?: () => void
}

type StartFn = (file: File, dest: string, opts?: { name?: string; relPath?: string }) => string

// `webkitRelativePath` shows up on every File picked through
// `<input webkitdirectory>`; using it lets us mkdir the intermediate
// directories on the server before pushing each file.
type FileWithRel = File & { webkitRelativePath?: string }

const DEFAULT_CONCURRENCY = 3

export function useSftpUploadQueue(
  nodeId: number,
  opts: { onFileDone?: (task: UploadTask) => void; concurrency?: number } = {},
) {
  const [tasks, setTasks] = React.useState<UploadTask[]>([])
  const tasksRef = React.useRef<UploadTask[]>([])
  tasksRef.current = tasks
  // Track which directories we've already mkdir'd this session so we don't
  // hammer the server with redundant calls during a folder upload.
  const ensuredDirs = React.useRef<Set<string>>(new Set())
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY

  const update = React.useCallback((id: string, patch: Partial<UploadTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }, [])

  const ensureDir = React.useCallback(
    async (dir: string) => {
      if (!dir || dir === "/" || ensuredDirs.current.has(dir)) return
      try {
        await sftpService.mkdir(nodeId, dir)
        ensuredDirs.current.add(dir)
      } catch {
        // Race against another file in the same folder; fine to ignore. If
        // the next file's upload fails for real we surface that.
      }
    },
    [nodeId],
  )

  const runOne = React.useCallback(
    async (task: UploadTask) => {
      const ctrl = new AbortController()
      update(task.id, { status: "uploading", startedAt: Date.now(), abort: () => ctrl.abort() })
      try {
        if (task.dest && task.dest !== "/") await ensureDir(task.dest)
        await sftpService.upload(nodeId, task.dest, task.file, {
          name: task.name,
          signal: ctrl.signal,
          onProgress: (sent) => update(task.id, { sent }),
        })
        const done: UploadTask = {
          ...task,
          status: "done",
          sent: task.size,
          finishedAt: Date.now(),
          abort: undefined,
        }
        update(task.id, done)
        opts.onFileDone?.(done)
      } catch (e) {
        const err = e as { message?: string } | undefined
        const cancelled = err?.message === "aborted"
        update(task.id, {
          status: cancelled ? "cancelled" : "error",
          error: cancelled ? undefined : err?.message || String(e),
          finishedAt: Date.now(),
          abort: undefined,
        })
      }
    },
    [ensureDir, nodeId, opts, update],
  )

  // Concurrency pump. Re-runs every render that touches tasks; cheap because
  // the slot calculation is O(n) over an in-memory array.
  React.useEffect(() => {
    const running = tasks.filter((t) => t.status === "uploading").length
    if (running >= concurrency) return
    const next = tasks.find((t) => t.status === "pending")
    if (!next) return
    void runOne(next)
  }, [tasks, runOne, concurrency])

  const enqueue = React.useCallback<StartFn>((file, dest, o = {}) => {
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const name = o.name || (file as FileWithRel).webkitRelativePath || file.name
    // Folder upload: webkitRelativePath looks like "logs/2025/app.log"; we
    // upload the file as `logs/2025/app.log` under `dest`, which means the
    // server needs `dest/logs/2025/` to exist first.
    const safeName = name.split(/[\\/]/).pop() || file.name
    const rel = o.relPath ?? ((file as FileWithRel).webkitRelativePath || "")
    const fullDest = rel ? join(dest, parentPath(rel)) : dest
    const task: UploadTask = {
      id,
      file,
      dest: fullDest,
      name: safeName,
      size: file.size,
      sent: 0,
      status: "pending",
    }
    setTasks((prev) => [...prev, task])
    return id
  }, [])

  const enqueueMany = React.useCallback(
    (files: FileList | File[], dest: string) => {
      const arr = Array.from(files)
      const ids: string[] = []
      for (const f of arr) ids.push(enqueue(f, dest))
      return ids
    },
    [enqueue],
  )

  const cancel = React.useCallback((id: string) => {
    const t = tasksRef.current.find((x) => x.id === id)
    if (t?.abort) t.abort()
    else if (t?.status === "pending") update(id, { status: "cancelled" })
  }, [update])

  const retry = React.useCallback((id: string) => {
    update(id, { status: "pending", sent: 0, error: undefined })
  }, [update])

  const clearFinished = React.useCallback(() => {
    setTasks((prev) => prev.filter((t) => t.status === "pending" || t.status === "uploading"))
  }, [])

  const active = tasks.filter((t) => t.status === "pending" || t.status === "uploading")
  const finished = tasks.filter((t) => t.status === "done" || t.status === "error" || t.status === "cancelled")
  const totalSent = active.reduce((s, t) => s + t.sent, 0)
  const totalBytes = active.reduce((s, t) => s + t.size, 0)

  return {
    tasks,
    active,
    finished,
    totalSent,
    totalBytes,
    enqueue,
    enqueueMany,
    cancel,
    retry,
    clearFinished,
  }
}
