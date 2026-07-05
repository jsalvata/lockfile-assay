import { describe, expect, it } from 'vitest';
import { INVOCATION } from './derive.js';
import { EPOCH, inputsHash } from './memo/key.js';

const f = (path: string, s: string) => ({ path, bytes: Buffer.from(s) });

describe('inputsHash', () => {
  it('is stable across collection order and 64-hex shaped', () => {
    const a = inputsHash([f('a', '1'), f('b', '2')], INVOCATION);
    const b = inputsHash([f('b', '2'), f('a', '1')], INVOCATION);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes when any byte, path, or the invocation changes', () => {
    const base = inputsHash([f('a', '1')], INVOCATION);
    expect(inputsHash([f('a', '2')], INVOCATION)).not.toBe(base);
    expect(inputsHash([f('b', '1')], INVOCATION)).not.toBe(base);
    expect(inputsHash([f('a', '1')], 'other')).not.toBe(base);
  });
  it('resists boundary shifting between adjacent files', () => {
    expect(inputsHash([f('a', 'xy'), f('b', 'z')], INVOCATION)).not.toBe(
      inputsHash([f('a', 'x'), f('b', 'yz')], INVOCATION),
    );
  });
  it('matches the pinned canonical digest — code-unit sort, not locale collation', () => {
    // Memo keys must be identical on every machine, so the path sort must be
    // code-unit comparison, never localeCompare (locale/ICU-dependent). These
    // paths order differently under the two: code-unit Z,a,z,é vs locale a,é,z,Z.
    // The digest is pinned from an independent hand-construction of the canonical
    // stream (utf8(path) ‖ 0x00 ‖ uint64BE(len) ‖ bytes ‖ 0x00 per file, then
    // utf8(invocation)) — a locale sort, or any encoding drift, fails this test.
    const files = [f('a', 'one'), f('Z', 'two'), f('é', 'three'), f('z', 'four')];
    const digest = inputsHash(files, 'pnpm install');
    expect(digest).toBe('5497de092b04b57e6a791f1f0fa810889247ef22b74145efbd151ff1cbeb4c1e');
    expect(inputsHash([...files].reverse(), 'pnpm install')).toBe(digest);
  });
  it('EPOCH is 1', () => expect(EPOCH).toBe(1));
});
