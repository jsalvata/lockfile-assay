import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Mode, Outcome } from '../outcome.js';
import { toolVersion } from '../version.js';
import type { Delta } from './delta.js';

export const SCHEMA_VERSION = 1;

const TOOL_VERSION: string = toolVersion();

export type ReportInput = {
  outcome: Outcome;
  mode: Mode | 'unknown';
  base: string | null;
  head: string;
  toolchain?: { pinned: string; effective: string };
  deltas?: Delta[];
  diffExcerpt?: string;
  remedy?: string;
};

export function refreshRecipe(baseRef: string | null): string {
  const restore =
    baseRef === null
      ? 'rm pnpm-lock.yaml                                 # base had no lockfile: derive from scratch'
      : `git show ${baseRef}:pnpm-lock.yaml > pnpm-lock.yaml   # restore the reviewed prior state`;
  return [
    restore,
    'pnpm install --lockfile-only --ignore-scripts --prefer-frozen-lockfile',
    'git add pnpm-lock.yaml && git commit              # or --amend, as fits the branch',
  ].join('\n');
}

export function diffExcerpt(committed: Buffer | null, derived: Buffer, maxLines = 100): string {
  const dir = mkdtempSync(join(tmpdir(), 'assay-diff-'));
  writeFileSync(join(dir, 'committed'), committed ?? Buffer.alloc(0));
  writeFileSync(join(dir, 'derived'), derived);
  let out = '';
  try {
    execFileSync('git', ['diff', '--no-index', '--', 'committed', 'derived'], {
      cwd: dir,
      encoding: 'utf8',
    });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? ''; // git diff exits 1 on differences; the diff is on stdout
  }
  const lines = out.split('\n');
  if (lines.length <= maxLines) return out;
  const head = lines.slice(0, maxLines / 2);
  const tail = lines.slice(-maxLines / 2 + 1);
  return [...head, `… elided … (${lines.length - maxLines + 1} lines)`, ...tail].join('\n');
}

export function renderJson(r: ReportInput): string {
  const memo = r.outcome.kind === 'pass' ? r.outcome.memo : undefined;
  const reasons = r.outcome.kind === 'unsupported-input' ? r.outcome.reasons : undefined;
  const reason = r.outcome.kind === 'cannot-evaluate' ? r.outcome.reason : undefined;
  const skew =
    r.outcome.kind === 'toolchain-skew'
      ? { pinned: r.outcome.pinned, effective: r.outcome.effective }
      : r.toolchain;
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      tool: { name: 'lockfile-assay', version: TOOL_VERSION },
      outcome: r.outcome.kind,
      mode: r.mode,
      base: r.base,
      head: r.head,
      toolchain: skew,
      memo,
      reasons,
      reason,
      delta: r.deltas,
      diffExcerpt: r.diffExcerpt,
      remedy: r.remedy,
    },
    null,
    2,
  );
}

export function renderHuman(r: ReportInput): string {
  const lines: string[] = [`lockfile-assay: ${r.outcome.kind} (mode: ${r.mode})`];
  if (r.outcome.kind === 'pass' && r.outcome.memo?.hit) {
    lines.push(`served from derivation memo (derivedAt ${r.outcome.memo.derivedAt ?? '?'})`);
  }
  if (r.outcome.kind === 'toolchain-skew') {
    lines.push(
      `pinned pnpm ${r.outcome.pinned} but effective ${r.outcome.effective} — align your toolchain, then re-run`,
    );
  }
  if (r.outcome.kind === 'unsupported-input') {
    for (const reason of r.outcome.reasons) lines.push(`unsupported: ${reason}`);
  }
  if (r.outcome.kind === 'mismatch') {
    lines.push('', 'the committed lockfile is NOT what honest re-derivation produces.', '');
    for (const d of r.deltas ?? [])
      lines.push(`  ${d.pkg}: committed ${d.committed ?? '—'} / derived ${d.derived ?? '—'}`);
    if (r.diffExcerpt) lines.push('', r.diffExcerpt);
    if (r.remedy)
      lines.push(
        '',
        'refresh recipe (a version delta reads as drift; a tarball: URL or novel edge reads as an attack — read before you refresh):',
        r.remedy,
      );
  }
  if (r.outcome.kind === 'cannot-evaluate') lines.push(r.outcome.reason);
  return lines.join('\n');
}
