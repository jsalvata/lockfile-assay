import { describe, expect, it } from 'vitest';
import { INVOCATION } from '../derive.js';
import type { Outcome } from '../outcome.js';
import type { StagedFile } from '../staging.js';
import { EPOCH, inputsHash } from './key.js';
import type { Backend, StoredRecord } from './store.js';
import { conclusion, MemoDriver, sha256 } from './store.js';

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
