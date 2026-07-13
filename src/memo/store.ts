import { createHash } from 'node:crypto';
import type { MemoHook } from '../check.js';
import { INVOCATION } from '../derive.js';
import type { MemoProvenance, Outcome } from '../outcome.js';
import type { StagedFile } from '../staging.js';
import { toolVersion } from '../version.js';
import { embedRecord } from './checks-api.js';
import { EPOCH, inputsHash } from './key.js';

export type StoredRecord = {
  epoch: number;
  inputsHash: string;
  derivedHash: string; // sha256 of the derived lockfile, hex
  toolVersion: string;
  pnpmVersion: string;
  timestamp: string; // ISO-8601
};

/** SHA-256 of a buffer, hex. Used to hash the committed and derived lockfiles. */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * The check-run conclusion for a verdict (spec §8 verdict channel). `failure`
 * iff the assay's own exit is 1 (enforce + a failing outcome); a pass/vacuous
 * is `success`; everything else at exit 0 — `off`, or a warn-mode failing kind
 * — is `neutral` (visible, non-blocking). `neutral`/`success` both satisfy a
 * required check; `failure` blocks.
 */
export function conclusion(outcome: Outcome, exit: 0 | 1): 'success' | 'failure' | 'neutral' {
  if (exit === 1) return 'failure';
  if (outcome.kind === 'pass' || outcome.kind === 'vacuous-pass') return 'success';
  return 'neutral';
}

/** A one-line human summary for the verdict check run (kept minimal — the full
 * failure report is on the job's stdout; memo/ must not import report/). */
export function verdictSummary(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'pass':
      return 'The committed lockfile derives honestly from reviewable inputs.';
    case 'vacuous-pass':
      return 'No resolution inputs changed; nothing to derive.';
    case 'not-evaluated':
      return 'lockfile-assay is off for this repository.';
    case 'mismatch':
      return 'The committed lockfile is NOT what honest re-derivation produces.';
    case 'toolchain-skew':
      return `Toolchain skew: pinned pnpm ${outcome.pinned}, effective ${outcome.effective}.`;
    case 'unsupported-input':
      return `Unsupported input: ${outcome.reasons.join('; ')}.`;
    case 'cannot-evaluate':
      return outcome.reason;
  }
}

export interface Backend {
  // records parsed from the *success* check runs on every head SHA this PR has
  // run against (current chain + force-pushed-away heads), filtered to the App
  // id + check name. Throws on transport error; the adapter maps it to a miss.
  listRecords(): Promise<StoredRecord[]>;
  postVerdict(v: {
    headSha: string;
    conclusion: 'success' | 'failure' | 'neutral';
    title: string;
    summary: string;
  }): Promise<void>;
}

export class MemoDriver implements MemoHook {
  private pending: StoredRecord | null = null;

  constructor(
    private readonly backend: Backend | null,
    private readonly write: boolean,
  ) {}

  async consult(files: StagedFile[], committed: Buffer | null): Promise<MemoProvenance | null> {
    if (!this.backend || !committed) return null;
    try {
      const want = inputsHash(files, INVOCATION);
      const committedHash = sha256(committed);
      for (const r of await this.backend.listRecords()) {
        if (r.epoch === EPOCH && r.inputsHash === want && r.derivedHash === committedHash) {
          return { hit: true, derivedAt: r.timestamp, toolVersion: r.toolVersion };
        }
      }
      return null;
    } catch {
      return null; // every read error degrades to a miss (spec §8)
    }
  }

  async record(files: StagedFile[], derived: Buffer, pnpmVersion?: string): Promise<void> {
    if (!this.backend || !this.write) return; // local forms never write
    this.pending = {
      epoch: EPOCH,
      inputsHash: inputsHash(files, INVOCATION),
      derivedHash: sha256(derived),
      toolVersion: toolVersion(),
      pnpmVersion: pnpmVersion ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
  }

  /** Post one verdict check run for this run's outcome, embedding the stashed
   * record on a pass. Best-effort: a failure never changes the verdict — it
   * returns a warning (drift wording on the pass path). */
  async postVerdict(v: { outcome: Outcome; exit: 0 | 1; headSha: string }): Promise<string[]> {
    if (!this.backend || !this.write) return [];
    const isPass = v.outcome.kind === 'pass';
    let summary = verdictSummary(v.outcome);
    if (isPass && this.pending) summary += `\n${embedRecord(this.pending)}`;
    try {
      await this.backend.postVerdict({
        headSha: v.headSha,
        conclusion: conclusion(v.outcome, v.exit),
        title: `lockfile-assay: ${v.outcome.kind}`,
        summary,
      });
      return [];
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return [
        isPass
          ? `could not record the derivation memo (${reason}); this pass is not durable — re-runs will re-resolve against the registry (spec §7 drift)`
          : `could not post the verdict check run (${reason})`,
      ];
    }
  }
}
