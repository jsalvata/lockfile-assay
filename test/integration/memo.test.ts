import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check.js';
import { makeMemoClient } from '../../src/memo/client.js';
import type { MemoRecord, MemoStore } from '../../src/memo/store.js';
import { type Fixture, makeFixtureRepo, relock } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { commitAll, writeFiles } from '../helpers/scratch-repo.js';

function memStore(): MemoStore & { size(): number } {
  const m = new Map<string, MemoRecord>();
  return {
    async get(e, h) {
      return m.get(`${e}/${h}`) ?? null;
    },
    async put(e, h, r) {
      m.set(`${e}/${h}`, r);
    },
    size: () => m.size,
  };
}

/** honest author path: bump in a dependency on alpha and relock against the live registry */
function bumpAlpha(f: Fixture): string {
  const pkg = JSON.parse(readFileSync(join(f.dir, 'package.json'), 'utf8'));
  pkg.dependencies = { alpha: '^1.0.0' };
  writeFiles(f.dir, { 'package.json': JSON.stringify(pkg, null, 2) });
  relock(f.dir);
  return commitAll(f.dir, 'bump alpha');
}

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
});
afterAll(() => registry.stop());

describe('derivation memo (spec §8)', () => {
  it('records on a live pass, then serves the hit with the REGISTRY DEAD', async () => {
    const store = memStore();
    const memo = makeMemoClient(store, { write: true });
    const f = await makeFixtureRepo(registry, {});
    const head = bumpAlpha(f);

    const live = await runCheck({ base: f.base, head, cwd: f.dir, memo });
    expect(live.outcome.kind).toBe('pass');
    expect(store.size()).toBe(1);

    await registry.stop(); // the registry is GONE — only a memo hit can pass now
    const remembered = await runCheck({ base: f.base, head, cwd: f.dir, memo });
    expect(remembered.outcome.kind).toBe('pass');
    expect(remembered.outcome.kind === 'pass' && remembered.outcome.memo?.hit).toBe(true);
    registry = await startRegistry(); // restore for the suite's afterAll + later tests
    await registry.publish({ name: 'alpha', version: '1.0.0' });
  });

  it('a mismatch is never memoised; a tampered lockfile cannot hit a stale record', async () => {
    const store = memStore();
    const memo = makeMemoClient(store, { write: true });
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    writeFiles(f.dir, {
      'pnpm-lock.yaml': `${readFileSync(join(f.dir, 'pnpm-lock.yaml'), 'utf8')}# tampered\n`,
    });
    const tampered = commitAll(f.dir, 'tamper');
    const r = await runCheck({ base: f.base, head: tampered, cwd: f.dir, memo });
    expect(r.outcome.kind).toBe('mismatch');
    expect(store.size()).toBe(0); // never memoised (spec §8 step 4)
  });

  it('write:false clients never write, even on a live derivation pass', async () => {
    const store = memStore();
    const memo = makeMemoClient(store, { write: false });
    const f = await makeFixtureRepo(registry, {});
    const head = bumpAlpha(f);
    const r = await runCheck({ base: f.base, head, cwd: f.dir, memo });
    // a REAL pass through the derive path — record() is reached and must no-op
    // (a vacuous pass would never consult the memo and prove nothing)
    expect(r.outcome.kind).toBe('pass');
    expect(store.size()).toBe(0);
  });
});
