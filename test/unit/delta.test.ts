import { describe, expect, it } from 'vitest';
import { deltaSummary } from '../../src/report/delta.js';
import { bytesEqual } from '../../src/verdict.js';

const lock = (pkgs: string[]) =>
  Buffer.from(
    `lockfileVersion: '9.0'\npackages:\n${pkgs.map((p) => `  ${JSON.stringify(p)}: {}\n`).join('')}`,
  );

describe('verdict', () => {
  it('byte equality is exact and null-safe', () => {
    expect(bytesEqual(Buffer.from('a'), Buffer.from('a'))).toBe(true);
    expect(bytesEqual(Buffer.from('a'), Buffer.from('b'))).toBe(false);
    expect(bytesEqual(null, Buffer.from('a'))).toBe(false);
  });
});

describe('deltaSummary', () => {
  it('reports version disagreements per package', () => {
    const committed = lock(['lodash@4.17.20', '@scope/x@1.0.0(react@18.2.0)']);
    const derived = lock(['lodash@4.17.21', '@scope/x@1.0.0(react@18.2.0)']);
    expect(deltaSummary(committed, derived)).toEqual([
      { pkg: 'lodash', committed: '4.17.20', derived: '4.17.21' },
    ]);
  });
  it('reports additions, removals, and a missing committed lockfile', () => {
    expect(deltaSummary(lock([]), lock(['evil@1.0.0']))).toEqual([
      { pkg: 'evil', committed: null, derived: '1.0.0' },
    ]);
    expect(deltaSummary(null, lock(['a@1.0.0']))).toEqual([
      { pkg: 'a', committed: null, derived: '1.0.0' },
    ]);
  });
});
