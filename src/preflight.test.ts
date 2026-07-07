import { describe, expect, it } from 'vitest';
import { unsupportedInputs } from './preflight.js';

const f = (path: string, s: string) => ({ path, bytes: Buffer.from(s) });

describe('preflight', () => {
  it('accepts a plain repo', () => {
    expect(
      unsupportedInputs(
        [f('package.json', '{}'), f('.npmrc', 'registry=http://x/\n')],
        ['package.json', '.npmrc', 'pnpm-lock.yaml', 'src/index.ts'],
      ),
    ).toEqual([]);
  });
  it('refuses pnpmfile in any form', () => {
    expect(unsupportedInputs([], ['.pnpmfile.cjs'])).toHaveLength(1);
    expect(unsupportedInputs([], ['pkg/.pnpmfile.cjs'])).toHaveLength(1);
    expect(unsupportedInputs([], ['.PNPMFILE.CJS'])).toHaveLength(1);
    expect(unsupportedInputs([f('.npmrc', 'pnpmfile=./hooks.cjs\n')], [])).toHaveLength(1);
    expect(unsupportedInputs([f('.npmrc', 'ignore-pnpmfile=true\n')], [])).toHaveLength(1);
    expect(unsupportedInputs([f('.npmrc', 'global-pnpmfile=./hooks.cjs\n')], [])).toHaveLength(1);
    expect(unsupportedInputs([f('pnpm-workspace.yaml', 'pnpmfile: ./h.cjs\n')], [])).toHaveLength(
      1,
    );
    // globalPnpmfile in workspace yaml (camelCase, pnpm ≥ 10) — same setting the
    // .npmrc scan already catches as global-pnpmfile; must be caught here too.
    expect(
      unsupportedInputs([f('pnpm-workspace.yaml', 'globalPnpmfile: ./h.cjs\n')], []),
    ).toHaveLength(1);
  });
  it('refuses package.yaml/package.json5 manifests', () => {
    expect(unsupportedInputs([], ['package.yaml'])).toHaveLength(1);
    expect(unsupportedInputs([], ['packages/a/package.json5'])).toHaveLength(1);
    expect(unsupportedInputs([], ['PACKAGE.YAML'])).toHaveLength(1);
    // plain package.json is the supported manifest — never flagged
    expect(unsupportedInputs([], ['package.json'])).toEqual([]);
    expect(unsupportedInputs([f('package.json', '{}')], ['package.json', 'src/index.ts'])).toEqual(
      [],
    );
  });
  it('refuses split lockfiles', () => {
    expect(unsupportedInputs([f('.npmrc', 'shared-workspace-lockfile=false\n')], [])).toHaveLength(
      1,
    );
    expect(
      unsupportedInputs([f('pnpm-workspace.yaml', 'sharedWorkspaceLockfile: false\n')], []),
    ).toHaveLength(1);
  });
  it('refuses split-lockfile spellings pnpm honors', () => {
    expect(
      unsupportedInputs([f('.npmrc', 'shared-workspace-lockfile="false"\n')], []),
    ).toHaveLength(1);
    expect(
      unsupportedInputs([f('.npmrc', "shared-workspace-lockfile='false'\n")], []),
    ).toHaveLength(1);
    expect(
      unsupportedInputs([f('.npmrc', 'shared-workspace-lockfile=false # comment\n')], []),
    ).toHaveLength(1);
    expect(
      unsupportedInputs([f('.npmrc', 'shared-workspace-lockfile=false ; comment\n')], []),
    ).toHaveLength(1);
    expect(
      unsupportedInputs([f('pnpm-workspace.yaml', 'sharedWorkspaceLockfile: False\n')], []),
    ).toHaveLength(1);
    expect(
      unsupportedInputs([f('pnpm-workspace.yaml', 'sharedWorkspaceLockfile: FALSE\n')], []),
    ).toHaveLength(1);
    expect(
      unsupportedInputs(
        [f('pnpm-workspace.yaml', 'sharedWorkspaceLockfile: false # comment\n')],
        [],
      ),
    ).toHaveLength(1);
  });
  it('does not flag values pnpm reads as truthy', () => {
    // pnpm's ini reader coerces only lowercase `false`; FALSE is a truthy string.
    expect(unsupportedInputs([f('.npmrc', 'shared-workspace-lockfile=FALSE\n')], [])).toEqual([]);
    // The yaml parser reads a *quoted* value as the truthy string "false", so
    // pnpm keeps the shared lockfile — a quoted YAML value must not be flagged.
    expect(
      unsupportedInputs([f('pnpm-workspace.yaml', 'sharedWorkspaceLockfile: "false"\n')], []),
    ).toEqual([]);
    expect(
      unsupportedInputs([f('pnpm-workspace.yaml', "sharedWorkspaceLockfile: 'false'\n")], []),
    ).toEqual([]);
  });
});
