import { describe, expect, it } from 'vitest';
import { buildProgram } from './cli.js';
import { UsageError } from './errors.js';

// Regression guard for the "silently ignored flag" wart: `check --staged` is a
// local hook form, which never writes the memo (spec §8), so --memo-write can
// never take effect there. It must be rejected loudly, not swallowed. Driving the
// real commander program proves both that the flag is declared AND that the guard
// fires before any work — parseAsync rejects with the thrown UsageError.
describe('check CLI: --memo-write is incompatible with --staged', () => {
  it('rejects the combo with a UsageError that names the flag', async () => {
    await expect(
      buildProgram().parseAsync(['check', '--staged', '--memo-write'], { from: 'user' }),
    ).rejects.toThrow(UsageError);
    await expect(
      buildProgram().parseAsync(['check', '--staged', '--memo-write'], { from: 'user' }),
    ).rejects.toThrow(/--memo-write cannot be combined with --staged/);
  });
});

describe('check CLI: --pr is accepted', () => {
  it('parses --pr as a number without a usage error', async () => {
    // With no token/app-id in the env the driver is a null-object, so this runs
    // the real path but performs no network I/O. It must not throw a UsageError
    // for an unknown option.
    const program = buildProgram();
    // A bogus base makes runCheck throw an *evaluation* error, not a usage one;
    // we only assert the option is recognised (no "unknown option '--pr'").
    await expect(
      program.parseAsync(['check', '--base', 'HEAD', '--head', 'HEAD', '--pr', '7'], {
        from: 'user',
      }),
    ).resolves.toBeDefined();
  });
});
