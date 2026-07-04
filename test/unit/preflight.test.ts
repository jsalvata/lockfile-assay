import { describe, expect, it } from 'vitest';
import { unsupportedInputs } from '../../src/preflight.js';

const f = (path: string, s: string) => ({ path, bytes: Buffer.from(s) });

describe('preflight', () => {
  it('accepts a plain repo', () => {
    expect(
      unsupportedInputs([f('package.json', '{}'), f('.npmrc', 'registry=http://x/\n')]),
    ).toEqual([]);
  });
  it('refuses pnpmfile in any form', () => {
    expect(unsupportedInputs([f('.pnpmfile.cjs', 'x')])).toHaveLength(1);
    expect(unsupportedInputs([f('pkg/.pnpmfile.cjs', 'x')])).toHaveLength(1);
    expect(unsupportedInputs([f('.npmrc', 'pnpmfile=./hooks.cjs\n')])).toHaveLength(1);
    expect(unsupportedInputs([f('.npmrc', 'ignore-pnpmfile=true\n')])).toHaveLength(1);
    expect(unsupportedInputs([f('pnpm-workspace.yaml', 'pnpmfile: ./h.cjs\n')])).toHaveLength(1);
  });
  it('refuses split lockfiles', () => {
    expect(unsupportedInputs([f('.npmrc', 'shared-workspace-lockfile=false\n')])).toHaveLength(1);
    expect(
      unsupportedInputs([f('pnpm-workspace.yaml', 'sharedWorkspaceLockfile: false\n')]),
    ).toHaveLength(1);
  });
});
