import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheck, runStagedCheck } from '../../src/check.js';
import { addSelfOrigin, makeFixtureRepo } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { commitAll, sh, writeFiles } from '../helpers/scratch-repo.js';

/** stage a NEW dependency absent from base's lockfile, forcing a fresh resolve */
function stageNewDep(dir: string, name: string, range: string): void {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  pkg.dependencies = { ...pkg.dependencies, [name]: range };
  writeFiles(dir, { 'package.json': JSON.stringify(pkg, null, 2) });
  sh(dir, 'git', ['add', 'package.json']);
}

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
});
afterAll(() => registry.stop());

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

// pins the failClosed security invariant in BOTH directions: a genuinely failing
// resolve (dead registry, staged dep absent from base's lockfile) degrades in the
// local form (exit 0, never brick a commit — spec §8) but fails closed in the
// anchored CI form (throws). An inverted `failClosed` can't pass this silently.
describe('check --staged failClosed invariant (real resolve against a dead registry)', () => {
  it('local form degrades to cannot-evaluate; CI form fails closed on the same head', async () => {
    // dedicated registry so we can stop it mid-test without disturbing the shared one
    const deadReg = await startRegistry();
    await deadReg.publish({ name: 'alpha', version: '1.0.0' });
    const f = await makeFixtureRepo(deadReg, { alpha: '^1.0.0' });
    addSelfOrigin(f.dir);

    // stage a dep that is NOT published and NOT in base's lockfile: pnpm must hit
    // the registry to resolve it. Staged-but-uncommitted so the local form's
    // HEAD→index trigger fires.
    stageNewDep(f.dir, 'beta', '^1.0.0');

    await deadReg.stop(); // now every fresh resolve genuinely fails

    // local form: a broken/offline env must not brick the commit
    const local = await runStagedCheck({ cwd: f.dir });
    expect(local.outcome.kind).toBe('cannot-evaluate');
    expect(local.exit).toBe(0);

    // CI form: commit that same increment as a head and check base→head. The
    // identical unresolvable resolve fails closed (fails red at the CLI).
    const head = commitAll(f.dir, 'add unresolved dependency');
    await expect(runCheck({ base: f.base, head, cwd: f.dir })).rejects.toThrow();
  });
});
