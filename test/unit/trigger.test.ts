import { describe, expect, it } from 'vitest';
import { declaredPatchPaths, isTriggered } from '../../src/trigger.js';

describe('trigger', () => {
  it('fires on every resolution input, ignores source files', () => {
    const declared = ['vendor/odd-location.patch2'];
    for (const p of [
      'pnpm-lock.yaml',
      'PNPM-LOCK.YAML',
      'package.json',
      'packages/app/package.json',
      '.npmrc',
      'packages/app/.npmrc',
      'pnpm-workspace.yaml',
      'patches/lodash@4.17.21.patch',
      'tools/fix.diff',
      'vendor/odd-location.patch2',
      '.pnpmfile.cjs',
      'packages/app/.pnpmfile.cjs',
      '.PNPMFILE.CJS',
      'package.yaml',
      'packages/a/package.json5',
    ]) {
      expect(isTriggered([p, 'src/index.ts'], declared), p).toBe(true);
    }
    expect(isTriggered(['src/index.ts', 'README.md'], declared)).toBe(false);
  });

  it('extracts declared patch paths from workspace yaml and root manifest', () => {
    const ws = Buffer.from(
      'packages:\n  - "packages/*"\npatchedDependencies:\n  lodash: vendor/lodash.patch\n',
    );
    const pkg = Buffer.from(
      JSON.stringify({ pnpm: { patchedDependencies: { react: 'fixes/react.patch' } } }),
    );
    expect(declaredPatchPaths(ws, pkg).sort()).toEqual([
      'fixes/react.patch',
      'vendor/lodash.patch',
    ]);
    expect(declaredPatchPaths(null, null)).toEqual([]);
  });
});
