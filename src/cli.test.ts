import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildProgram, resolveMemo } from './cli.js';
import { UsageError } from './errors.js';

// Regression guard for the "silently ignored flag" wart: `check --staged` builds
// a read-only memo (spec §8: local hook forms never write), so --memo-write can
// never take effect there. It must be rejected loudly, not swallowed. Driving the
// real commander program proves both that the flag is declared AND that the guard
// fires before any work — parseAsync rejects with the thrown UsageError.
describe('check CLI: --memo-write is incompatible with --staged', () => {
  it('rejects the combo with a UsageError that names the flag', async () => {
    await expect(
      buildProgram().parseAsync(['check', '--staged', '--memo-write'], { from: 'user' }),
    ).rejects.toThrow(UsageError);
    await expect(
      buildProgram().parseAsync(['check', '--staged', '--memo-write'], { from: 'user' }),
    ).rejects.toThrow(/--memo-write cannot be combined with --staged/);
  });
});

// resolveMemo decides whether the memo can initialize; the check action warns on
// `--memo-write` when it can't — a disabled writer means later runs re-derive and
// an unchanged lockfile can spuriously mismatch on registry drift (spec §8).
describe('resolveMemo — memo availability', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'assay-resolvememo-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves repo + token from a github origin and an env token', () => {
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:octo/assay.git'], { cwd: dir });
    expect(resolveMemo({ cwd: dir, env: { LOCKFILE_ASSAY_TOKEN: 'ghs_x' } })).toEqual({
      repo: 'octo/assay',
      token: 'ghs_x',
    });
  });

  it('unavailable (origin) when the origin is not a github remote', () => {
    execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.com:octo/assay.git'], { cwd: dir });
    const m = resolveMemo({ cwd: dir, env: { LOCKFILE_ASSAY_TOKEN: 'ghs_x' } });
    expect('unavailable' in m && m.unavailable).toMatch(/github/i);
  });

  it('unavailable (token) with a github origin but no discoverable token', () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octo/assay.git'], {
      cwd: dir,
    });
    // empty PATH so `gh` is unfindable and no env token is set → no token
    const noPath = mkdtempSync(join(tmpdir(), 'assay-nogh-'));
    try {
      const m = resolveMemo({ cwd: dir, env: { PATH: noPath } });
      expect('unavailable' in m && m.unavailable).toMatch(/token/i);
    } finally {
      rmSync(noPath, { recursive: true, force: true });
    }
  });
});
