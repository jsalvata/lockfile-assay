import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoHook } from './check.js';
import { buildProgram, lazyMemoClient, memoWarning, resolveMemo } from './cli.js';
import { UsageError } from './errors.js';
import type { StagedFile } from './staging.js';

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

// The --memo-write warning is CI-only; a plain stderr line is easy to miss in an
// Actions log, so under GITHUB_ACTIONS it becomes a `::warning::` command the
// runner renders as a PR / run-summary annotation. Either form is stderr-only.
describe('memoWarning — channel by environment', () => {
  const REASON = 'origin is not a github.com remote';

  it('plain warning line outside GitHub Actions', () => {
    const w = memoWarning(REASON, {});
    expect(w.startsWith('warning: --memo-write is set but the memo is unavailable')).toBe(true);
    expect(w).toContain(`(${REASON})`);
    expect(w).toContain('docs/setup-github-app.md');
    expect(w.startsWith('::warning::')).toBe(false);
  });

  it('GitHub Actions annotation command under GITHUB_ACTIONS=true', () => {
    const w = memoWarning(REASON, { GITHUB_ACTIONS: 'true' });
    expect(w.startsWith('::warning::')).toBe(true);
    expect(w).toContain(`the memo is unavailable (${REASON})`);
    expect(w).toContain('docs/setup-github-app.md');
  });

  it('escapes the runner-reserved percent in the Actions command message', () => {
    const w = memoWarning('weird%reason', { GITHUB_ACTIONS: 'true' });
    expect(w).toContain('weird%25reason');
  });
});

// buildMemo wraps its credential discovery in lazyMemoClient so resolveMemo's
// git/gh subprocesses run only if evaluate() actually reaches consult/record — a
// vacuous run (the common source-only commit/push) resolves nothing.
describe('lazyMemoClient — defers make() to first use', () => {
  const FILES: StagedFile[] = [{ path: 'pnpm-lock.yaml', bytes: Buffer.from('x') }];
  const COMMITTED = Buffer.from('committed');
  const DERIVED = Buffer.from('derived');

  function countingHook(): MemoHook & { calls: { consult: number; record: number } } {
    const calls = { consult: 0, record: 0 };
    return {
      calls,
      async consult() {
        calls.consult++;
        return null;
      },
      async record() {
        calls.record++;
      },
    };
  }

  it('does not call make() at construction — a vacuous run never resolves', () => {
    let made = 0;
    lazyMemoClient(() => {
      made++;
      return countingHook();
    });
    expect(made).toBe(0);
  });

  it('calls make() exactly once across repeated consult/record (memoised)', async () => {
    let made = 0;
    const inner = countingHook();
    const memo = lazyMemoClient(() => {
      made++;
      return inner;
    });
    await memo.consult(FILES, COMMITTED);
    await memo.record(FILES, DERIVED);
    await memo.consult(FILES, COMMITTED);
    expect(made).toBe(1); // once, not per call (nor per prepush tip)
    expect(inner.calls.consult).toBe(2);
    expect(inner.calls.record).toBe(1);
  });

  it('delegates consult/record arguments to the made hook', async () => {
    const seen: { consult?: unknown[]; record?: unknown[] } = {};
    const memo = lazyMemoClient(() => ({
      async consult(f, c) {
        seen.consult = [f, c];
        return null;
      },
      async record(f, d, p) {
        seen.record = [f, d, p];
      },
    }));
    await memo.consult(FILES, COMMITTED);
    await memo.record(FILES, DERIVED, '9.12.0');
    expect(seen.consult).toEqual([FILES, COMMITTED]);
    expect(seen.record).toEqual([FILES, DERIVED, '9.12.0']);
  });
});
