// Helpers for reading / writing the `rdp` sub-object inside
// node.proto_options. Mirrors the backend's ParseRdpOptions, including
// the legacy Guacamole flat-form recognition so an old node's stored
// proto_options doesn't read back empty in the new structured form.

import type { ProtoOptionsEnvelope, RdpProtoOptions, RdpSecurity } from "@/lib/api/types"

const LEGACY_FLAT_KEYS: ReadonlyArray<string> = [
  "security",
  "domain",
  "ignore-cert",
  "keyboard",
]

// parseProtoOptions decodes the JSON string stored on Node.proto_options.
// Returns an empty envelope on missing / malformed input — callers can
// always treat the result as well-formed.
//
// Accepts two on-disk shapes:
//   1. `{"rdp":{...}}` — current structured form
//   2. `{"security":"nla","domain":"WORKGROUP","ignore-cert":"true"}` —
//      legacy Guacamole flat form (kept compatible)
export function parseProtoOptions(raw: string | undefined | null): ProtoOptionsEnvelope {
  if (!raw) return {}
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!obj || typeof obj !== "object") return {}
  const root = obj as Record<string, unknown>
  if (root.rdp && typeof root.rdp === "object") {
    return { rdp: root.rdp as RdpProtoOptions }
  }
  // Detect legacy flat form by presence of at least one Guacamole key.
  if (LEGACY_FLAT_KEYS.some((k) => k in root)) {
    const sec = typeof root.security === "string" ? (root.security as RdpSecurity) : undefined
    const rdp: RdpProtoOptions = {}
    if (sec) rdp.security = sec
    if (typeof root.domain === "string") rdp.domain = root.domain
    if (typeof root.keyboard === "string") rdp.keyboard = root.keyboard
    const ic = root["ignore-cert"]
    if (typeof ic === "boolean") rdp.ignore_cert = ic
    else if (ic === "true" || ic === "1") rdp.ignore_cert = true
    else if (ic === "false" || ic === "0") rdp.ignore_cert = false
    return { rdp }
  }
  return {}
}

// serializeProtoOptions writes the envelope back to a JSON string. Empty
// objects yield "" so we don't store noise like "{}" on nodes without
// custom options. Undefined / null fields are dropped via JSON.stringify
// — RdpProtoOptions's optional-only shape means "user didn't override".
export function serializeProtoOptions(env: ProtoOptionsEnvelope): string {
  if (!env || !env.rdp || Object.keys(env.rdp).length === 0) return ""
  const cleaned = stripUndefined(env.rdp)
  if (Object.keys(cleaned).length === 0) return ""
  return JSON.stringify({ rdp: cleaned })
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (typeof v === "string" && v === "") continue
    ;(out as Record<string, unknown>)[k] = v as unknown
  }
  return out
}

// patchRdpProtoOptions returns a fresh JSON string with the supplied RDP
// fields merged on top of whatever's currently stored. Used by the desktop
// loading overlay's "force TLS retry" shortcut so we don't have to
// reconstruct the full envelope every time.
export function patchRdpProtoOptions(raw: string | undefined | null, patch: Partial<RdpProtoOptions>): string {
  const env = parseProtoOptions(raw)
  env.rdp = { ...(env.rdp ?? {}), ...patch }
  return serializeProtoOptions(env)
}
