import { describe, expect, it } from 'vitest';
import { commitAll, makeRepo, sh, writeFiles } from '../test/helpers/scratch-repo.js';
import { runCheck } from './check.js';
import { revParse } from './git.js';

const PNPM = process.env.PNPM_FIXTURE_VERSION ?? '10.34.1';
const manifest = (extra: object = {}) =>
  JSON.stringify({ name: 't', version: '1.0.0', packageManager: `pnpm@${PNPM}`, ...extra });

function repoWithConfig(): string {
  return makeRepo({ 'package.json': manifest(), '.lockfile-assay.json': '{"mode":"enforce"}' });
}

describe('runCheck', () => {
  it('vacuous pass when no resolution input changed', async () => {
    const dir = repoWithConfig();
    const base = revParse('HEAD', dir);
    writeFiles(dir, { 'src.ts': 'x' });
    const head = commitAll(dir, 'source only');
    const r = await runCheck({ base, head, cwd: dir });
    expect(r.outcome.kind).toBe('vacuous-pass');
    expect(r.exit).toBe(0);
    // the fast path short-circuits BEFORE the config read, so no mode was
    // determined. Base config here says `enforce`; reporting 'off' would be a
    // flat lie that reads as "the assay is disabled in this repo".
    expect(r.mode).toBe('unknown');
  });

  it('not evaluated when base has no config', async () => {
    const dir = makeRepo({ 'package.json': manifest() });
    const base = revParse('HEAD', dir);
    writeFiles(dir, { 'package.json': manifest({ description: 'x' }) });
    const head = commitAll(dir, 'touch manifest');
    expect((await runCheck({ base, head, cwd: dir })).outcome.kind).toBe('not-evaluated');
  });

  it('unsupported input fails under enforce', async () => {
    const dir = repoWithConfig();
    const base = revParse('HEAD', dir);
    writeFiles(dir, { '.pnpmfile.cjs': 'module.exports = {}' });
    const head = commitAll(dir, 'add pnpmfile');
    const r = await runCheck({ base, head, cwd: dir });
    expect(r.outcome.kind).toBe('unsupported-input');
    expect(r.exit).toBe(1);
  });

  it('honest zero-dep lockfile change passes; tampered bytes mismatch', async () => {
    const dir = repoWithConfig();
    const base = revParse('HEAD', dir);
    // author path: derive the honest lockfile in the working tree and commit it
    sh(dir, 'corepack', ['pnpm', 'install', '--lockfile-only', '--ignore-scripts']);
    const head = commitAll(dir, 'add lockfile');
    const pass = await runCheck({ base, head, cwd: dir });
    expect(pass.outcome.kind).toBe('pass');

    writeFiles(dir, { 'pnpm-lock.yaml': `${sh(dir, 'cat', ['pnpm-lock.yaml'])}\n# tampered\n` });
    const tampered = commitAll(dir, 'tamper');
    const fail = await runCheck({ base, head: tampered, cwd: dir });
    expect(fail.outcome.kind).toBe('mismatch');
    expect(fail.exit).toBe(1);
    expect(fail.report.remedy).toContain('pnpm-lock.yaml');
  });
});
