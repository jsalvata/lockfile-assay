import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check.js';
import { revParse } from '../../src/git.js';
import { makeFixtureRepo, readLock, relock } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { commitAll, sh, writeFiles } from '../helpers/scratch-repo.js';

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
  await registry.publish({ name: 'alpha', version: '1.1.0' });
  await registry.publish({ name: 'beta', version: '2.0.0', dependencies: { alpha: '^1.0.0' } });
});
afterAll(() => registry.stop());

describe('spec §3 empirics', () => {
  it('two independent from-scratch resolves are byte-identical', async () => {
    const a = await makeFixtureRepo(registry, { beta: '^2.0.0' });
    const b = await makeFixtureRepo(registry, { beta: '^2.0.0' });
    expect(readLock(a.dir)).toBe(readLock(b.dir));
  });

  it('the checker reproduces the committed lockfile however the author edited the manifest', async () => {
    // Spec §3 (as narrowed): the property the checker relies on is NOT that the
    // author's `pnpm add` produces byte-identical output to a hand-edit — it does
    // not on pnpm ≥ 10, which rewrites the saved specifier to the caret of the
    // resolved version. The property is that the checker re-derives the COMMITTED
    // lockfile from the COMMITTED manifest, so *each* author edit yields an
    // internally consistent manifest+lockfile pair that the checker reproduces.
    //
    // Path A and Path B commit DIFFERENT bytes (the `alpha:` specifier line in
    // package.json differs — `pnpm add` rewrites it, the hand-edit keeps `^1.0.0`),
    // yet each pair is self-consistent, so runCheck passes on both. That agreement
    // between author and checker — not byte-identity across authoring methods — is
    // what the tool actually guarantees.

    // Path A: `pnpm add` (the path that rewrites the specifier on pnpm ≥ 10)
    const viaAdd = await makeFixtureRepo(registry, {});
    sh(viaAdd.dir, 'corepack', [
      'pnpm',
      'add',
      '--lockfile-only',
      '--ignore-scripts',
      'alpha@^1.0.0',
    ]);
    const headAdd = commitAll(viaAdd.dir, 'author: pnpm add alpha');
    const rAdd = await runCheck({ base: viaAdd.base, head: headAdd, cwd: viaAdd.dir });
    expect(rAdd.outcome.kind).toBe('pass');

    // Path B: hand-edit the manifest, then relock
    const viaEdit = await makeFixtureRepo(registry, {});
    const pkg = JSON.parse(sh(viaEdit.dir, 'cat', ['package.json']));
    pkg.dependencies = { ...pkg.dependencies, alpha: '^1.0.0' };
    writeFiles(viaEdit.dir, { 'package.json': JSON.stringify(pkg, null, 2) });
    relock(viaEdit.dir);
    const headEdit = commitAll(viaEdit.dir, 'author: hand-edit + relock');
    const rEdit = await runCheck({ base: viaEdit.base, head: headEdit, cwd: viaEdit.dir });
    expect(rEdit.outcome.kind).toBe('pass');
  });

  it('re-running install on an in-sync tree rewrites nothing', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    const before = readLock(f.dir);
    relock(f.dir);
    expect(readLock(f.dir)).toBe(before);
  });

  it('still-satisfying locked versions are reused, not re-resolved', async () => {
    // base locks alpha@1.1.0 via beta’s ^1.0.0; a NEWER alpha appears; untouched specs must not move
    const f = await makeFixtureRepo(registry, { beta: '^2.0.0' });
    await registry.publish({ name: 'alpha', version: '1.2.0' });
    writeFiles(f.dir, {
      'README.md': 'touch a resolution-irrelevant file? no — touch the manifest',
    });
    // change an unrelated manifest field so the check actually stages and re-derives
    const pkg = JSON.parse(sh(f.dir, 'cat', ['package.json']));
    pkg.description = 'bump nothing';
    writeFiles(f.dir, { 'package.json': JSON.stringify(pkg, null, 2) });
    const head = commitAll(f.dir, 'manifest touch');
    const r = await runCheck({ base: f.base, head, cwd: f.dir });
    expect(r.outcome.kind).toBe('pass'); // lockfile unchanged and still derivable ⇒ alpha stayed locked
    expect(readLock(f.dir)).not.toContain('alpha@1.2.0');
  });

  it('an honest dependency bump passes the check', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    const pkg = JSON.parse(sh(f.dir, 'cat', ['package.json']));
    pkg.dependencies.beta = '^2.0.0';
    writeFiles(f.dir, { 'package.json': JSON.stringify(pkg, null, 2) });
    relock(f.dir); // author refreshes honestly
    const head = commitAll(f.dir, 'add beta');
    const r = await runCheck({ base: f.base, head, cwd: f.dir });
    expect(r.outcome.kind).toBe('pass');
    expect(revParse('HEAD', f.dir)).toBe(head);
  });
});
