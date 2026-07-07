import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPrepush } from '../../src/prepush.js';
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

const ZERO = '0'.repeat(40);

describe('prepush', () => {
  it('a tampered tip aborts the push; a source-only tip is vacuous', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    addSelfOrigin(f.dir);

    writeFiles(f.dir, {
      'pnpm-lock.yaml': `${readFileSync(join(f.dir, 'pnpm-lock.yaml'), 'utf8')}# tampered\n`,
    });
    const tampered = commitAll(f.dir, 'tamper');
    const bad = await runPrepush({
      stdin: `refs/heads/x ${tampered} refs/heads/x ${ZERO}`,
      cwd: f.dir,
    });
    expect(bad.exit).toBe(1);
    expect(bad.tips).toHaveLength(1);
    expect(bad.tips[0]?.outcome.kind).toBe('mismatch');

    // rewind to base so the clean tip's net diff is source-only (the tampered
    // commit stays reachable by sha, mirroring a push of a separate branch)
    sh(f.dir, 'git', ['reset', '--hard', '-q', f.base]);
    writeFiles(f.dir, { 'src.ts': 'x' });
    const clean = commitAll(f.dir, 'source only');
    const ok = await runPrepush({
      stdin: `refs/heads/x ${clean} refs/heads/x ${ZERO}`,
      cwd: f.dir,
    });
    expect(ok.exit).toBe(0);
    expect(ok.tips[0]?.outcome.kind).toBe('vacuous-pass'); // fast path, not a full evaluate
  });

  it('deletion-only stdin evaluates nothing', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    addSelfOrigin(f.dir);
    const r = await runPrepush({
      stdin: `refs/heads/gone ${ZERO} refs/heads/gone abc`,
      cwd: f.dir,
    });
    expect(r.tips).toHaveLength(0);
    expect(r.exit).toBe(0);
  });

  it('degrades to cannot-evaluate per tip without an origin (standalone HEAD)', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    // no addSelfOrigin: base derivation is impossible — a broken env must not
    // brick the push (spec §8 degrade contract)
    const r = await runPrepush({ stdin: '', cwd: f.dir });
    expect(r.tips).toHaveLength(1);
    expect(r.tips[0]?.outcome.kind).toBe('cannot-evaluate');
    expect(r.exit).toBe(0);
  });
});

// The TRIGGERED path (a fresh resolve is genuinely needed) is where the push
// used to brick: `runCheck`'s derive failure threw past the `CannotEvaluate`
// catch → exit 3 → push dead. It must instead fail OPEN — degrade the tip and
// still evaluate the rest of the batch. Mirrors the B2 dead-registry test in
// staged.test.ts: a dedicated registry stopped mid-test so every fresh resolve
// genuinely fails.
describe('prepush fails open on a triggered tip against a dead registry', () => {
  it('degrades the failing tip to cannot-evaluate and still evaluates the next tip', async () => {
    // dedicated registry so we can stop it mid-test without disturbing the shared one
    const deadReg = await startRegistry();
    await deadReg.publish({ name: 'alpha', version: '1.0.0' });
    const f = await makeFixtureRepo(deadReg, { alpha: '^1.0.0' });
    addSelfOrigin(f.dir);

    // TIP 1 (triggered): commit a NEW dep absent from base's lockfile — a fresh
    // resolve is genuinely required, so with the registry down the derivation
    // fails. Kept reachable by sha after the rewind below (like a separate branch).
    stageNewDep(f.dir, 'beta', '^1.0.0');
    const triggered = commitAll(f.dir, 'add unresolved dependency');

    // TIP 2 (source-only): rewind to base and build a second tip whose net diff
    // touches no resolution input — its fast-path vacuous pass proves the batch
    // did not abort on tip 1.
    sh(f.dir, 'git', ['reset', '--hard', '-q', f.base]);
    writeFiles(f.dir, { 'src.ts': 'x' });
    const sourceOnly = commitAll(f.dir, 'source only');

    await deadReg.stop(); // now every fresh resolve genuinely fails

    const r = await runPrepush({
      stdin: [
        `refs/heads/a ${triggered} refs/heads/a ${ZERO}`,
        `refs/heads/b ${sourceOnly} refs/heads/b ${ZERO}`,
      ].join('\n'),
      cwd: f.dir,
    });

    // the triggered tip degrades — the bug: it used to throw and brick the push
    expect(r.tips).toHaveLength(2);
    expect(r.tips[0]?.outcome.kind).toBe('cannot-evaluate');
    // the batch continued: the second tip was still evaluated
    expect(r.tips[1]?.outcome.kind).toBe('vacuous-pass');
    // fail-open overall — a broken env never bricks the push (spec §8)
    expect(r.exit).toBe(0);
  });
});
