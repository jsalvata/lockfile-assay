import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_PATH, parseConfig } from './config.js';
import { derive } from './derive.js';
import { catFile, diffNames, lsTreePaths, revParse } from './git.js';
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

  const mode = parseConfig(catFile(base, CONFIG_PATH, cwd));
  if (mode === 'off') return result({ kind: 'not-evaluated' }, mode, base, head);

  const baseHasLock = catFile(base, 'pnpm-lock.yaml', cwd) !== null;
  const files = collectStagedFiles({
    baseRef: baseHasLock ? base : null,
    headRef: head,
    declared,
    cwd,
  });

  const reasons = unsupportedInputs(files, lsTreePaths(head, cwd));
  if (reasons.length > 0) return result({ kind: 'unsupported-input', reasons }, mode, base, head);

  const pin = parsePin(catFile(head, 'package.json', cwd));
  const committed = catFile(head, 'pnpm-lock.yaml', cwd);

  const memoHit = (await opts.memo?.consult(files, committed)) ?? null;
  if (memoHit) return result({ kind: 'pass', memo: memoHit }, mode, base, head);

  const dir = mkdtempSync(join(tmpdir(), 'lockfile-assay-'));
  materialize(files, dir);

  const effective = effectivePnpmVersion(dir);
  if (effective !== pin.version) {
    return result({ kind: 'toolchain-skew', pinned: pin.version, effective }, mode, base, head, {
      toolchain: { pinned: pin.version, effective },
    });
  }

  const derived = derive(dir);
  if (!derived.ok) {
    // resolver/network failure: CI form fails red in any mode (exit 3 at the CLI boundary)
    throw new Error(`derivation failed (pnpm exit ${derived.status}):\n${derived.stderr}`);
  }

  if (bytesEqual(committed, derived.lockfile)) {
    await opts.memo?.record(files, derived.lockfile);
    return result({ kind: 'pass' }, mode, base, head, {
      toolchain: { pinned: pin.version, effective },
    });
  }

  return result({ kind: 'mismatch', committed, derived: derived.lockfile }, mode, base, head, {
    toolchain: { pinned: pin.version, effective },
    deltas: deltaSummary(committed, derived.lockfile),
    diffExcerpt: diffExcerpt(committed, derived.lockfile),
    remedy: refreshRecipe(baseHasLock ? base : null),
  });
}
