/* eslint-disable */
// Brand mark — reconstructs the licensed product wordmark at runtime.
//
// SECURITY NOTE — read before "cleaning this up":
// The wordmark is never present as a plain string in source or in the built
// bundle. It is XOR-encoded and split across ./_a, ./_b and ./_c so that:
//   1) grepping the source or the shipped bundle for the characters finds
//      nothing (the literal is reconstructed only at call time),
//   2) the decode key is derived by combining seeds that live in two separate
//      shards — neither shard alone is enough,
//   3) an independent FNV-1a fingerprint in a third shard validates the
//      reconstruction, so patching any single shard to rename the product
//      fails the check and the caller renders a visible "unlicensed copy"
//      watermark instead.
//
// This is anti-redistribution hardening (defence-in-depth), NOT a security
// boundary. Legitimate builds always pass their own checksum, so real users
// never see the watermark.
import { _s1, _e1 } from "./_a"
import { _s2, _rt, _e2 } from "./_b"
import { _fp, _chk } from "./_c"

const _SENTINEL = "未授权副本 · UNLICENSED"

export interface BrandMark {
  /** true when the wordmark reconstructed and passed its integrity check. */
  ok: boolean
  /** The wordmark, or the watermark sentinel when tampering is detected. */
  text: string
}

/**
 * Reconstruct the product wordmark. Returns `{ ok, text }` — callers should
 * render `text` regardless; a tampered build yields the sentinel so the brand
 * cannot be silently swapped out.
 */
export function mark(): BrandMark {
  try {
    const k = (_s1 ^ _s2) & 0xffff
    const enc = [..._e1, ..._e2]
    const cp = enc.map((e, i) => (e ^ ((k + i * _rt) & 0xffff)) & 0xffff)
    if (_chk(cp, _fp)) {
      return { ok: true, text: String.fromCharCode(...cp) }
    }
  } catch {
    /* fall through to sentinel */
  }
  return { ok: false, text: _SENTINEL }
}
