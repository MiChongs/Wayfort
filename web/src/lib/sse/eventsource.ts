// Lightweight POST-friendly SSE client. The browser's built-in EventSource
// doesn't allow Authorization headers nor a request body, both of which the
// backend's /messages endpoint needs, so we drive the stream with fetch +
// ReadableStream and parse the `event: ...\ndata: ...\n\n` frames ourselves.

import { getAccessToken } from "@/lib/auth/tokens"

export type SSEHandler = (kind: string, data: unknown) => void

export async function streamSSE(
  url: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } | undefined,
  onEvent: SSEHandler,
): Promise<void> {
  const tok = getAccessToken()
  const headers: Record<string, string> = { Accept: "text/event-stream" }
  if (tok) headers.Authorization = `Bearer ${tok}`
  if (init?.body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: init?.signal,
  })
  if (!res.ok || !res.body) {
    let detail = ""
    try { detail = await res.text() } catch { /* */ }
    throw new Error(`SSE ${res.status}: ${detail || res.statusText}`)
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let split = buffer.indexOf("\n\n")
    while (split >= 0) {
      const frame = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      processFrame(frame, onEvent)
      split = buffer.indexOf("\n\n")
    }
  }
  if (buffer.trim()) processFrame(buffer, onEvent)
}

function processFrame(frame: string, onEvent: SSEHandler) {
  let event = "message"
  const dataLines: string[] = []
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return
  const raw = dataLines.join("\n")
  let data: unknown
  try { data = JSON.parse(raw) } catch { data = raw }
  onEvent(event, data)
}
