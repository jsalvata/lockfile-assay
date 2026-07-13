import { describe, expect, it } from 'vitest';
import { INVOCATION } from '../derive.js';
import { EPOCH, inputsHash } from './key.js';

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
    // uint64BE(len) ‖ utf8(invocation)) — a locale sort, or any encoding drift,
    // fails this test. Hand-built stream (80 bytes, sha256'd off-implementation):
    //   5A 00 00·7 03 74776F 00          — 'Z' NUL u64(3) 'two' NUL
    //   61 00 00·7 03 6F6E65 00          — 'a' NUL u64(3) 'one' NUL
    //   7A 00 00·7 04 666F7572 00        — 'z' NUL u64(4) 'four' NUL
    //   C3A9 00 00·7 05 7468726565 00    — 'é' NUL u64(5) 'three' NUL
    //   00·7 0C 706E706D20696E7374616C6C — u64(12) 'pnpm install'
    const files = [f('a', 'one'), f('Z', 'two'), f('é', 'three'), f('z', 'four')];
    const digest = inputsHash(files, 'pnpm install');
    expect(digest).toBe('81db1b4ce4684e60eb14e08710f47e7a715ac99c14999a9dd5ae0ac8a543c25c');
    expect(inputsHash([...files].reverse(), 'pnpm install')).toBe(digest);
  });
  it('length-frames the invocation — file bytes cannot masquerade as invocation bytes', () => {
    // Under the previous bare-append encoding (utf8(invocation) with no length
    // prefix), both calls below fed sha256 the identical 12-byte stream
    // 61 00 00·7 01 78 00: one file {a:'x'} with an empty invocation, vs zero
    // files with those same frame bytes smuggled in as the invocation string.
    // The uint64BE length prefix on the invocation keeps the stream uniquely
    // decodable, so these must now digest differently.
    const frameAsInvocation = `a${'\u0000'.repeat(8)}\u0001x\u0000`;
    expect(inputsHash([f('a', 'x')], '')).not.toBe(inputsHash([], frameAsInvocation));
  });
  it('EPOCH is 1', () => expect(EPOCH).toBe(1));
});
