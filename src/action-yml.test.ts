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
const actionYml = () => readFileSync(new URL('../action.yml', import.meta.url), 'utf8');

describe('action.yml has no github-context expression', () => {
  it('has no github-context placeholder (invalid at action-load; breaks every uses:)', () => {
    // matches a `${{ … github.… }}` placeholder anywhere in the file
    const match = actionYml().match(/\$\{\{[^}]*\bgithub\./);
    expect(match?.[0] ?? null).toBeNull();
  });
});

// The action must install an EXACT version of the CLI. A bare
// `npx --yes lockfile-assay` / `npm i -g lockfile-assay` resolves to whatever is
// `latest` on npm, so `uses: jsalvata/lockfile-assay@vX.Y.Z` would pin the action
// but NOT the code it executes — an adopter who carefully pinned v1 could
// silently run a compromised `latest`. For a supply-chain tool whose whole claim
// is "pin what actually runs", that is the sharpest edge in the repo. The pin is
// rewritten on every release by scripts/set-release-version.sh; these guards fail
// the build if anyone unpins it.
describe('action.yml pins the CLI version it installs', () => {
  it('declares an exact semver pin carrying the release marker', () => {
    const m = actionYml().match(/VERSION="(\d+\.\d+\.\d+[^"]*)" # x-release-version/);
    expect(m?.[1] ?? null).not.toBeNull();
  });

  it('installs the CLI at that pin, never an unpinned/latest package', () => {
    const yml = actionYml();
    // the install must interpolate the pinned VERSION (regex, so the literal
    // shell placeholder never appears as a JS template-looking string)
    expect(yml).toMatch(/npm install -g "lockfile-assay@\$\{VERSION\}"/);
    // no bare (version-less) install of the package by either installer
    expect(yml).not.toMatch(/npx\s+(--yes\s+)?lockfile-assay(?!@)/);
    expect(yml).not.toMatch(/npm\s+install\s+-g\s+"?lockfile-assay"?(?!@)/);
  });
});
