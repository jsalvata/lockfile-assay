import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStagedCheck } from '../../src/check.js';
import { makeFixtureRepo } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { sh, writeFiles } from '../helpers/scratch-repo.js';

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
});
afterAll(() => registry.stop());

/** point origin at a clone of itself so origin/HEAD exists */
function addSelfOrigin(dir: string): void {
  sh(dir, 'git', ['clone', '-q', '--bare', '.', join(dir, '.self.git')]);
  sh(dir, 'git', ['remote', 'add', 'origin', join(dir, '.self.git')]);
  sh(dir, 'git', ['fetch', '-q', 'origin']);
  sh(dir, 'git', ['remote', 'set-head', 'origin', '-a']);
}

describe('check --staged', () => {
  it('vacuous on source-only staging; catches a staged tampered lockfile', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    addSelfOrigin(f.dir);

    writeFiles(f.dir, { 'src.ts': 'x' });
    sh(f.dir, 'git', ['add', 'src.ts']);
    expect((await runStagedCheck({ cwd: f.dir })).outcome.kind).toBe('vacuous-pass');

    const lock = readFileSync(join(f.dir, 'pnpm-lock.yaml'), 'utf8');
    writeFiles(f.dir, { 'pnpm-lock.yaml': `${lock}# tampered\n` });
    sh(f.dir, 'git', ['add', 'pnpm-lock.yaml']);
    const r = await runStagedCheck({ cwd: f.dir });
    expect(r.outcome.kind).toBe('mismatch');
    expect(r.exit).toBe(1);
  });

  it('degrades to cannot-evaluate without a remote default branch', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    writeFiles(f.dir, { 'pnpm-lock.yaml': '# junk\n' });
    sh(f.dir, 'git', ['add', 'pnpm-lock.yaml']);
    const r = await runStagedCheck({ cwd: f.dir });
    expect(r.outcome.kind).toBe('cannot-evaluate');
    expect(r.exit).toBe(0);
  });
});
