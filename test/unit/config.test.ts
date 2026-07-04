import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { UsageError } from '../../src/errors.js';

describe('parseConfig', () => {
  it('absent config defaults to off', () => expect(parseConfig(null)).toBe('off'));
  it('reads the mode knob', () => {
    expect(parseConfig(Buffer.from('{"mode":"enforce"}'))).toBe('enforce');
    expect(parseConfig(Buffer.from('{"mode":"warn"}'))).toBe('warn');
  });
  it('malformed json or unknown mode → UsageError (exit 2)', () => {
    expect(() => parseConfig(Buffer.from('{nope'))).toThrow(UsageError);
    expect(() => parseConfig(Buffer.from('{"mode":"loose"}'))).toThrow(UsageError);
  });
});
