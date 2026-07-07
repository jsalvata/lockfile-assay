import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check.js';
import { makeFixtureRepo, relock } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { commitAll, sh, writeFiles } from '../helpers/scratch-repo.js';

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
});
afterAll(() => registry.stop());

describe('spec §7 drift + §4 self-healing remedy', () => {
  it('registry drift on a floor-moved spec mismatches, and the refresh recipe converges to pass', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    // author bumps the floor and locks against today’s registry (publish 1.1.0, then lock)
    await registry.publish({ name: 'alpha', version: '1.1.0' });
    const pkg = JSON.parse(readFileSync(join(f.dir, 'package.json'), 'utf8'));
    pkg.dependencies.alpha = '^1.1.0';
    writeFiles(f.dir, { 'package.json': JSON.stringify(pkg, null, 2) });
    relock(f.dir);
    const head = commitAll(f.dir, 'bump alpha floor');

    // the registry moves before CI runs: a newer in-range alpha appears
    await registry.publish({ name: 'alpha', version: '1.2.0' });
    const drifted = await runCheck({ base: f.base, head, cwd: f.dir });
    expect(drifted.outcome.kind).toBe('mismatch'); // honest PR blocked — fail-closed residual, spec §7

    // apply the report’s refresh recipe verbatim (spec §4)
    sh(f.dir, 'sh', ['-c', `git show ${f.base}:pnpm-lock.yaml > pnpm-lock.yaml`]);
    relock(f.dir);
    const refreshed = commitAll(f.dir, 'refresh lockfile');
    const healed = await runCheck({ base: f.base, head: refreshed, cwd: f.dir });
    expect(healed.outcome.kind).toBe('pass'); // self-healing: refresh replaces drift (and poison) with honest bytes
  });

  it('no-base-lockfile adoption PR derives from scratch and passes honestly', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    // rebuild a base WITHOUT a lockfile: delete it in a new commit
    sh(f.dir, 'git', ['rm', '-q', 'pnpm-lock.yaml']);
    const base = commitAll(f.dir, 'drop lockfile');
    relock(f.dir);
    const head = commitAll(f.dir, 'adopt pnpm lockfile');
    const r = await runCheck({ base, head, cwd: f.dir });
    expect(r.outcome.kind).toBe('pass');
  });

  it('lockfile deleted in head while base keeps one is a fail-closed mismatch', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    sh(f.dir, 'git', ['rm', '-q', 'pnpm-lock.yaml']);
    const head = commitAll(f.dir, 'delete lockfile');
    const r = await runCheck({ base: f.base, head, cwd: f.dir });
    expect(r.outcome.kind).toBe('mismatch');
  });
});
