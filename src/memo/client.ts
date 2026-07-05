import { createHash } from 'node:crypto';
import type { MemoHook } from '../check.js';
import { INVOCATION } from '../derive.js';
import { EPOCH, inputsHash } from './key.js';
import type { MemoRecord, MemoStore } from './store.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const TOOL_VERSION = process.env.npm_package_version ?? 'unknown';

/**
 * Defense-in-depth (C3 carry-forward): `store.get` casts the fetched JSON to
 * `MemoRecord` with NO shape validation, so a GitHub-served malformed 200 could
 * hand us junk (`[]`, `42`, `{}`, a record with a numeric sha). Before a record
 * can short-circuit a check to PASS it MUST be a well-formed object with all
 * four fields present as the right types. Anything else is treated as a MISS —
 * never a hit — so a garbled memo degrades to a live re-derive, never a false
 * pass.
 */
function isMemoRecord(v: unknown): v is MemoRecord {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    typeof (v as MemoRecord).derivedLockfileSha256 === 'string' &&
    typeof (v as MemoRecord).toolVersion === 'string' &&
    typeof (v as MemoRecord).pnpmVersion === 'string' &&
    typeof (v as MemoRecord).derivedAt === 'string'
  );
}

/**
 * Adapt a `MemoStore` to check.ts's `MemoHook` — the memo TRUST BOUNDARY that
 * turns a memo hit into a skipped derive (a `pass`, spec §8).
 *
 * - `consult`: a hit requires a well-formed record whose `derivedLockfileSha256`
 *   equals `sha256(committed)`. A missing/stale/malformed record falls through
 *   to null so check.ts does a live resolve — a stale entry is NEVER a false
 *   pass (spec §8 step 3).
 * - `record`: a no-op when `write` is false (local forms never write). There is
 *   no "record a mismatch" path — check.ts only calls `record` on a pass, so a
 *   mismatch is structurally never memoised.
 */
export function makeMemoClient(
  store: MemoStore,
  opts: { write: boolean; pnpmVersion?: string },
): MemoHook {
  return {
    async consult(files, committed) {
      if (committed === null) return null;
      const record = await store.get(EPOCH, inputsHash(files, INVOCATION));
      if (!isMemoRecord(record) || record.derivedLockfileSha256 !== sha256(committed)) return null;
      return { hit: true, derivedAt: record.derivedAt, toolVersion: record.toolVersion };
    },
    async record(files, derived) {
      if (!opts.write) return;
      await store.put(EPOCH, inputsHash(files, INVOCATION), {
        derivedLockfileSha256: sha256(derived),
        toolVersion: TOOL_VERSION,
        pnpmVersion: opts.pnpmVersion ?? 'unknown',
        derivedAt: new Date().toISOString(),
      });
    },
  };
}
