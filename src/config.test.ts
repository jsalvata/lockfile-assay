import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { UsageError } from './errors.js';

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
  it('non-object valid JSON → UsageError (fail closed)', () => {
    expect(() => parseConfig(Buffer.from('42'))).toThrow(UsageError);
    expect(() => parseConfig(Buffer.from('"x"'))).toThrow(UsageError);
    expect(() => parseConfig(Buffer.from('[1,2]'))).toThrow(UsageError);
    expect(() => parseConfig(Buffer.from('null'))).toThrow(UsageError);
  });
  it('error messages carry the earlier-merge exculpation', () => {
    expect(() => parseConfig(Buffer.from('{nope'))).toThrow(/earlier merge/);
    expect(() => parseConfig(Buffer.from('{"mode":"loose"}'))).toThrow(/earlier merge/);
  });
});
