import { describe, expect, it } from 'vitest';
import { buildProgram } from './cli.js';
import { UsageError } from './errors.js';

// Regression guard for the "silently ignored flag" wart: `check --staged` builds
// a read-only memo (spec §8: local hook forms never write), so --memo-write can
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
