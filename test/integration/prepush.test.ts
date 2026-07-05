import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPrepush } from '../../src/prepush.js';
import { addSelfOrigin, makeFixtureRepo } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { commitAll, sh, writeFiles } from '../helpers/scratch-repo.js';

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
