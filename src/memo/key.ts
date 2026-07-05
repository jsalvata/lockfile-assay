import { createHash } from 'node:crypto';
import type { StagedFile } from '../staging.js';

// Bump ONLY when a fix means earlier releases may have wrongly passed —
// release checklist item (spec §8). Invalidates every existing memo entry.
export const EPOCH = 1;

/**
 * SHA-256 over the exact staged inputs and the derivation invocation — the
 * memo key's collision-resistant half. A memo HIT short-circuits the check to
 * a PASS, so two different input sets must never hash alike.
 *
 * Canonical stream: files sorted by path, then per file
 * `utf8(path) ‖ 0x00 ‖ uint64BE(byteLength) ‖ bytes ‖ 0x00`, then
 * `utf8(invocation)`. The fixed-width length prefix stops adjacent files from
 * boundary-shifting into a collision; the NUL terminators are unambiguous
 * because git tree entry names are NUL-terminated in the object format and so
 * can never contain NUL, and the invocation is a NUL-free source constant.
 *
 * The sort makes the digest independent of collection order. It compares code
 * units (plain `<`/`>`), NOT localeCompare: locale collation is ICU- and
 * environment-dependent, and a memo written by CI must hash identically on
 * every machine.
 */
export function inputsHash(files: StagedFile[], invocation: string): string {
  const h = createHash('sha256');
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of sorted) {
    h.update(f.path, 'utf8');
    h.update(Buffer.from([0]));
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(f.bytes.length));
    h.update(len);
    h.update(f.bytes);
    h.update(Buffer.from([0]));
  }
  h.update(invocation, 'utf8');
  return h.digest('hex');
}
