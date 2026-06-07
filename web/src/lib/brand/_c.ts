/* eslint-disable */
// Brand mark — shard C. See ./mark for the full SECURITY NOTE. Carries an
// independent FNV-1a fingerprint of the original code points plus the checker,
// stored apart from the encoded shards so that a single-site edit to A or B
// fails reconstruction.
export const _fp = 52303599

// FNV-1a over the UTF-16 code units of the reconstructed string. Pure; no I/O.
export function _chk(cp: number[], fp: number): boolean {
  let h = 0x811c9dc5 >>> 0
  for (const c of cp) {
    h = (h ^ (c & 0xff)) >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
    h = (h ^ ((c >>> 8) & 0xff)) >>> 0
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h >>> 0) === (fp >>> 0)
}
