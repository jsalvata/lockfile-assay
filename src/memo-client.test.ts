import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION } from './derive.js';
import { discoverToken, originRepo } from './memo/auth.js';
import { makeMemoClient } from './memo/client.js';
import { EPOCH, inputsHash } from './memo/key.js';
import type { MemoRecord, MemoStore } from './memo/store.js';
import type { StagedFile } from './staging.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// In-memory MemoStore stub: a Map keyed by `${epoch}\0${hash}`.
function memStore(): MemoStore & { calls: { get: number; put: number } } {
  const map = new Map<string, MemoRecord>();
  const calls = { get: 0, put: 0 };
  const k = (epoch: number, hash: string) => `${epoch}\0${hash}`;
  return {
    calls,
    async get(epoch, hash) {
      calls.get++;
      return map.get(k(epoch, hash)) ?? null;
    },
    async put(epoch, hash, record) {
      calls.put++;
      map.set(k(epoch, hash), record);
    },
  };
}

const FILES: StagedFile[] = [{ path: 'pnpm-lock.yaml', bytes: Buffer.from('committed-lock') }];
const COMMITTED = Buffer.from('committed-lock-content');
const DERIVED = Buffer.from('derived-lock-content');

function seed(store: MemoStore, committed: Buffer, extra: Partial<MemoRecord> = {}) {
  return store.put(EPOCH, inputsHash(FILES, INVOCATION), {
    derivedLockfileSha256: sha256(committed),
    toolVersion: '9.9.9',
    pnpmVersion: '10.34.1',
    derivedAt: '2026-07-04T12:00:00.000Z',
    ...extra,
  });
}

describe('makeMemoClient — consult (the trust boundary, spec §8)', () => {
  it('committed === null → null (nothing to match against)', async () => {
    const store = memStore();
    const client = makeMemoClient(store, { write: false });
    expect(await client.consult(FILES, null)).toBeNull();
    expect(store.calls.get).toBe(0);
  });

  it('HIT when the stored derivedLockfileSha256 equals sha256(committed); returns provenance', async () => {
    const store = memStore();
    await seed(store, COMMITTED, { derivedAt: '2026-07-04T12:00:00.000Z', toolVersion: '9.9.9' });
    const client = makeMemoClient(store, { write: false });

    const hit = await client.consult(FILES, COMMITTED);
    expect(hit).toEqual({
      hit: true,
      derivedAt: '2026-07-04T12:00:00.000Z',
      toolVersion: '9.9.9',
    });
  });

  it('stale record (different lockfile sha) → null (falls through to a live resolve — never a false pass)', async () => {
    const store = memStore();
    // stored record matches a DIFFERENT committed lockfile
    await seed(store, Buffer.from('some-other-committed-lock'));
    const client = makeMemoClient(store, { write: false });
    expect(await client.consult(FILES, COMMITTED)).toBeNull();
  });

  it('no record at all → null', async () => {
    const store = memStore();
    const client = makeMemoClient(store, { write: false });
    expect(await client.consult(FILES, COMMITTED)).toBeNull();
  });

  // C3 carry-forward: store.get has NO shape validation. A malformed 200 from
  // GitHub could hand us junk. A hit must require a well-formed object with a
  // STRING derivedLockfileSha256 — junk is a MISS (null), never a hit.
  describe('malformed record → MISS (C3 defense-in-depth)', () => {
    for (const [name, junk] of [
      ['empty object', {}],
      ['array', []],
      [
        'numeric sha',
        { derivedLockfileSha256: 42, toolVersion: 'x', pnpmVersion: 'y', derivedAt: 'z' },
      ],
      ['null-ish primitive', 7],
      [
        'null derivedAt/toolVersion missing but sha matches',
        { derivedLockfileSha256: sha256(COMMITTED) },
      ],
    ] as const) {
      it(name, async () => {
        const store: MemoStore = {
          get: async () => junk as unknown as MemoRecord,
          put: async () => {},
        };
        const client = makeMemoClient(store, { write: false });
        const result = await client.consult(FILES, COMMITTED);
        // For the "sha matches but other fields missing" case, a strict guard
        // must still reject it (all four fields must be well-typed).
        expect(result).toBeNull();
      });
    }
  });
});

describe('makeMemoClient — record (write gate, spec §8)', () => {
  it('write: false NEVER calls store.put (local forms never write)', async () => {
    const store = memStore();
    const client = makeMemoClient(store, { write: false });
    await client.record(FILES, DERIVED);
    expect(store.calls.put).toBe(0);
  });

  it('write: true persists sha256(derived) with tool + pnpm version and an ISO derivedAt', async () => {
    const store = memStore();
    const before = Date.now();
    const client = makeMemoClient(store, { write: true, pnpmVersion: '10.34.1' });
    await client.record(FILES, DERIVED);
    expect(store.calls.put).toBe(1);

    const stored = await store.get(EPOCH, inputsHash(FILES, INVOCATION));
    expect(stored).not.toBeNull();
    expect(stored?.derivedLockfileSha256).toBe(sha256(DERIVED));
    expect(stored?.pnpmVersion).toBe('10.34.1');
    expect(typeof stored?.toolVersion).toBe('string');
    // ISO-8601 timestamp from a real `new Date()` — this runs in production.
    expect(stored?.derivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Date.parse(stored?.derivedAt ?? '')).toBeGreaterThanOrEqual(before);
  });

  // The effective pnpm version is known only at the call site (check.ts, post-derive),
  // not at construction — so a per-call version overrides the construction opt, and
  // that is what real records carry (spec §8 provenance, was always 'unknown' before).
  it('a per-call pnpmVersion (from check.ts) overrides the construction opt', async () => {
    const store = memStore();
    const client = makeMemoClient(store, { write: true, pnpmVersion: 'construction-default' });
    await client.record(FILES, DERIVED, '9.12.0');
    const stored = await store.get(EPOCH, inputsHash(FILES, INVOCATION));
    expect(stored?.pnpmVersion).toBe('9.12.0');
  });

  // Fix (spec §12 Q7): provenance must record the REAL tool version. The version
  // is read from package.json, NOT `npm_package_version` — that env var is unset
  // when a git hook invokes node directly, which used to stamp every record
  // 'unknown' and defeat the diagnostic purpose.
  it('records the package.json toolVersion (not "unknown") even when npm_package_version is unset', async () => {
    const saved = process.env.npm_package_version;
    delete process.env.npm_package_version; // emulate a git-hook invocation (env var unset)
    try {
      const pkgVersion = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      ).version as string;

      const store = memStore();
      const client = makeMemoClient(store, { write: true, pnpmVersion: '10.34.1' });
      await client.record(FILES, DERIVED);

      const stored = await store.get(EPOCH, inputsHash(FILES, INVOCATION));
      expect(stored?.toolVersion).toBe(pkgVersion);
      expect(stored?.toolVersion).not.toBe('unknown');
    } finally {
      if (saved === undefined) delete process.env.npm_package_version;
      else process.env.npm_package_version = saved;
    }
  });

  it('pnpmVersion defaults to "unknown" when omitted', async () => {
    const store = memStore();
    const client = makeMemoClient(store, { write: true });
    await client.record(FILES, DERIVED);
    const stored = await store.get(EPOCH, inputsHash(FILES, INVOCATION));
    expect(stored?.pnpmVersion).toBe('unknown');
  });

  it('stale record → consult null → after a live pass, record OVERWRITES the entry', async () => {
    const store = memStore();
    await seed(store, Buffer.from('old-committed-lock')); // stale
    const client = makeMemoClient(store, { write: true, pnpmVersion: '10.34.1' });

    // stale → miss → check.ts does a live derive and (on pass) records the new derived lockfile
    expect(await client.consult(FILES, COMMITTED)).toBeNull();
    await client.record(FILES, DERIVED);

    const stored = await store.get(EPOCH, inputsHash(FILES, INVOCATION));
    expect(stored?.derivedLockfileSha256).toBe(sha256(DERIVED));
  });

  // Mismatch is never memoised: the client exposes ONLY consult + record.
  // check.ts calls record solely on a pass (committed === derived), so there is
  // no structural "record a mismatch" path. Assert the API shape.
  it('exposes only consult + record — no mismatch-record path', () => {
    const client = makeMemoClient(memStore(), { write: true });
    expect(Object.keys(client).sort()).toEqual(['consult', 'record']);
    expect(typeof client.consult).toBe('function');
    expect(typeof client.record).toBe('function');
  });
});

describe('discoverToken (spec §8 chain)', () => {
  it('prefers LOCKFILE_ASSAY_TOKEN over GITHUB_TOKEN', () => {
    expect(discoverToken({ LOCKFILE_ASSAY_TOKEN: 'explicit', GITHUB_TOKEN: 'gh' })).toBe(
      'explicit',
    );
  });

  it('falls back to GITHUB_TOKEN when the explicit var is unset', () => {
    expect(discoverToken({ GITHUB_TOKEN: 'gh' })).toBe('gh');
  });

  it('returns null when neither var is set and `gh` is absent (empty PATH dir)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'assay-emptypath-'));
    try {
      expect(discoverToken({ PATH: empty })).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('originRepo (spec §8)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'assay-origin-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('parses the ssh form git@github.com:owner/name.git', () => {
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:octo/assay.git'], { cwd: dir });
    expect(originRepo(dir)).toBe('octo/assay');
  });

  it('parses the https form https://github.com/owner/name.git', () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octo/assay.git'], {
      cwd: dir,
    });
    expect(originRepo(dir)).toBe('octo/assay');
  });

  it('parses an https URL without a trailing .git', () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/octo/assay'], { cwd: dir });
    expect(originRepo(dir)).toBe('octo/assay');
  });

  it('returns null when there is no origin remote', () => {
    expect(originRepo(dir)).toBeNull();
  });

  it('returns null for a non-github remote', () => {
    execFileSync('git', ['remote', 'add', 'origin', 'git@gitlab.com:octo/assay.git'], { cwd: dir });
    expect(originRepo(dir)).toBeNull();
  });

  // host anchor: `github.com` must be the ACTUAL host, not a substring of it.
  // Without the anchor these lookalike hosts wrongly parse as `o/n` and a memo
  // write could target an unintended github.com repo.
  it('returns null for the ssh lookalike git@notgithub.com:o/n.git', () => {
    execFileSync('git', ['remote', 'add', 'origin', 'git@notgithub.com:o/n.git'], { cwd: dir });
    expect(originRepo(dir)).toBeNull();
  });

  it('returns null for the https lookalike https://notgithub.com/o/n', () => {
    execFileSync('git', ['remote', 'add', 'origin', 'https://notgithub.com/o/n'], { cwd: dir });
    expect(originRepo(dir)).toBeNull();
  });
});
