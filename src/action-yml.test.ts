import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The repo's CI runs `node dist/cli.js` directly and never LOADS action.yml, so
// a broken action manifest passes CI and ships (v1.0.0 did — the validation
// spike caught it). GitHub evaluates `${{ }}` in action.yml at action-load
// time, where the `github` context does not exist; a single `${{ github.* }}`
// anywhere in the file (e.g. a `${{ github.base_ref }}` example inside an input
// description) makes EVERY `uses: jsalvata/lockfile-assay@…` fail with
// "Unrecognized named-value: 'github'". This grep-level guard fails the build
// if such an expression reappears — the action's own inputs are passed with
// `${{ inputs.* }}` (valid), and the `github` context belongs only in the
// calling workflow (examples/lockfile-assay.yml), never here.
describe('action.yml has no github-context expression', () => {
  it('has no github-context placeholder (invalid at action-load; breaks every uses:)', () => {
    const yml = readFileSync(new URL('../action.yml', import.meta.url), 'utf8');
    // matches a `${{ … github.… }}` placeholder anywhere in the file
    const match = yml.match(/\$\{\{[^}]*\bgithub\./);
    expect(match?.[0] ?? null).toBeNull();
  });
});
