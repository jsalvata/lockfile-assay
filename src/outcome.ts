import { CannotEvaluate, UsageError } from './errors.js';

export type Mode = 'off' | 'warn' | 'enforce';

/**
 * What a report may say about the mode. `'unknown'` is not a setting — it means
 * the evaluation short-circuited BEFORE reading base config, so no mode was ever
 * determined (a vacuous pass, or a degraded local form with no base to read).
 * Reporting `'off'` there would be indistinguishable from a real `mode: "off"`
 * config, which reads as "the assay is disabled in this repo" and has cost at
 * least one adopter a long debugging detour.
 */
export type ReportMode = Mode | 'unknown';

export type MemoProvenance = { hit: boolean; derivedAt?: string; toolVersion?: string };

export type Outcome =
  | { kind: 'not-evaluated' }
  | { kind: 'vacuous-pass' }
  | { kind: 'pass'; memo?: MemoProvenance }
  | { kind: 'mismatch'; committed: Buffer | null; derived: Buffer }
  | { kind: 'toolchain-skew'; pinned: string; effective: string }
  | { kind: 'unsupported-input'; reasons: string[] }
  | { kind: 'cannot-evaluate'; reason: string };

const FAILING = new Set(['mismatch', 'toolchain-skew', 'unsupported-input']);

// Only `enforce` fails, so an undetermined mode ('unknown') exits 0 — it can
// never have been read as `enforce`.
export function exitCode(outcome: Outcome, mode: ReportMode): 0 | 1 {
  return mode === 'enforce' && FAILING.has(outcome.kind) ? 1 : 0;
}

// The CLI's top-level error → exit-code contract (spec §5): a usage mistake is 2,
// a local-form "can't tell" degrades to 0, anything else is an internal error at
// 3. Kept beside exitCode so the exit-code policy lives in one place.
export function exitForError(e: unknown): 0 | 2 | 3 {
  if (e instanceof UsageError) return 2;
  if (e instanceof CannotEvaluate) return 0;
  return 3;
}
