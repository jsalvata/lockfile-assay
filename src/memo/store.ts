import { createHash } from 'node:crypto';
import type { MemoHook } from '../check.js';
import { INVOCATION } from '../derive.js';
import type { MemoProvenance, Outcome } from '../outcome.js';
import type { StagedFile } from '../staging.js';
import { toolVersion } from '../version.js';
import { appId, discoverToken, originRepo } from './auth.js';
import { ChecksApiBackend } from './checks-api.js';
import { EPOCH, inputsHash } from './key.js';

export type StoredRecord = {
  epoch: number;
  inputsHash: string;
  derivedHash: string; // sha256 of the derived lockfile, hex
  toolVersion: string;
  pnpmVersion: string;
  timestamp: string; // ISO-8601
};

const MARKER = 'lockfile-assay-memo:v1';

/** Embed a record inside a check-run summary, behind an HTML-comment marker so
 * it is invisible in rendered markdown and unambiguous to parse. Private to the
 * adapter — the transport (checks-api.ts) never sees a `StoredRecord` shape. */
function embedRecord(record: StoredRecord): string {
  return `<!--${MARKER} ${JSON.stringify(record)} -->`;
}

/** Extract a record from a check-run summary. Any deviation — no marker, broken
 * JSON, a missing/mistyped field — yields null (a miss, never a false record). */
function parseRecord(summary: string | null | undefined): StoredRecord | null {
  if (!summary) return null;
  const m = new RegExp(`<!--${MARKER} (\\{.*?\\}) -->`).exec(summary);
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
  // raw check-run views for every head SHA this PR has run against (current
  // chain + force-pushed-away heads). No filtering, no parsing — the adapter
  // owns both (the trust boundary lives here, not in the transport). Throws
  // on transport error; the adapter maps it to a miss.
  listRuns(): Promise<Array<{ appId?: number; conclusion: string; summary: string }>>;
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
    private readonly appId: number | null,
  ) {}

  async consult(files: StagedFile[], committed: Buffer | null): Promise<MemoProvenance | null> {
    if (!this.backend || !committed) return null;
    try {
      const want = inputsHash(files, INVOCATION);
      const committedHash = sha256(committed);
      for (const run of await this.backend.listRuns()) {
        // The security anchor (design §4, "why the app_id filter is
        // load-bearing"): only a *success* run authored by the configured
        // App id can ever be read as a record — a GITHUB_TOKEN/github-actions
        // check named `lockfile-assay` must never be read as a record.
        if (run.conclusion !== 'success' || run.appId !== this.appId) continue;
        const r = parseRecord(run.summary);
        if (!r) continue;
        if (r.epoch === EPOCH && r.inputsHash === want && r.derivedHash === committedHash) {
          // Stash the matched record so postVerdict re-embeds it on this
          // head's own success verdict — GC mitigation (design §4): if
          // GitHub later collects the head this record currently lives on,
          // a later consult still finds it directly on the current head.
          // Safe because derivedHash already equals sha256(committed).
          this.pending = r;
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

export const CHECK_NAME = 'lockfile-assay';

/**
 * Construct a memo driver from the ambient CI context. Requires a token, a
 * github origin, and the App id; missing any of them yields a null-object
 * driver (consult → miss, postVerdict → no-op). `pr` is needed only for consult
 * (posting a verdict needs the head SHA, not the PR number). `apiBase` /
 * `fetchImpl` are test seams.
 */
export function buildMemoDriver(opts: {
  write: boolean;
  pr?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): MemoDriver {
  const env = opts.env ?? process.env;
  const token = discoverToken(env);
  const repo = originRepo(opts.cwd);
  const id = appId(env);
  if (!token || !repo || id === null) return new MemoDriver(null, opts.write, null);
  const slash = repo.indexOf('/');
  const backend = new ChecksApiBackend({
    token,
    owner: repo.slice(0, slash),
    repo: repo.slice(slash + 1),
    appId: id,
    checkName: CHECK_NAME,
    pr: opts.pr,
    apiBase: opts.apiBase,
    fetchImpl: opts.fetchImpl,
  });
  return new MemoDriver(backend, opts.write, id);
}
