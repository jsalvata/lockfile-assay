import { describe, expect, it } from 'vitest';
import { embedRecord, parseRecord } from './checks-api.js';
import type { StoredRecord } from './store.js';

const rec: StoredRecord = {
  epoch: 1,
  inputsHash: 'a'.repeat(64),
  derivedHash: 'b'.repeat(64),
  toolVersion: '1.2.3',
  pnpmVersion: '10.34.1',
  timestamp: '2026-07-13T00:00:00.000Z',
};

describe('record marker embed/parse', () => {
  it('round-trips a record through a check-run summary', () => {
    const summary = `A human line.\n${embedRecord(rec)}`;
    expect(parseRecord(summary)).toEqual(rec);
  });

  it('returns null when the marker is absent', () => {
    expect(parseRecord('just a human summary, no marker')).toBeNull();
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord(undefined)).toBeNull();
  });

  it('returns null on a malformed / garbled record (never a false record)', () => {
    // marker present but JSON broken
    expect(parseRecord('<!--lockfile-assay-memo:v1 {not json} -->')).toBeNull();
    // marker present, JSON valid, but a required field missing/wrong type
    expect(parseRecord('<!--lockfile-assay-memo:v1 {"epoch":"1","inputsHash":"x"} -->')).toBeNull();
  });

  it('non-greedy capture stops at the first close, even if trailing text (same line) contains "} -->"', () => {
    // Trailing text on the *same line* as the marker, itself containing "} -->",
    // would widen a greedy `.*` capture past the record's own closing brace and
    // swallow the trailing text into the "JSON", breaking the parse. The
    // non-greedy capture must stop at the record's own first close instead.
    const summary = `${embedRecord(rec)} trailing note like {"forged":true} -->`;
    expect(parseRecord(summary)).toEqual(rec);
  });
});
