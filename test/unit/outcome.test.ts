import { describe, expect, it } from 'vitest';
import { exitCode, type Mode, type Outcome } from '../../src/outcome.js';

const derived = Buffer.from('x');
const failing: Outcome[] = [
  { kind: 'mismatch', committed: null, derived },
  { kind: 'toolchain-skew', pinned: '10.34.1', effective: '9.12.0' },
  { kind: 'unsupported-input', reasons: ['.pnpmfile.cjs present'] },
];
const passing: Outcome[] = [
  { kind: 'not-evaluated' },
  { kind: 'vacuous-pass' },
  { kind: 'pass' },
  { kind: 'cannot-evaluate', reason: 'no origin/HEAD' },
];

describe('exitCode', () => {
  it('failing outcomes exit 1 only under enforce', () => {
    for (const o of failing) {
      expect(exitCode(o, 'enforce')).toBe(1);
      expect(exitCode(o, 'warn')).toBe(0);
    }
  });
  it('passing outcomes exit 0 in every mode', () => {
    for (const o of passing)
      for (const m of ['off', 'warn', 'enforce'] as Mode[]) expect(exitCode(o, m)).toBe(0);
  });
});
