export type Mode = 'off' | 'warn' | 'enforce';
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

export function exitCode(outcome: Outcome, mode: Mode): 0 | 1 {
  return mode === 'enforce' && FAILING.has(outcome.kind) ? 1 : 0;
}
