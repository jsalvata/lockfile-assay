import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_PATH, parseConfig } from './config.js';
import { derive } from './derive.js';
import { CannotEvaluate } from './errors.js';
import {
  catFile,
  diffNames,
  diffNamesIndex,
  lsTreePaths,
  mergeBase,
  remoteDefaultBranch,
  revParse,
  writeIndexTree,
} from './git.js';
import type { MemoProvenance, Mode, Outcome } from './outcome.js';
import { exitCode } from './outcome.js';
import { unsupportedInputs } from './preflight.js';
import { deltaSummary } from './report/delta.js';
import type { ReportInput } from './report/render.js';
import { diffExcerpt, refreshRecipe } from './report/render.js';
import type { StagedFile } from './staging.js';
import { collectStagedFiles, materialize } from './staging.js';
import { effectivePnpmVersion, parsePin } from './toolchain.js';
import { declaredPatchPaths, isTriggered } from './trigger.js';
import { bytesEqual } from './verdict.js';

export type MemoHook = {
  consult(files: StagedFile[], committed: Buffer | null): Promise<MemoProvenance | null>;
  record(files: StagedFile[], derived: Buffer): Promise<void>;
};

export type CheckResult = { outcome: Outcome; mode: Mode; exit: 0 | 1; report: ReportInput };

function result(
  outcome: Outcome,
  mode: Mode,
  base: string | null,
  head: string,
  extra: Partial<ReportInput> = {},
): CheckResult {
  return {
    outcome,
    mode,
    exit: exitCode(outcome, mode),
    report: { outcome, mode, base, head, ...extra },
  };
}

/** anchored CI form (spec §5): base and head are commits; a derive failure fails red */
export async function runCheck(opts: {
  base: string;
  head: string;
  cwd?: string;
  memo?: MemoHook | null;
}): Promise<CheckResult> {
  const cwd = opts.cwd;
  const base = revParse(opts.base, cwd);
  const head = revParse(opts.head, cwd);

  const declared = declaredPatchPaths(
    catFile(head, 'pnpm-workspace.yaml', cwd),
    catFile(head, 'package.json', cwd),
  );
  if (!isTriggered(diffNames(base, head, cwd), declared))
    return result({ kind: 'vacuous-pass' }, 'off', base, head);

  return evaluate({
    base,
    headTree: head,
    headLabel: head,
    cwd,
    memo: opts.memo ?? null,
    failClosed: true,
  });
}

/**
 * commit-time form (spec §8): head is the index tree, base is the merge-base
 * with the remote default branch, and the trigger is the STAGED increment
 * (HEAD→index) — a commit staging no resolution input passes vacuously.
 * Anything that prevents evaluation degrades to `cannot-evaluate` (exit 0):
 * a broken local environment must never brick a commit; the anchored CI
 * check still gates the merge.
 */
export async function runStagedCheck(
  opts: { cwd?: string; memo?: MemoHook | null } = {},
): Promise<CheckResult> {
  const cwd = opts.cwd;
  try {
    const remoteDefault = remoteDefaultBranch(cwd);
    if (!remoteDefault) {
      return cannotEvaluate(
        'no origin default branch — cannot derive the PR base; the required check still gates the merge',
      );
    }
    const base = mergeBase(remoteDefault, 'HEAD', cwd);
    if (!base) return cannotEvaluate(`no merge-base with ${remoteDefault}`);

    const staged = diffNamesIndex(cwd);
    const declared = declaredPatchPaths(
      catFile('HEAD', 'pnpm-workspace.yaml', cwd),
      catFile('HEAD', 'package.json', cwd),
    );
    if (!isTriggered(staged, declared))
      return result({ kind: 'vacuous-pass' }, 'off', base, 'INDEX');

    const headTree = writeIndexTree(cwd);
    return await evaluate({
      base,
      headTree,
      headLabel: 'INDEX',
      cwd,
      memo: opts.memo ?? null,
      failClosed: false,
    });
  } catch (e) {
    // map CannotEvaluate to the outcome (not the process-level handler) so
    // --json still emits a report
    if (e instanceof CannotEvaluate) return cannotEvaluate(e.message);
    throw e;
  }
}

function cannotEvaluate(reason: string): CheckResult {
  const outcome: Outcome = { kind: 'cannot-evaluate', reason };
  return {
    outcome,
    mode: 'off',
    exit: 0,
    report: { outcome, mode: 'off', base: null, head: 'INDEX' },
  };
}

/**
 * Shared evaluation tail: config → staging → preflight → pin → memo →
 * materialize → skew → derive → verdict → report. `headTree` is any tree-ish
 * (a commit for the CI form, the index tree for the local forms); `headLabel`
 * is what the report calls head. `failClosed` picks the derive-failure
 * posture: the anchored CI form throws (the check fails red), the local forms
 * degrade to `cannot-evaluate` (spec §8).
 */
async function evaluate(opts: {
  base: string;
  headTree: string;
  headLabel: string;
  cwd?: string;
  memo: MemoHook | null;
  failClosed: boolean;
}): Promise<CheckResult> {
  const { base, headLabel, cwd } = opts;
  const head = revParse(opts.headTree, cwd, { allowTree: true });

  const mode = parseConfig(catFile(base, CONFIG_PATH, cwd));
  if (mode === 'off') return result({ kind: 'not-evaluated' }, mode, base, headLabel);

  const declared = declaredPatchPaths(
    catFile(head, 'pnpm-workspace.yaml', cwd),
    catFile(head, 'package.json', cwd),
  );
  const baseHasLock = catFile(base, 'pnpm-lock.yaml', cwd) !== null;
  const files = collectStagedFiles({
    baseRef: baseHasLock ? base : null,
    headRef: head,
    declared,
    cwd,
  });

  const reasons = unsupportedInputs(files, lsTreePaths(head, cwd));
  if (reasons.length > 0)
    return result({ kind: 'unsupported-input', reasons }, mode, base, headLabel);

  const pin = parsePin(catFile(head, 'package.json', cwd));
  const committed = catFile(head, 'pnpm-lock.yaml', cwd);

  const memoHit = (await opts.memo?.consult(files, committed)) ?? null;
  if (memoHit) return result({ kind: 'pass', memo: memoHit }, mode, base, headLabel);

  const dir = mkdtempSync(join(tmpdir(), 'lockfile-assay-'));
  materialize(files, dir);

  const effective = effectivePnpmVersion(dir);
  if (effective !== pin.version) {
    return result(
      { kind: 'toolchain-skew', pinned: pin.version, effective },
      mode,
      base,
      headLabel,
      {
        toolchain: { pinned: pin.version, effective },
      },
    );
  }

  const derived = derive(dir);
  if (!derived.ok) {
    // resolver/network failure: the CI form fails red in any mode (exit 3 at
    // the CLI boundary); the local forms degrade — spec §8
    if (opts.failClosed)
      throw new Error(`derivation failed (pnpm exit ${derived.status}):\n${derived.stderr}`);
    const tail = derived.stderr.trim().split('\n').slice(-5).join('\n');
    return result(
      {
        kind: 'cannot-evaluate',
        reason: `derivation failed (pnpm exit ${derived.status}): ${tail}`,
      },
      mode,
      base,
      headLabel,
    );
  }

  if (bytesEqual(committed, derived.lockfile)) {
    await opts.memo?.record(files, derived.lockfile);
    return result({ kind: 'pass' }, mode, base, headLabel, {
      toolchain: { pinned: pin.version, effective },
    });
  }

  return result({ kind: 'mismatch', committed, derived: derived.lockfile }, mode, base, headLabel, {
    toolchain: { pinned: pin.version, effective },
    deltas: deltaSummary(committed, derived.lockfile),
    diffExcerpt: diffExcerpt(committed, derived.lockfile),
    remedy: refreshRecipe(baseHasLock ? base : null),
  });
}
