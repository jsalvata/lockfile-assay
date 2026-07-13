import type { StoredRecord } from './store.js';

export const MARKER = 'lockfile-assay-memo:v1';

/** Embed a record inside a check-run summary, behind an HTML-comment marker so
 * it is invisible in rendered markdown and unambiguous to parse. */
export function embedRecord(record: StoredRecord): string {
  return `<!--${MARKER} ${JSON.stringify(record)} -->`;
}

/** Extract a record from a check-run summary. Any deviation — no marker, broken
 * JSON, a missing/mistyped field — yields null (a miss, never a false record). */
export function parseRecord(summary: string | null | undefined): StoredRecord | null {
  if (!summary) return null;
  const m = new RegExp(`<!--${MARKER} (\\{.*\\}) -->`).exec(summary);
  if (!m) return null;
  let o: unknown;
  try {
    o = JSON.parse(m[1] as string);
  } catch {
    return null;
  }
  const r = o as Record<string, unknown>;
  if (
    typeof r.epoch === 'number' &&
    typeof r.inputsHash === 'string' &&
    typeof r.derivedHash === 'string' &&
    typeof r.toolVersion === 'string' &&
    typeof r.pnpmVersion === 'string' &&
    typeof r.timestamp === 'string'
  ) {
    return {
      epoch: r.epoch,
      inputsHash: r.inputsHash,
      derivedHash: r.derivedHash,
      toolVersion: r.toolVersion,
      pnpmVersion: r.pnpmVersion,
      timestamp: r.timestamp,
    };
  }
  return null;
}
