import { describe, expect, it } from 'vitest';
import type { Outcome } from '../outcome.js';
import { conclusion } from './store.js';

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
