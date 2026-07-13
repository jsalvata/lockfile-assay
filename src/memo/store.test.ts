import { describe, expect, it } from 'vitest';
import { INVOCATION } from '../derive.js';
import type { Outcome } from '../outcome.js';
import type { StagedFile } from '../staging.js';
import { parseRecord } from './checks-api.js';
import { EPOCH, inputsHash } from './key.js';
import type { Backend, StoredRecord } from './store.js';
import { buildMemoDriver, CHECK_NAME, conclusion, MemoDriver, sha256 } from './store.js';

const O = {
  pass: { kind: 'pass' } as Outcome,
  vacuous: { kind: 'vacuous-pass' } as Outcome,
  off: { kind: 'not-evaluated' } as Outcome,
  mismatch: { kind: 'mismatch', committed: null, derived: Buffer.alloc(0) } as Outcome,
  skew: { kind: 'toolchain-skew', pinned: '10.0.0', effective: '9.0.0' } as Outcome,
  unsupported: { kind: 'unsupported-input', reasons: ['pnpmfile'] } as Outcome,
};

describe('conclusion — (outcome, exit) → check-run conclusion', () => {
  it('maps passes to success', () => {
    expect(conclusion(O.pass, 0)).toBe('success');
    expect(conclusion(O.vacuous, 0)).toBe('success');
  });
  it('maps off to neutral', () => {
    expect(conclusion(O.off, 0)).toBe('neutral');
  });
  it('maps enforce failures (exit 1) to failure', () => {
    expect(conclusion(O.mismatch, 1)).toBe('failure');
    expect(conclusion(O.skew, 1)).toBe('failure');
    expect(conclusion(O.unsupported, 1)).toBe('failure');
  });
  it('maps warn-mode failing kinds (exit 0) to neutral', () => {
    expect(conclusion(O.mismatch, 0)).toBe('neutral');
    expect(conclusion(O.skew, 0)).toBe('neutral');
    expect(conclusion(O.unsupported, 0)).toBe('neutral');
  });
});

const files: StagedFile[] = [{ path: 'pnpm-lock.yaml', bytes: Buffer.from('lock') }];
const committed = Buffer.from('committed-lock');
const want = inputsHash(files, INVOCATION);

function fakeBackend(records: StoredRecord[]): Backend {
  return {
    listRecords: async () => records,
    postVerdict: async () => {},
  };
}

const good: StoredRecord = {
  epoch: EPOCH,
  inputsHash: want,
  derivedHash: sha256(committed),
  toolVersion: '1.0.0',
  pnpmVersion: '10.34.1',
  timestamp: '2026-07-13T00:00:00.000Z',
};

describe('MemoDriver.consult — pass or miss, never a failure', () => {
  it('hits when epoch + inputsHash + derivedHash all match', async () => {
    const d = new MemoDriver(fakeBackend([good]), false);
    expect(await d.consult(files, committed)).toEqual({
      hit: true,
      derivedAt: good.timestamp,
      toolVersion: good.toolVersion,
    });
  });

  it('misses (stale record) when derivedHash != sha256(committed)', async () => {
    const stale = { ...good, derivedHash: sha256(Buffer.from('other')) };
    const d = new MemoDriver(fakeBackend([stale]), false);
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('misses under a different epoch (isolation)', async () => {
    const d = new MemoDriver(fakeBackend([{ ...good, epoch: EPOCH + 1 }]), false);
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('misses when there is no committed lockfile', async () => {
    const d = new MemoDriver(fakeBackend([good]), false);
    expect(await d.consult(files, null)).toBeNull();
  });

  it('degrades a transport error to a miss (never throws)', async () => {
    const throwing: Backend = {
      listRecords: async () => {
        throw new Error('502 from GitHub');
      },
      postVerdict: async () => {},
    };
    const d = new MemoDriver(throwing, false);
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('is a no-op (miss) with a null backend', async () => {
    const d = new MemoDriver(null, false);
    expect(await d.consult(files, committed)).toBeNull();
  });
});

function capturingBackend() {
  const posted: Parameters<Backend['postVerdict']>[0][] = [];
  const backend: Backend = {
    listRecords: async () => [],
    postVerdict: async (v) => {
      posted.push(v);
    },
  };
  return { backend, posted };
}

const derived = Buffer.from('derived-lock');

describe('MemoDriver.record + postVerdict — the write path', () => {
  it('embeds the record in a success verdict on a live pass', async () => {
    const { backend, posted } = capturingBackend();
    const d = new MemoDriver(backend, true);
    await d.record(files, derived, '10.34.1'); // evaluate() calls this on a byte-match pass
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'deadbeef',
    });
    expect(warnings).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0].conclusion).toBe('success');
    expect(posted[0].headSha).toBe('deadbeef');
    const rec = parseRecord(posted[0].summary);
    expect(rec?.inputsHash).toBe(inputsHash(files, INVOCATION));
    expect(rec?.derivedHash).toBe(sha256(derived));
    expect(rec?.pnpmVersion).toBe('10.34.1');
    expect(rec?.epoch).toBe(EPOCH);
  });

  it('posts a failure verdict with no record on a mismatch (never memoised)', async () => {
    const { backend, posted } = capturingBackend();
    const d = new MemoDriver(backend, true);
    // record() is NOT called on a mismatch — evaluate() only calls it on a pass
    const warnings = await d.postVerdict({
      outcome: { kind: 'mismatch', committed, derived } as Outcome,
      exit: 1,
      headSha: 'deadbeef',
    });
    expect(warnings).toEqual([]);
    expect(posted[0].conclusion).toBe('failure');
    expect(parseRecord(posted[0].summary)).toBeNull();
  });

  it('warns (drift wording) but never throws when a pass write fails', async () => {
    const backend: Backend = {
      listRecords: async () => [],
      postVerdict: async () => {
        throw new Error('403 Forbidden');
      },
    };
    const d = new MemoDriver(backend, true);
    await d.record(files, derived, '10.34.1');
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'deadbeef',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not durable/);
    expect(warnings[0]).toMatch(/drift/);
  });

  it('is a no-op when write is false (local read-only forms never post)', async () => {
    const { backend, posted } = capturingBackend();
    const d = new MemoDriver(backend, false);
    await d.record(files, derived, '10.34.1');
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'deadbeef',
    });
    expect(warnings).toEqual([]);
    expect(posted).toHaveLength(0);
  });
});

describe('buildMemoDriver — null-object when context is absent', () => {
  it('CHECK_NAME is the stable required-check name', () => {
    expect(CHECK_NAME).toBe('lockfile-assay');
  });

  it('returns a driver that misses/no-ops when there is no token', async () => {
    // env with no token and an empty PATH so `gh auth token` finds nothing
    const d = buildMemoDriver({ write: true, pr: 1, env: { PATH: '/nonexistent' }, cwd: '.' });
    expect(await d.consult(files, committed)).toBeNull();
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'x',
    });
    expect(warnings).toEqual([]);
  });
});
