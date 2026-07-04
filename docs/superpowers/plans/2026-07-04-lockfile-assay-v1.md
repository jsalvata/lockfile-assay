# lockfile-assay v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model routing (user directive):** dispatch task subagents on **Opus 4.8** (`model: "opus"`) by default. Tasks marked `Model: fable` are the complex ones — dispatch those on **Fable 5** (`model: "fable"`).

**Goal:** Build lockfile-assay v1 — a byte-exact CI gate proving `pnpm-lock.yaml` is honestly derived (spec: `docs/spec.md`, implementation design §13).

**Architecture:** A thin TypeScript CLI orchestrating real binaries: git plumbing stages base's lockfile + head's resolution inputs into an isolated temp tree, the corepack-pinned pnpm re-derives the lockfile with `--lockfile-only`, and the verdict is raw byte equality. Lockfile parsing exists only report-side. The memo (PR C) short-circuits repeat evaluations to pass via a ruleset-protected orphan branch written only by a dedicated GitHub App.

**Tech Stack:** TypeScript 6 (ESM, NodeNext), Node ≥ 22, commander 15.0.0 + yaml 2.9.0 (only runtime deps, exact-pinned), vitest, biome, Verdaccio (test registry), husky + commitlint, semantic-release with npm OIDC trusted publishing.

## Global Constraints

- Package `lockfile-assay`, bin `lockfile-assay`, repo `jsalvata/lockfile-assay`, MIT, author Jordi Salvat, `engines.node >= 22`, `packageManager: pnpm@10.34.1`.
- Runtime deps **exactly** `"commander": "15.0.0"` and `"yaml": "2.9.0"` — no carets, nothing else. Dev deps unpinned-latest at install time.
- **Trust-path import rule (spec §13):** `src/git.ts`, `src/staging.ts`, `src/preflight.ts`, `src/toolchain.ts`, `src/derive.ts`, `src/verdict.ts` import only `node:*` builtins and each other — never `yaml`, `commander`, or `src/report/`. `src/trigger.ts` and `src/config.ts` may use `yaml`/JSON parsing (not in the §13 trust list); `src/report/` is the only lockfile-YAML parser.
- Derivation invocation, verbatim (spec §3): `pnpm install --lockfile-only --ignore-scripts --prefer-frozen-lockfile --ignore-pnpmfile`, run via `corepack pnpm` (fallback: plain `pnpm`) with `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.
- Exit codes (spec §5): pass/vacuous/not-evaluated/cannot-evaluate → 0; mismatch/toolchain-skew/unsupported-input → 1 under `enforce`, 0 + report under `warn`; `UsageError` → 2; anything else (incl. resolver/network failure in CI form) → 3.
- JSON report `schemaVersion: 1`; `prepush --json` emits one `{schemaVersion, tips: []}` document.
- `EPOCH = 1` source constant in `src/memo/key.ts` (spec §8).
- Commits: Conventional, **only** `feat:`/`fix:`/`docs:`, all lowercase, header ≤ 50 chars, no ticket trailer (no Jira project). Use the `git-commit` skill; branches via `git-branch` (GitHub user `jsalvata`); PRs via `git-pull-request`.
- ESM everywhere: relative imports carry `.js` extensions (NodeNext).
- Plan-time facts (verified 2026-07-04 on this machine): corepack 0.34.0 ships with Node 22.22 and honors `packageManager` pins (tested: selected pnpm 9.12.0 from a pin); all four invocation flags exist on pnpm 10.34.1; `git write-tree` on a conflicted index fails exit 128 `fatal: git-write-tree: error building trees`.

## PR Plan

Reasoning order: feature spike → prep → cleanup. Ship order: A → B → C.

- **PR 1 — Prep refactor:** *Skipped — greenfield repo; there is no existing code, hence no friction list and nothing to restructure.* (The spike role was played by spec §13 + the plan-time verifications above.)
- **PR A — Core check** (`jsalvata/assay-core` off `main`): scaffold + the anchored check (`check --base/--head`), reports, exit codes, hermetic Verdaccio suite (empirics + attack shapes + drift/remedy), dogfood CI.
- **PR B — Local forms** (`jsalvata/local-forms` off PR A's branch, or off `main` after A merges): `check --staged`, `prepush`, cannot-evaluate degrades, hook docs.
- **PR C — Derivation memo** (`jsalvata/memo` off PR B's branch or `main` after B): validation spike, key/store/auth/client, wiring + provenance, App setup docs, `action.yml`, release checklist.
- **PR 3 — Cleanup refactor** (`jsalvata/cleanup-v1`): *conditional* — Task C7 renders the explicit verdict after PR C (candidates: test-helper dedup across suites, naming drift). If nothing qualifies, record the skip in the PR C description.

Candidate prep for next time: none yet — revisit when planning the npm backend (spec §11), which will want a `PackageManagerAdapter` seam derived from real friction, not speculation.

---

# PR A — Core check

### Task A1: Repo scaffold, toolchain, CI skeleton

`Model: opus`

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `vitest.config.ts`, `commitlint.config.js`, `.releaserc.json`, `.gitignore`, `LICENSE`, `.lockfile-assay.json`, `src/cli.ts`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.husky/commit-msg`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: build/test/lint scripts every later task runs; `src/cli.ts` placeholder later replaced by Task A11.

- [ ] **Step 1: Branch.** Invoke the `git-branch` skill: new branch `jsalvata/assay-core` off `main`.

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "lockfile-assay",
  "version": "0.0.0-development",
  "description": "Prove your lockfile is untampered — a byte-exact derivation gate for pnpm-lock.yaml",
  "keywords": ["pnpm", "lockfile", "supply-chain", "security", "ci"],
  "license": "MIT",
  "author": "Jordi Salvat",
  "repository": { "type": "git", "url": "git+https://github.com/jsalvata/lockfile-assay.git" },
  "bugs": { "url": "https://github.com/jsalvata/lockfile-assay/issues" },
  "homepage": "https://github.com/jsalvata/lockfile-assay#readme",
  "type": "module",
  "bin": { "lockfile-assay": "dist/cli.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=22" },
  "packageManager": "pnpm@10.34.1",
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsx src/cli.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:unit": "vitest run test/unit",
    "test:integration": "vitest run test/integration",
    "lint": "biome check .",
    "format": "biome format --write .",
    "prepare": "husky"
  },
  "dependencies": { "commander": "15.0.0", "yaml": "2.9.0" }
}
```

- [ ] **Step 3: Install dev deps** (latest at install time; runtime deps come from the file above)

Run: `pnpm install && pnpm add -D typescript tsx vitest @biomejs/biome @types/node husky @commitlint/cli @commitlint/config-conventional verdaccio semantic-release @semantic-release/changelog @semantic-release/git`
Expected: lockfile created; no peer warnings that block install.

- [ ] **Step 4: Write the config files**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src"]
}
```

`tsconfig.build.json`:

```json
{ "extends": "./tsconfig.json", "exclude": ["test", "dist", "node_modules"] }
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
```

`biome.json`:

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0/schema.json",
  "formatter": { "indentStyle": "space", "lineWidth": 100 },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "javascript": { "formatter": { "quoteStyle": "single" } },
  "files": { "includes": ["src/**", "test/**", "*.ts", "*.json"] }
}
```

(If `biome check .` later complains about schema version vs the installed major, run `pnpm exec biome migrate --write` and commit the result — the installed Biome is 2.5.x.)

`commitlint.config.js`:

```js
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['feat', 'fix', 'docs']],
    'header-max-length': [2, 'always', 50],
  },
};
```

`.releaserc.json`:

```json
{
  "branches": ["main"],
  "plugins": [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    "@semantic-release/changelog",
    "@semantic-release/npm",
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        "assets": ["CHANGELOG.md", "package.json"],
        "message": "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}"
      }
    ]
  ]
}
```

`.gitignore`:

```
node_modules/
dist/
*.tsbuildinfo
```

`.lockfile-assay.json` (the repo dogfoods itself):

```json
{ "mode": "enforce" }
```

`LICENSE`: MIT text, `Copyright (c) 2026 Jordi Salvat`.

- [ ] **Step 5: Husky commit-msg hook**

Run: `pnpm exec husky init`
Then overwrite `.husky/pre-commit` with `pnpm lint && pnpm typecheck` and create `.husky/commit-msg` containing:

```sh
pnpm exec commitlint --edit "$1"
```

- [ ] **Step 6: Placeholder CLI so build/smoke pass**

`src/cli.ts`:

```ts
#!/usr/bin/env node
import { program } from 'commander';

program.name('lockfile-assay').description('Prove your lockfile is untampered.').version('0.0.0');
program
  .command('check')
  .description('verify the committed lockfile derives honestly')
  .action(() => {
    process.exitCode = 3;
    console.error('not implemented yet');
  });
program.parse();
```

- [ ] **Step 7: CI workflows**

`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm build
      - run: pnpm test:unit
      - name: CLI smoke test
        run: |
          node dist/cli.js --help | grep -q check
      - name: Dogfood — run the assay on this PR
        if: github.event_name == 'pull_request'
        run: node dist/cli.js check --base "origin/${{ github.base_ref }}" --head HEAD || [ "$?" != "1" ]
  integration:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        pnpm-fixture: ['9.12.0', '10.34.1']
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test:integration
        env:
          PNPM_FIXTURE_VERSION: ${{ matrix.pnpm-fixture }}
```

(The dogfood step's `|| [ "$?" != "1" ]` is temporary scaffolding-tolerance — Task A16 removes it once `check` exists. Note: the assay reads mode from **base**, so PRs against the founding commit see no config and pass `not-evaluated`; that is spec behavior, not a bug.)

`.github/workflows/release.yml`: copy waiver-stamp's release workflow verbatim, with `node-version: 22`:

```yaml
name: Release
on:
  push:
    branches: [main]
permissions:
  contents: write
  issues: write
  pull-requests: write
  id-token: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - name: Upgrade npm for OIDC trusted publishing
        run: npm install -g npm@latest
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - name: Release
        run: pnpm exec semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

- [ ] **Step 8: Verify the scaffold**

Run: `pnpm lint && pnpm typecheck && pnpm build && node dist/cli.js --help`
Expected: all green; help text lists `check`.

- [ ] **Step 9: Commit** via the `git-commit` skill. Suggested header: `feat: scaffold lockfile-assay repo`

### Task A2: Outcome types, errors, exit-code mapping

`Model: opus`

**Files:**
- Create: `src/outcome.ts`, `src/errors.ts`
- Test: `test/unit/outcome.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (every later task uses these exact names):

```ts
// src/errors.ts
export class UsageError extends Error {}      // exit 2
export class CannotEvaluate extends Error {}  // local forms: notice + exit 0

// src/outcome.ts
export type Mode = 'off' | 'warn' | 'enforce';
export type MemoProvenance = { hit: boolean; derivedAt?: string; toolVersion?: string };
export type Outcome =
  | { kind: 'not-evaluated' }
  | { kind: 'vacuous-pass' }
  | { kind: 'pass'; memo?: MemoProvenance }
  | { kind: 'mismatch'; committed: Buffer | null; derived: Buffer }
  | { kind: 'toolchain-skew'; pinned: string; effective: string }
  | { kind: 'unsupported-input'; reasons: string[] }
  | { kind: 'cannot-evaluate'; reason: string };
export function exitCode(outcome: Outcome, mode: Mode): 0 | 1;
```

- [ ] **Step 1: Write the failing test**

`test/unit/outcome.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { exitCode, type Mode, type Outcome } from '../../src/outcome.js';

const derived = Buffer.from('x');
const failing: Outcome[] = [
  { kind: 'mismatch', committed: null, derived },
  { kind: 'toolchain-skew', pinned: '10.34.1', effective: '9.12.0' },
  { kind: 'unsupported-input', reasons: ['.pnpmfile.cjs present'] },
];
const passing: Outcome[] = [
  { kind: 'not-evaluated' },
  { kind: 'vacuous-pass' },
  { kind: 'pass' },
  { kind: 'cannot-evaluate', reason: 'no origin/HEAD' },
];

describe('exitCode', () => {
  it('failing outcomes exit 1 only under enforce', () => {
    for (const o of failing) {
      expect(exitCode(o, 'enforce')).toBe(1);
      expect(exitCode(o, 'warn')).toBe(0);
    }
  });
  it('passing outcomes exit 0 in every mode', () => {
    for (const o of passing) for (const m of ['off', 'warn', 'enforce'] as Mode[]) expect(exitCode(o, m)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run test/unit/outcome.test.ts`
Expected: FAIL — cannot resolve `../../src/outcome.js`.

- [ ] **Step 3: Implement**

`src/errors.ts`:

```ts
export class UsageError extends Error {}
export class CannotEvaluate extends Error {}
```

`src/outcome.ts`:

```ts
export type Mode = 'off' | 'warn' | 'enforce';
export type MemoProvenance = { hit: boolean; derivedAt?: string; toolVersion?: string };

export type Outcome =
  | { kind: 'not-evaluated' }
  | { kind: 'vacuous-pass' }
  | { kind: 'pass'; memo?: MemoProvenance }
  | { kind: 'mismatch'; committed: Buffer | null; derived: Buffer }
  | { kind: 'toolchain-skew'; pinned: string; effective: string }
  | { kind: 'unsupported-input'; reasons: string[] }
  | { kind: 'cannot-evaluate'; reason: string };

const FAILING = new Set(['mismatch', 'toolchain-skew', 'unsupported-input']);

export function exitCode(outcome: Outcome, mode: Mode): 0 | 1 {
  return mode === 'enforce' && FAILING.has(outcome.kind) ? 1 : 0;
}
```

- [ ] **Step 4: Run test to verify it passes** — `pnpm vitest run test/unit/outcome.test.ts` → PASS.

- [ ] **Step 5: Commit** via `git-commit` skill. Header: `feat: outcome types and exit-code mapping`

### Task A3: git plumbing helpers

`Model: opus`

**Files:**
- Create: `src/git.ts`
- Test: `test/unit/git.test.ts`, `test/helpers/scratch-repo.ts`

**Interfaces:**
- Consumes: `UsageError` from `src/errors.ts`.
- Produces:

```ts
export type GitResult = { status: number; stdout: Buffer; stderr: Buffer };
export function git(args: string[], opts?: { cwd?: string; stdin?: string | Buffer }): GitResult;
export function revParse(ref: string, cwd?: string): string;              // UsageError on unresolvable ref
export function catFile(ref: string, path: string, cwd?: string): Buffer | null; // null when absent
export function lsTreePaths(ref: string, cwd?: string): string[];
export function diffNames(base: string, head: string, cwd?: string): string[];
export function mergeBase(a: string, b: string, cwd?: string): string | null;
```

Trust path: imports only `node:child_process` and `src/errors.ts`.

- [ ] **Step 1: Write the scratch-repo helper** (used by many later tests)

`test/helpers/scratch-repo.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' });
}

/** git repo in a temp dir; returns its path. files = { 'relative/path': 'content' } */
export function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'assay-repo-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'test@test']);
  sh(dir, 'git', ['config', 'user.name', 'test']);
  writeFiles(dir, files);
  commitAll(dir, 'initial');
  return dir;
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

export function commitAll(dir: string, msg: string): string {
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-qm', msg]);
  return sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
}
```

- [ ] **Step 2: Write the failing test**

`test/unit/git.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { UsageError } from '../../src/errors.js';
import { catFile, diffNames, lsTreePaths, mergeBase, revParse } from '../../src/git.js';
import { commitAll, makeRepo, writeFiles } from '../helpers/scratch-repo.js';

describe('git plumbing', () => {
  it('revParse resolves and rejects', () => {
    const dir = makeRepo({ 'a.txt': 'a' });
    expect(revParse('HEAD', dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(() => revParse('nope-ref', dir)).toThrow(UsageError);
  });

  it('catFile returns bytes or null', () => {
    const dir = makeRepo({ 'a.txt': 'hello' });
    expect(catFile('HEAD', 'a.txt', dir)?.toString()).toBe('hello');
    expect(catFile('HEAD', 'missing.txt', dir)).toBeNull();
  });

  it('lsTreePaths and diffNames see the tree and the delta', () => {
    const dir = makeRepo({ 'a.txt': 'a', 'pkg/package.json': '{}' });
    const base = revParse('HEAD', dir);
    writeFiles(dir, { 'b.txt': 'b' });
    const head = commitAll(dir, 'add b');
    expect(lsTreePaths(head, dir).sort()).toEqual(['a.txt', 'b.txt', 'pkg/package.json']);
    expect(diffNames(base, head, dir)).toEqual(['b.txt']);
    expect(mergeBase(base, head, dir)).toBe(base);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `pnpm vitest run test/unit/git.test.ts` → FAIL (module missing).

- [ ] **Step 4: Implement**

`src/git.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { UsageError } from './errors.js';

export type GitResult = { status: number; stdout: Buffer; stderr: Buffer };

export function git(args: string[], opts: { cwd?: string; stdin?: string | Buffer } = {}): GitResult {
  const r = spawnSync('git', args, { cwd: opts.cwd, input: opts.stdin, maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export function revParse(ref: string, cwd?: string): string {
  const r = git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd });
  if (r.status !== 0) throw new UsageError(`unresolvable ref: ${ref}`);
  return r.stdout.toString().trim();
}

export function catFile(ref: string, path: string, cwd?: string): Buffer | null {
  const r = git(['cat-file', 'blob', `${ref}:${path}`], { cwd });
  return r.status === 0 ? r.stdout : null;
}

export function lsTreePaths(ref: string, cwd?: string): string[] {
  const r = git(['ls-tree', '-r', '--name-only', '-z', ref], { cwd });
  if (r.status !== 0) throw new UsageError(`cannot list tree: ${ref}`);
  return r.stdout.toString().split('\0').filter(Boolean);
}

export function diffNames(base: string, head: string, cwd?: string): string[] {
  const r = git(['diff', '--name-only', '-z', base, head], { cwd });
  if (r.status !== 0) throw new UsageError(`cannot diff ${base}..${head}`);
  return r.stdout.toString().split('\0').filter(Boolean);
}

export function mergeBase(a: string, b: string, cwd?: string): string | null {
  const r = git(['merge-base', a, b], { cwd });
  return r.status === 0 ? r.stdout.toString().trim() : null;
}
```

- [ ] **Step 5: Run to verify pass** — `pnpm vitest run test/unit/git.test.ts` → PASS.

- [ ] **Step 6: Commit.** Header: `feat: git plumbing helpers`

### Task A4: Config from base

`Model: opus`

**Files:**
- Create: `src/config.ts`
- Test: `test/unit/config.test.ts`

**Interfaces:**
- Consumes: `UsageError`.
- Produces:

```ts
export const CONFIG_PATH = '.lockfile-assay.json';
export function parseConfig(bytes: Buffer | null): Mode; // null → 'off'
```

- [ ] **Step 1: Write the failing test**

`test/unit/config.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`src/config.ts`:

```ts
import { UsageError } from './errors.js';
import type { Mode } from './outcome.js';

export const CONFIG_PATH = '.lockfile-assay.json';
const MODES = new Set(['off', 'warn', 'enforce']);

export function parseConfig(bytes: Buffer | null): Mode {
  if (bytes === null) return 'off';
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new UsageError(`${CONFIG_PATH} in base is not valid JSON (it broke on an earlier merge, not in this PR)`);
  }
  const mode = (parsed as { mode?: unknown })?.mode ?? 'off';
  if (typeof mode !== 'string' || !MODES.has(mode)) {
    throw new UsageError(`${CONFIG_PATH} in base has unknown mode: ${String(mode)}`);
  }
  return mode as Mode;
}
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit.** Header: `feat: mode config read from base`

### Task A5: Trigger + declared patch paths

`Model: opus`

**Files:**
- Create: `src/trigger.ts`
- Test: `test/unit/trigger.test.ts`

**Interfaces:**
- Consumes: `yaml` (allowed here — trigger is not in the §13 trust list).
- Produces:

```ts
export function declaredPatchPaths(workspaceYaml: Buffer | null, rootManifest: Buffer | null): string[];
export function isResolutionInput(path: string, declared: string[]): boolean;
export function isTriggered(changed: string[], declared: string[]): boolean;
```

Resolution inputs (spec §3): root `pnpm-lock.yaml`, any `package.json`, any `.npmrc`, `pnpm-workspace.yaml`, anything under `patches/`, any `*.patch`/`*.diff`, plus declared patch paths. `declaredPatchPaths` reads `patchedDependencies` from `pnpm-workspace.yaml` and from root `package.json` (`pnpm.patchedDependencies`).

- [ ] **Step 1: Write the failing test**

`test/unit/trigger.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { declaredPatchPaths, isTriggered } from '../../src/trigger.js';

describe('trigger', () => {
  it('fires on every resolution input, ignores source files', () => {
    const declared = ['vendor/odd-location.patch2'];
    for (const p of [
      'pnpm-lock.yaml',
      'package.json',
      'packages/app/package.json',
      '.npmrc',
      'packages/app/.npmrc',
      'pnpm-workspace.yaml',
      'patches/lodash@4.17.21.patch',
      'tools/fix.diff',
      'vendor/odd-location.patch2',
    ]) {
      expect(isTriggered([p, 'src/index.ts'], declared), p).toBe(true);
    }
    expect(isTriggered(['src/index.ts', 'README.md'], declared)).toBe(false);
  });

  it('extracts declared patch paths from workspace yaml and root manifest', () => {
    const ws = Buffer.from('packages:\n  - "packages/*"\npatchedDependencies:\n  lodash: vendor/lodash.patch\n');
    const pkg = Buffer.from(JSON.stringify({ pnpm: { patchedDependencies: { react: 'fixes/react.patch' } } }));
    expect(declaredPatchPaths(ws, pkg).sort()).toEqual(['fixes/react.patch', 'vendor/lodash.patch']);
    expect(declaredPatchPaths(null, null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`src/trigger.ts`:

```ts
import { parse } from 'yaml';

function values(obj: unknown): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  return Object.values(obj as Record<string, unknown>).filter((v): v is string => typeof v === 'string');
}

export function declaredPatchPaths(workspaceYaml: Buffer | null, rootManifest: Buffer | null): string[] {
  const out: string[] = [];
  if (workspaceYaml) {
    try {
      const ws = parse(workspaceYaml.toString('utf8')) as { patchedDependencies?: unknown } | null;
      out.push(...values(ws?.patchedDependencies));
    } catch {
      /* unparseable workspace file: pnpm itself will fail loudly later; the trigger over-approximates elsewhere */
    }
  }
  if (rootManifest) {
    try {
      const pkg = JSON.parse(rootManifest.toString('utf8')) as { pnpm?: { patchedDependencies?: unknown } };
      out.push(...values(pkg?.pnpm?.patchedDependencies));
    } catch {
      /* same posture */
    }
  }
  return out;
}

export function isResolutionInput(path: string, declared: string[]): boolean {
  if (path === 'pnpm-lock.yaml' || path === 'pnpm-workspace.yaml') return true;
  if (path === 'package.json' || path.endsWith('/package.json')) return true;
  if (path === '.npmrc' || path.endsWith('/.npmrc')) return true;
  if (path.startsWith('patches/')) return true;
  if (path.endsWith('.patch') || path.endsWith('.diff')) return true;
  return declared.includes(path);
}

export function isTriggered(changed: string[], declared: string[]): boolean {
  return changed.some((p) => isResolutionInput(p, declared));
}
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit.** Header: `feat: resolution-input trigger`

### Task A6: Staging — collect and materialize

`Model: fable`

**Files:**
- Create: `src/staging.ts`
- Test: `test/unit/staging.test.ts`

**Interfaces:**
- Consumes: `catFile`, `lsTreePaths` from `src/git.ts`; `isResolutionInput` semantics (re-implemented here as a *staging* filter — do NOT import `src/trigger.ts`, which uses `yaml`; declared paths arrive as an argument).
- Produces (memo key in PR C hashes exactly this list):

```ts
export type StagedFile = { path: string; bytes: Buffer };
export function collectStagedFiles(opts: {
  baseRef: string | null;   // null = no base lockfile (derive from scratch)
  headRef: string;
  declared: string[];
  cwd?: string;
}): StagedFile[];           // sorted by path; includes 'pnpm-lock.yaml' from BASE when present
export function materialize(files: StagedFile[], dir: string): void;
```

Staged from head (spec §3, pattern over-approximation — extra inert files are harmless; a missing exotic input fails closed at derive time): every `package.json`, every `.npmrc`, `pnpm-workspace.yaml`, `patches/**`, `**/*.patch`, `**/*.diff`, plus every `declared` path. The lockfile is staged from **base** only. Paths containing `..` or starting `/` are rejected (defense against crafted trees).

- [ ] **Step 1: Write the failing test**

`test/unit/staging.test.ts`:

```ts
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { revParse } from '../../src/git.js';
import { collectStagedFiles, materialize } from '../../src/staging.js';
import { commitAll, makeRepo, writeFiles } from '../helpers/scratch-repo.js';

describe('staging', () => {
  it('stages head resolution inputs and the BASE lockfile', () => {
    const dir = makeRepo({
      'package.json': '{"name":"r"}',
      'pnpm-lock.yaml': 'BASE-LOCK',
      'packages/a/package.json': '{"name":"a"}',
      '.npmrc': 'registry=http://x/',
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'patches/p.patch': 'P',
      'src/index.ts': 'code',
    });
    const base = revParse('HEAD', dir);
    writeFiles(dir, { 'pnpm-lock.yaml': 'HEAD-LOCK', 'src/index.ts': 'changed' });
    const head = commitAll(dir, 'change');

    const files = collectStagedFiles({ baseRef: base, headRef: head, declared: [], cwd: dir });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.bytes.toString()]));
    expect(byPath['pnpm-lock.yaml']).toBe('BASE-LOCK'); // from base, not head
    expect(Object.keys(byPath).sort()).toEqual([
      '.npmrc',
      'package.json',
      'packages/a/package.json',
      'patches/p.patch',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ]); // no src/index.ts
    expect(files.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort()); // sorted

    const out = mkdtempSync(join(tmpdir(), 'assay-stage-'));
    materialize(files, out);
    expect(readFileSync(join(out, 'pnpm-lock.yaml'), 'utf8')).toBe('BASE-LOCK');
    expect(readFileSync(join(out, 'packages/a/package.json'), 'utf8')).toBe('{"name":"a"}');
  });

  it('omits the lockfile when base has none; includes declared patch paths', () => {
    const dir = makeRepo({ 'package.json': '{}', 'vendor/x.fix': 'F' });
    const head = revParse('HEAD', dir);
    const files = collectStagedFiles({ baseRef: null, headRef: head, declared: ['vendor/x.fix'], cwd: dir });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('vendor/x.fix');
    expect(paths).not.toContain('pnpm-lock.yaml');
  });

  it('rejects path traversal', () => {
    expect(() => materialize([{ path: '../evil', bytes: Buffer.from('x') }], mkdtempSync(join(tmpdir(), 'a-')))).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`src/staging.ts`:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { catFile, lsTreePaths } from './git.js';

export type StagedFile = { path: string; bytes: Buffer };

function isStagedInput(path: string, declared: string[]): boolean {
  if (path === 'pnpm-workspace.yaml') return true;
  if (path === 'package.json' || path.endsWith('/package.json')) return true;
  if (path === '.npmrc' || path.endsWith('/.npmrc')) return true;
  if (path.startsWith('patches/')) return true;
  if (path.endsWith('.patch') || path.endsWith('.diff')) return true;
  return declared.includes(path);
}

function assertSafe(path: string): void {
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`unsafe staged path: ${path}`);
  }
}

export function collectStagedFiles(opts: {
  baseRef: string | null;
  headRef: string;
  declared: string[];
  cwd?: string;
}): StagedFile[] {
  const files: StagedFile[] = [];
  for (const path of lsTreePaths(opts.headRef, opts.cwd)) {
    if (path === 'pnpm-lock.yaml') continue; // head's lockfile is the thing under test, never an input
    if (!isStagedInput(path, opts.declared)) continue;
    assertSafe(path);
    const bytes = catFile(opts.headRef, path, opts.cwd);
    if (bytes !== null) files.push({ path, bytes });
  }
  if (opts.baseRef !== null) {
    const baseLock = catFile(opts.baseRef, 'pnpm-lock.yaml', opts.cwd);
    if (baseLock !== null) files.push({ path: 'pnpm-lock.yaml', bytes: baseLock });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function materialize(files: StagedFile[], dir: string): void {
  for (const f of files) {
    assertSafe(f.path);
    const target = join(dir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.bytes);
  }
}
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit.** Header: `feat: staging of base lock and head inputs`

### Task A7: Preflight — unsupported inputs

`Model: opus`

**Files:**
- Create: `src/preflight.ts`
- Test: `test/unit/preflight.test.ts`

**Interfaces:**
- Consumes: `StagedFile` from `src/staging.ts`.
- Produces: `export function unsupportedInputs(files: StagedFile[]): string[];` — empty array = supported. Detection (spec §3 preflight, fail-closed textual scans, builtins only): any path whose basename starts `.pnpmfile.`; `.npmrc` lines setting `pnpmfile`, `ignore-pnpmfile`, or `shared-workspace-lockfile=false`; `pnpm-workspace.yaml` lines setting `pnpmfile:`, `ignorePnpmfile:`, or `sharedWorkspaceLockfile: false`.

- [ ] **Step 1: Write the failing test**

`test/unit/preflight.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { unsupportedInputs } from '../../src/preflight.js';

const f = (path: string, s: string) => ({ path, bytes: Buffer.from(s) });

describe('preflight', () => {
  it('accepts a plain repo', () => {
    expect(unsupportedInputs([f('package.json', '{}'), f('.npmrc', 'registry=http://x/\n')])).toEqual([]);
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
    expect(unsupportedInputs([f('pnpm-workspace.yaml', 'sharedWorkspaceLockfile: false\n')])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`src/preflight.ts`:

```ts
import type { StagedFile } from './staging.js';

const NPMRC_KEYS = /^\s*(pnpmfile|ignore-pnpmfile)\s*=/m;
const NPMRC_SPLIT = /^\s*shared-workspace-lockfile\s*=\s*false\s*$/m;
const WS_KEYS = /^\s*(pnpmfile|ignorePnpmfile)\s*:/m;
const WS_SPLIT = /^\s*sharedWorkspaceLockfile\s*:\s*false\s*$/m;

export function unsupportedInputs(files: StagedFile[]): string[] {
  const reasons: string[] = [];
  for (const { path, bytes } of files) {
    const base = path.split('/').pop() ?? path;
    if (base.startsWith('.pnpmfile.')) {
      reasons.push(`${path}: pnpmfile is executable resolution code — unsupported in v1 (spec §3)`);
      continue;
    }
    const text = () => bytes.toString('utf8');
    if (base === '.npmrc') {
      if (NPMRC_KEYS.test(text())) reasons.push(`${path}: pnpmfile/ignore-pnpmfile config — unsupported in v1`);
      if (NPMRC_SPLIT.test(text())) reasons.push(`${path}: shared-workspace-lockfile=false splits the root lockfile — unsupported in v1`);
    }
    if (path === 'pnpm-workspace.yaml') {
      if (WS_KEYS.test(text())) reasons.push(`${path}: pnpmfile config — unsupported in v1`);
      if (WS_SPLIT.test(text())) reasons.push(`${path}: sharedWorkspaceLockfile: false — unsupported in v1`);
    }
  }
  return reasons;
}
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit.** Header: `feat: preflight for unsupported inputs`

### Task A8: Toolchain + derive

`Model: opus`

**Files:**
- Create: `src/toolchain.ts`, `src/derive.ts`
- Test: `test/unit/toolchain.test.ts`

**Interfaces:**
- Consumes: `UsageError`.
- Produces:

```ts
// src/toolchain.ts
export type Pin = { version: string };
export function parsePin(rootManifest: Buffer | null): Pin;   // UsageError: missing/not pnpm
export function pnpmLauncher(): string[];                     // ['corepack','pnpm'] if corepack exists, else ['pnpm']
export function effectivePnpmVersion(dir: string): string;    // runs `<launcher> --version` in dir
// src/derive.ts
export const INVOCATION =
  'pnpm install --lockfile-only --ignore-scripts --prefer-frozen-lockfile --ignore-pnpmfile';
export type DeriveResult = { ok: true; lockfile: Buffer } | { ok: false; status: number; stderr: string };
export function derive(dir: string): DeriveResult;            // reads dir/pnpm-lock.yaml after the run
```

Both spawn with `COREPACK_ENABLE_DOWNLOAD_PROMPT: '0'` merged into env. Test uses a **zero-dependency** staged dir — pnpm resolves nothing, so no registry is needed (corepack may download the pinned pnpm on first run; that is expected and cached).

- [ ] **Step 1: Write the failing test**

`test/unit/toolchain.test.ts`:

```ts
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { derive } from '../../src/derive.js';
import { UsageError } from '../../src/errors.js';
import { effectivePnpmVersion, parsePin } from '../../src/toolchain.js';

const PNPM = process.env.PNPM_FIXTURE_VERSION ?? '10.34.1';

function stagedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'assay-derive-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', packageManager: `pnpm@${PNPM}` }));
  return dir;
}

describe('toolchain', () => {
  it('parsePin demands a pnpm pin', () => {
    expect(parsePin(Buffer.from(JSON.stringify({ packageManager: 'pnpm@10.34.1' })))).toEqual({ version: '10.34.1' });
    expect(() => parsePin(null)).toThrow(UsageError);
    expect(() => parsePin(Buffer.from('{}'))).toThrow(UsageError);
    expect(() => parsePin(Buffer.from(JSON.stringify({ packageManager: 'yarn@4.0.0' })))).toThrow(UsageError);
  });

  it('effective version honors the staged pin', () => {
    expect(effectivePnpmVersion(stagedDir())).toBe(PNPM);
  });

  it('derive writes a lockfile for a zero-dep project and is idempotent', () => {
    const dir = stagedDir();
    const first = derive(dir);
    if (!first.ok) throw new Error(first.stderr);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false); // --lockfile-only
    const second = derive(dir);
    if (!second.ok) throw new Error(second.stderr);
    expect(second.lockfile.equals(first.lockfile)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`src/toolchain.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { UsageError } from './errors.js';

export type Pin = { version: string };

export function parsePin(rootManifest: Buffer | null): Pin {
  if (rootManifest === null) throw new UsageError('head has no root package.json');
  let pm: unknown;
  try {
    pm = (JSON.parse(rootManifest.toString('utf8')) as { packageManager?: unknown }).packageManager;
  } catch {
    throw new UsageError('head root package.json is not valid JSON');
  }
  const m = typeof pm === 'string' ? /^pnpm@(\S+)$/.exec(pm) : null;
  if (!m?.[1]) throw new UsageError('packageManager must pin pnpm (e.g. "pnpm@10.34.1") — spec §3');
  return { version: m[1] };
}

let launcher: string[] | null = null;
export function pnpmLauncher(): string[] {
  if (launcher) return launcher;
  const probe = spawnSync('corepack', ['--version']);
  launcher = probe.error || probe.status !== 0 ? ['pnpm'] : ['corepack', 'pnpm'];
  return launcher;
}

export function run(args: string[], dir: string): { status: number; stdout: Buffer; stderr: Buffer } {
  const [cmd, ...pre] = pnpmLauncher();
  const r = spawnSync(cmd as string, [...pre, ...args], {
    cwd: dir,
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export function effectivePnpmVersion(dir: string): string {
  const r = run(['--version'], dir);
  if (r.status !== 0) throw new Error(`cannot determine pnpm version: ${r.stderr.toString()}`);
  return r.stdout.toString().trim().split('\n').pop() as string;
}
```

`src/derive.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './toolchain.js';

export const INVOCATION =
  'pnpm install --lockfile-only --ignore-scripts --prefer-frozen-lockfile --ignore-pnpmfile';

export type DeriveResult = { ok: true; lockfile: Buffer } | { ok: false; status: number; stderr: string };

export function derive(dir: string): DeriveResult {
  const args = INVOCATION.split(' ').slice(1); // drop leading 'pnpm' — the launcher supplies it
  const r = run(args, dir);
  if (r.status !== 0) return { ok: false, status: r.status, stderr: r.stderr.toString() };
  return { ok: true, lockfile: readFileSync(join(dir, 'pnpm-lock.yaml')) };
}
```

- [ ] **Step 4: Run to verify pass** (first run may download pnpm via corepack — allow a minute).

- [ ] **Step 5: Commit.** Header: `feat: pinned-pnpm toolchain and derive`

### Task A9: Verdict + report delta parser

`Model: opus`

**Files:**
- Create: `src/verdict.ts`, `src/report/delta.ts`
- Test: `test/unit/delta.test.ts`

**Interfaces:**
- Produces:

```ts
// src/verdict.ts  (trust path: builtins only)
export function bytesEqual(a: Buffer | null, b: Buffer): boolean;
// src/report/delta.ts (the ONLY lockfile parser in the codebase)
export type Delta = { pkg: string; committed: string | null; derived: string | null };
export function deltaSummary(committed: Buffer | null, derived: Buffer): Delta[];
```

`deltaSummary` parses both lockfiles (lockfileVersion 9: top-level `packages:` keys shaped `name@version` / `@scope/name@version`, optionally with a `(peer...)` suffix) into `name → Set(version)` maps and reports every package whose version sets differ, sorted by name. No registry queries (spec §4).

- [ ] **Step 1: Write the failing test**

`test/unit/delta.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deltaSummary } from '../../src/report/delta.js';
import { bytesEqual } from '../../src/verdict.js';

const lock = (pkgs: string[]) =>
  Buffer.from(`lockfileVersion: '9.0'\npackages:\n${pkgs.map((p) => `  ${JSON.stringify(p)}: {}\n`).join('')}`);

describe('verdict', () => {
  it('byte equality is exact and null-safe', () => {
    expect(bytesEqual(Buffer.from('a'), Buffer.from('a'))).toBe(true);
    expect(bytesEqual(Buffer.from('a'), Buffer.from('b'))).toBe(false);
    expect(bytesEqual(null, Buffer.from('a'))).toBe(false);
  });
});

describe('deltaSummary', () => {
  it('reports version disagreements per package', () => {
    const committed = lock(['lodash@4.17.20', '@scope/x@1.0.0(react@18.2.0)']);
    const derived = lock(['lodash@4.17.21', '@scope/x@1.0.0(react@18.2.0)']);
    expect(deltaSummary(committed, derived)).toEqual([{ pkg: 'lodash', committed: '4.17.20', derived: '4.17.21' }]);
  });
  it('reports additions, removals, and a missing committed lockfile', () => {
    expect(deltaSummary(lock([]), lock(['evil@1.0.0']))).toEqual([{ pkg: 'evil', committed: null, derived: '1.0.0' }]);
    expect(deltaSummary(null, lock(['a@1.0.0']))).toEqual([{ pkg: 'a', committed: null, derived: '1.0.0' }]);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`src/verdict.ts`:

```ts
export function bytesEqual(a: Buffer | null, b: Buffer): boolean {
  return a !== null && a.equals(b);
}
```

`src/report/delta.ts`:

```ts
import { parse } from 'yaml';

export type Delta = { pkg: string; committed: string | null; derived: string | null };

function versions(lock: Buffer | null): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  if (lock === null) return map;
  let doc: unknown;
  try {
    doc = parse(lock.toString('utf8'));
  } catch {
    return map; // a lockfile pnpm's own serializer wrote always parses; report-side only, degrade quietly
  }
  const packages = (doc as { packages?: Record<string, unknown> })?.packages ?? {};
  for (const key of Object.keys(packages)) {
    const bare = key.replace(/\(.*$/, ''); // strip peer suffix
    const at = bare.lastIndexOf('@');
    if (at <= 0) continue;
    const name = bare.slice(0, at);
    const version = bare.slice(at + 1);
    if (!map.has(name)) map.set(name, new Set());
    map.get(name)?.add(version);
  }
  return map;
}

export function deltaSummary(committed: Buffer | null, derived: Buffer): Delta[] {
  const c = versions(committed);
  const d = versions(derived);
  const names = [...new Set([...c.keys(), ...d.keys()])].sort();
  const out: Delta[] = [];
  for (const name of names) {
    const cv = [...(c.get(name) ?? [])].sort().join(', ') || null;
    const dv = [...(d.get(name) ?? [])].sort().join(', ') || null;
    if (cv !== dv) out.push({ pkg: name, committed: cv, derived: dv });
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit.** Header: `feat: byte verdict and delta summary`

### Task A10: Report rendering

`Model: opus`

**Files:**
- Create: `src/report/render.ts`
- Test: `test/unit/render.test.ts`

**Interfaces:**
- Consumes: `Outcome`, `Mode`, `Delta`.
- Produces:

```ts
export const SCHEMA_VERSION = 1;
export type ReportInput = {
  outcome: Outcome; mode: Mode; base: string | null; head: string;
  toolchain?: { pinned: string; effective: string };
  deltas?: Delta[]; diffExcerpt?: string; remedy?: string;
};
export function refreshRecipe(baseRef: string | null): string;  // null → no-base variant (rm instead of git show)
export function diffExcerpt(committed: Buffer | null, derived: Buffer, maxLines?: number): string; // git diff --no-index, middle-elided at 100 lines
export function renderHuman(r: ReportInput): string;
export function renderJson(r: ReportInput): string;             // stable key order, schemaVersion first
```

`diffExcerpt` writes both buffers to temp files and shells `git diff --no-index --` (report-side; git is already required). JSON shape: `{schemaVersion, tool: {name, version}, outcome, mode, base, head, toolchain?, memo?, delta?, diffExcerpt?, remedy?, reasons?}` — `memo` comes from a `pass` outcome's provenance; `reasons` from `unsupported-input`.

- [ ] **Step 1: Write the failing test**

`test/unit/render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { diffExcerpt, refreshRecipe, renderJson } from '../../src/report/render.js';

describe('render', () => {
  it('refresh recipe restores base, or deletes when base had none', () => {
    expect(refreshRecipe('abc123')).toContain('git show abc123:pnpm-lock.yaml > pnpm-lock.yaml');
    expect(refreshRecipe(null)).toContain('rm pnpm-lock.yaml');
    expect(refreshRecipe('abc123')).toContain('--lockfile-only --ignore-scripts --prefer-frozen-lockfile');
  });

  it('diff excerpt bounds output to 100 lines with middle elision', () => {
    const committed = Buffer.from(Array.from({ length: 300 }, (_, i) => `line-${i}-old`).join('\n'));
    const derived = Buffer.from(Array.from({ length: 300 }, (_, i) => `line-${i}-new`).join('\n'));
    const excerpt = diffExcerpt(committed, derived);
    expect(excerpt.split('\n').length).toBeLessThanOrEqual(101);
    expect(excerpt).toContain('… elided …');
  });

  it('json report carries schemaVersion 1 and the outcome', () => {
    const j = JSON.parse(
      renderJson({ outcome: { kind: 'mismatch', committed: null, derived: Buffer.from('x') }, mode: 'enforce', base: 'b', head: 'h' }),
    );
    expect(j.schemaVersion).toBe(1);
    expect(j.outcome).toBe('mismatch');
    expect(j.tool.name).toBe('lockfile-assay');
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`src/report/render.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Delta } from './delta.js';
import type { Mode, Outcome } from '../outcome.js';

export const SCHEMA_VERSION = 1;

const TOOL_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return pkg.version as string;
  } catch {
    return 'unknown';
  }
})();

export type ReportInput = {
  outcome: Outcome;
  mode: Mode;
  base: string | null;
  head: string;
  toolchain?: { pinned: string; effective: string };
  deltas?: Delta[];
  diffExcerpt?: string;
  remedy?: string;
};

export function refreshRecipe(baseRef: string | null): string {
  const restore =
    baseRef === null
      ? 'rm pnpm-lock.yaml                                 # base had no lockfile: derive from scratch'
      : `git show ${baseRef}:pnpm-lock.yaml > pnpm-lock.yaml   # restore the reviewed prior state`;
  return [
    restore,
    'pnpm install --lockfile-only --ignore-scripts --prefer-frozen-lockfile',
    'git add pnpm-lock.yaml && git commit              # or --amend, as fits the branch',
  ].join('\n');
}

export function diffExcerpt(committed: Buffer | null, derived: Buffer, maxLines = 100): string {
  const dir = mkdtempSync(join(tmpdir(), 'assay-diff-'));
  writeFileSync(join(dir, 'committed'), committed ?? Buffer.alloc(0));
  writeFileSync(join(dir, 'derived'), derived);
  let out = '';
  try {
    execFileSync('git', ['diff', '--no-index', '--', 'committed', 'derived'], { cwd: dir, encoding: 'utf8' });
  } catch (e) {
    out = (e as { stdout?: string }).stdout ?? ''; // git diff exits 1 on differences; the diff is on stdout
  }
  const lines = out.split('\n');
  if (lines.length <= maxLines) return out;
  const head = lines.slice(0, maxLines / 2);
  const tail = lines.slice(-maxLines / 2 + 1);
  return [...head, `… elided ${lines.length - maxLines + 1} lines …`, ...tail].join('\n');
}

export function renderJson(r: ReportInput): string {
  const memo = r.outcome.kind === 'pass' ? r.outcome.memo : undefined;
  const reasons = r.outcome.kind === 'unsupported-input' ? r.outcome.reasons : undefined;
  const skew =
    r.outcome.kind === 'toolchain-skew' ? { pinned: r.outcome.pinned, effective: r.outcome.effective } : r.toolchain;
  return JSON.stringify(
    {
      schemaVersion: SCHEMA_VERSION,
      tool: { name: 'lockfile-assay', version: TOOL_VERSION },
      outcome: r.outcome.kind,
      mode: r.mode,
      base: r.base,
      head: r.head,
      toolchain: skew,
      memo,
      reasons,
      delta: r.deltas,
      diffExcerpt: r.diffExcerpt,
      remedy: r.remedy,
    },
    null,
    2,
  );
}

export function renderHuman(r: ReportInput): string {
  const lines: string[] = [`lockfile-assay: ${r.outcome.kind} (mode: ${r.mode})`];
  if (r.outcome.kind === 'pass' && r.outcome.memo?.hit) {
    lines.push(`served from derivation memo (derivedAt ${r.outcome.memo.derivedAt ?? '?'})`);
  }
  if (r.outcome.kind === 'toolchain-skew') {
    lines.push(`pinned pnpm ${r.outcome.pinned} but effective ${r.outcome.effective} — align your toolchain, then re-run`);
  }
  if (r.outcome.kind === 'unsupported-input') {
    for (const reason of r.outcome.reasons) lines.push(`unsupported: ${reason}`);
  }
  if (r.outcome.kind === 'mismatch') {
    lines.push('', 'the committed lockfile is NOT what honest re-derivation produces.', '');
    for (const d of r.deltas ?? []) lines.push(`  ${d.pkg}: committed ${d.committed ?? '—'} / derived ${d.derived ?? '—'}`);
    if (r.diffExcerpt) lines.push('', r.diffExcerpt);
    if (r.remedy) lines.push('', 'refresh recipe (a version delta reads as drift; a tarball: URL or novel edge reads as an attack — read before you refresh):', r.remedy);
  }
  if (r.outcome.kind === 'cannot-evaluate') lines.push(r.outcome.reason);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit.** Header: `feat: human and json reports`

### Task A11: Check orchestration + CLI wiring

`Model: fable`

**Files:**
- Create: `src/check.ts`
- Modify: `src/cli.ts` (replace placeholder)
- Test: `test/unit/check.test.ts`

**Interfaces:**
- Consumes: everything above, by exact name.
- Produces (PR B and C call this):

```ts
export type MemoHook = {
  consult(files: StagedFile[], committed: Buffer | null): Promise<MemoProvenance | null>;
  record(files: StagedFile[], derived: Buffer): Promise<void>;
};
export type CheckResult = { outcome: Outcome; mode: Mode; exit: 0 | 1; report: ReportInput };
export async function runCheck(opts: {
  base: string; head: string; cwd?: string; memo?: MemoHook | null;
}): Promise<CheckResult>;
```

Flow (spec §13): revParse both → `diffNames` + `declaredPatchPaths(head)` → not triggered → `vacuous-pass` → `parseConfig(catFile(base, CONFIG_PATH))` → `off` → `not-evaluated` → `collectStagedFiles` → `unsupportedInputs` → `parsePin` → `memo.consult` (hit → `pass` with provenance) → `materialize` into `mkdtemp` → skew check → `derive` (failure → throw, exit 3) → `bytesEqual` → pass (+`memo.record`) or mismatch report with deltas/excerpt/recipe.

- [ ] **Step 1: Write the failing test** — unit-level, no registry: a repo with **no dependencies** exercises the full flow live (derive works offline for zero deps, Task A8).

`test/unit/check.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check.js';
import { revParse } from '../../src/git.js';
import { commitAll, makeRepo, sh, writeFiles } from '../helpers/scratch-repo.js';

const PNPM = process.env.PNPM_FIXTURE_VERSION ?? '10.34.1';
const manifest = (extra: object = {}) =>
  JSON.stringify({ name: 't', version: '1.0.0', packageManager: `pnpm@${PNPM}`, ...extra });

function repoWithConfig(): string {
  return makeRepo({ 'package.json': manifest(), '.lockfile-assay.json': '{"mode":"enforce"}' });
}

describe('runCheck', () => {
  it('vacuous pass when no resolution input changed', async () => {
    const dir = repoWithConfig();
    const base = revParse('HEAD', dir);
    writeFiles(dir, { 'src.ts': 'x' });
    const head = commitAll(dir, 'source only');
    const r = await runCheck({ base, head, cwd: dir });
    expect(r.outcome.kind).toBe('vacuous-pass');
    expect(r.exit).toBe(0);
  });

  it('not evaluated when base has no config', async () => {
    const dir = makeRepo({ 'package.json': manifest() });
    const base = revParse('HEAD', dir);
    writeFiles(dir, { 'package.json': manifest({ description: 'x' }) });
    const head = commitAll(dir, 'touch manifest');
    expect((await runCheck({ base, head, cwd: dir })).outcome.kind).toBe('not-evaluated');
  });

  it('unsupported input fails under enforce', async () => {
    const dir = repoWithConfig();
    const base = revParse('HEAD', dir);
    writeFiles(dir, { '.pnpmfile.cjs': 'module.exports = {}' });
    const head = commitAll(dir, 'add pnpmfile');
    const r = await runCheck({ base, head, cwd: dir });
    expect(r.outcome.kind).toBe('unsupported-input');
    expect(r.exit).toBe(1);
  });

  it('honest zero-dep lockfile change passes; tampered bytes mismatch', async () => {
    const dir = repoWithConfig();
    const base = revParse('HEAD', dir);
    // author path: derive the honest lockfile in the working tree and commit it
    sh(dir, 'corepack', ['pnpm', 'install', '--lockfile-only', '--ignore-scripts']);
    const head = commitAll(dir, 'add lockfile');
    const pass = await runCheck({ base, head, cwd: dir });
    expect(pass.outcome.kind).toBe('pass');

    writeFiles(dir, { 'pnpm-lock.yaml': `${sh(dir, 'cat', ['pnpm-lock.yaml'])}\n# tampered\n` });
    const tampered = commitAll(dir, 'tamper');
    const fail = await runCheck({ base, head: tampered, cwd: dir });
    expect(fail.outcome.kind).toBe('mismatch');
    expect(fail.exit).toBe(1);
    expect(fail.report.remedy).toContain('pnpm-lock.yaml');
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**

`src/check.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_PATH, parseConfig } from './config.js';
import { derive } from './derive.js';
import { catFile, diffNames, revParse } from './git.js';
import type { MemoProvenance, Mode, Outcome } from './outcome.js';
import { exitCode } from './outcome.js';
import { unsupportedInputs } from './preflight.js';
import { deltaSummary } from './report/delta.js';
import type { ReportInput } from './report/render.js';
import { diffExcerpt, refreshRecipe } from './report/render.js';
import type { StagedFile } from './staging.js';
import { collectStagedFiles, materialize } from './staging.js';
import { effectivePnpmVersion, parsePin } from './toolchain.js';
import { declaredPatchPaths } from './trigger.js';
import { isTriggered } from './trigger.js';
import { bytesEqual } from './verdict.js';

export type MemoHook = {
  consult(files: StagedFile[], committed: Buffer | null): Promise<MemoProvenance | null>;
  record(files: StagedFile[], derived: Buffer): Promise<void>;
};

export type CheckResult = { outcome: Outcome; mode: Mode; exit: 0 | 1; report: ReportInput };

function result(outcome: Outcome, mode: Mode, base: string | null, head: string, extra: Partial<ReportInput> = {}): CheckResult {
  return { outcome, mode, exit: exitCode(outcome, mode), report: { outcome, mode, base, head, ...extra } };
}

export async function runCheck(opts: {
  base: string;
  head: string;
  cwd?: string;
  memo?: MemoHook | null;
}): Promise<CheckResult> {
  const cwd = opts.cwd;
  const base = revParse(opts.base, cwd);
  const head = revParse(opts.head, cwd);

  const declared = declaredPatchPaths(catFile(head, 'pnpm-workspace.yaml', cwd), catFile(head, 'package.json', cwd));
  if (!isTriggered(diffNames(base, head, cwd), declared)) return result({ kind: 'vacuous-pass' }, 'off', base, head);

  const mode = parseConfig(catFile(base, CONFIG_PATH, cwd));
  if (mode === 'off') return result({ kind: 'not-evaluated' }, mode, base, head);

  const baseHasLock = catFile(base, 'pnpm-lock.yaml', cwd) !== null;
  const files = collectStagedFiles({ baseRef: baseHasLock ? base : null, headRef: head, declared, cwd });

  const reasons = unsupportedInputs(files);
  if (reasons.length > 0) return result({ kind: 'unsupported-input', reasons }, mode, base, head);

  const pin = parsePin(catFile(head, 'package.json', cwd));
  const committed = catFile(head, 'pnpm-lock.yaml', cwd);

  const memoHit = (await opts.memo?.consult(files, committed)) ?? null;
  if (memoHit) return result({ kind: 'pass', memo: memoHit }, mode, base, head);

  const dir = mkdtempSync(join(tmpdir(), 'lockfile-assay-'));
  materialize(files, dir);

  const effective = effectivePnpmVersion(dir);
  if (effective !== pin.version) {
    return result({ kind: 'toolchain-skew', pinned: pin.version, effective }, mode, base, head, {
      toolchain: { pinned: pin.version, effective },
    });
  }

  const derived = derive(dir);
  if (!derived.ok) {
    // resolver/network failure: CI form fails red in any mode (exit 3 at the CLI boundary)
    throw new Error(`derivation failed (pnpm exit ${derived.status}):\n${derived.stderr}`);
  }

  if (bytesEqual(committed, derived.lockfile)) {
    await opts.memo?.record(files, derived.lockfile);
    return result({ kind: 'pass' }, mode, base, head, { toolchain: { pinned: pin.version, effective } });
  }

  return result({ kind: 'mismatch', committed, derived: derived.lockfile }, mode, base, head, {
    toolchain: { pinned: pin.version, effective },
    deltas: deltaSummary(committed, derived.lockfile),
    diffExcerpt: diffExcerpt(committed, derived.lockfile),
    remedy: refreshRecipe(baseHasLock ? base : null),
  });
}
```

`src/cli.ts` (replace placeholder):

```ts
#!/usr/bin/env node
import { program } from 'commander';
import { runCheck } from './check.js';
import { CannotEvaluate, UsageError } from './errors.js';
import { renderHuman, renderJson } from './report/render.js';

async function main(): Promise<void> {
  program.name('lockfile-assay').description('Prove your lockfile is untampered.');
  program
    .command('check')
    .description('verify the committed lockfile derives honestly from reviewable inputs')
    .option('--base <ref>', 'base ref (e.g. the PR merge-base)')
    .option('--head <ref>', 'head ref', 'HEAD')
    .option('--staged', 'check the index instead of a commit (git hook form)')
    .option('--json', 'emit the machine report')
    .action(async (o: { base?: string; head: string; staged?: boolean; json?: boolean }) => {
      if (o.staged) throw new UsageError('--staged lands in the next release'); // replaced in PR B
      if (!o.base) throw new UsageError('--base <ref> is required');
      const r = await runCheck({ base: o.base, head: o.head });
      console.log(o.json ? renderJson(r.report) : renderHuman(r.report));
      process.exitCode = r.exit;
    });
  await program.parseAsync();
}

main().catch((e: unknown) => {
  if (e instanceof UsageError) {
    console.error(`usage error: ${e.message}`);
    process.exitCode = 2;
  } else if (e instanceof CannotEvaluate) {
    console.error(`cannot evaluate: ${e.message}`);
    process.exitCode = 0;
  } else {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 3;
  }
});
```

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run test/unit/check.test.ts`, then the whole unit ring: `pnpm test:unit`.

- [ ] **Step 5: Also verify the CLI end to end in this repo** (dogfood by hand):

Run: `pnpm build && node dist/cli.js check --base HEAD~1 --head HEAD --json`
Expected: a JSON report; exit 0 (`vacuous-pass` or `not-evaluated` depending on the commit touched).

- [ ] **Step 6: Commit.** Header: `feat: check command end to end`

### Task A12: Import-graph guard

`Model: opus`

**Files:**
- Test: `test/unit/import-graph.test.ts`

**Interfaces:** consumes source files as text only.

- [ ] **Step 1: Write the test (it should PASS immediately — it guards the §13 property)**

`test/unit/import-graph.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TRUST_PATH = ['git.ts', 'staging.ts', 'preflight.ts', 'toolchain.ts', 'derive.ts', 'verdict.ts'];
const SRC = join(import.meta.dirname, '../../src');

function importsOf(file: string): string[] {
  const text = readFileSync(join(SRC, file), 'utf8');
  return [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
}

describe('spec §13 trust-path discipline', () => {
  it('trust-path modules import only node builtins and each other', () => {
    for (const file of TRUST_PATH) {
      for (const imp of importsOf(file)) {
        const ok =
          imp.startsWith('node:') ||
          (imp.startsWith('./') && !imp.includes('report/') && !imp.includes('trigger') && !imp.includes('config'));
        expect(ok, `${file} imports ${imp}`).toBe(true);
      }
    }
  });

  it('yaml is imported only by trigger and report/', () => {
    const all = ['trigger.ts', 'config.ts', 'check.ts', 'cli.ts', 'outcome.ts', 'errors.ts', ...TRUST_PATH];
    const reportFiles = readdirSync(join(SRC, 'report')).map((f) => `report/${f}`);
    for (const file of [...all, ...reportFiles]) {
      const usesYaml = importsOf(file).some((i) => i === 'yaml');
      const allowed = file === 'trigger.ts' || file.startsWith('report/');
      if (usesYaml) expect(allowed, `${file} must not import yaml`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it** — `pnpm vitest run test/unit/import-graph.test.ts` → PASS (if it fails, a trust-path module has an illegal import: fix the module, not the test).

- [ ] **Step 3: Commit.** Header: `feat: import-graph guard for trust path`

### Task A13: Hermetic integration harness (Verdaccio + fixture repos)

`Model: fable`

**Files:**
- Create: `test/helpers/registry.ts`, `test/helpers/fixture.ts`
- Test: `test/integration/harness.test.ts`

**Interfaces:**
- Consumes: `makeRepo`/`writeFiles`/`commitAll`/`sh` from `test/helpers/scratch-repo.ts`.
- Produces (Tasks A14/A15 and PR C depend on these exact signatures):

```ts
// test/helpers/registry.ts
export type Registry = { url: string; port: number; stop(): Promise<void>; publish(pkg: SyntheticPkg): Promise<void> };
export type SyntheticPkg = { name: string; version: string; dependencies?: Record<string, string> };
export async function startRegistry(): Promise<Registry>;

// test/helpers/fixture.ts
export type Fixture = { dir: string; registry: Registry; base: string };
export const PNPM_VERSION: string; // process.env.PNPM_FIXTURE_VERSION ?? '10.34.1'
export async function makeFixtureRepo(registry: Registry, deps?: Record<string, string>): Promise<Fixture>;
// repo with: package.json (pnpm pin + deps), .npmrc → registry, .lockfile-assay.json enforce,
// then an author-path lockfile committed as `base`
export function relock(dir: string): void;      // author-path: corepack pnpm install --lockfile-only --ignore-scripts
export function readLock(dir: string): string;  // working-tree pnpm-lock.yaml
```

`startRegistry` runs Verdaccio **in-process** (`import('verdaccio')` → `runServer`) on an ephemeral port with `{ storage: mkdtemp, packages: { '**': { access: '$all', publish: '$all' } }, security minimal, uplinks: {} }` — no uplinks, fully offline. `publish` PUTs the package document directly (no npm client): manifest versions + `_attachments` with a gzipped tarball built via the system `tar` from a temp `package/` dir, `dist.integrity` = sha512 of the tarball (`node:crypto`), `dist.tarball` = `${url}/${name}/-/${name}-${version}.tgz`.

- [ ] **Step 1: Write the harness** (both helper files, complete code — this is infrastructure, the test after proves it).

`test/helpers/registry.ts`:

```ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runServer } from 'verdaccio';

export type SyntheticPkg = { name: string; version: string; dependencies?: Record<string, string> };
export type Registry = {
  url: string;
  port: number;
  stop(): Promise<void>;
  publish(pkg: SyntheticPkg): Promise<void>;
};

function tarball(pkg: SyntheticPkg): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'assay-pkg-'));
  mkdirSync(join(dir, 'package'));
  writeFileSync(
    join(dir, 'package', 'package.json'),
    JSON.stringify({ name: pkg.name, version: pkg.version, main: 'index.js', dependencies: pkg.dependencies ?? {} }),
  );
  writeFileSync(join(dir, 'package', 'index.js'), `module.exports = '${pkg.name}@${pkg.version}';\n`);
  execFileSync('tar', ['-czf', 'pkg.tgz', 'package'], { cwd: dir });
  return readFileSync(join(dir, 'pkg.tgz'));
}

export async function startRegistry(): Promise<Registry> {
  const storage = mkdtempSync(join(tmpdir(), 'assay-verdaccio-'));
  const app = await runServer({
    self_path: storage,
    storage,
    uplinks: {},
    packages: { '**': { access: '$all', publish: '$all' } },
    security: { api: { legacy: true } },
    log: { level: 'fatal' },
  } as never);
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const url = `http://localhost:${port}/`;

  async function publish(pkg: SyntheticPkg): Promise<void> {
    const tgz = tarball(pkg);
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    const tarName = `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`;
    const doc = {
      _id: pkg.name,
      name: pkg.name,
      'dist-tags': { latest: pkg.version },
      versions: {
        [pkg.version]: {
          name: pkg.name,
          version: pkg.version,
          main: 'index.js',
          dependencies: pkg.dependencies ?? {},
          dist: { integrity, tarball: `${url}${encodeURIComponent(pkg.name)}/-/${tarName}` },
        },
      },
      _attachments: { [tarName]: { content_type: 'application/octet-stream', data: tgz.toString('base64'), length: tgz.length } },
    };
    const res = await fetch(`${url}${encodeURIComponent(pkg.name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer anonymous' },
      body: JSON.stringify(doc),
    });
    if (!res.ok && res.status !== 409) throw new Error(`publish ${pkg.name}@${pkg.version} failed: ${res.status} ${await res.text()}`);
  }

  return {
    url,
    port,
    publish,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

(If `runServer`'s option shape fights back — Verdaccio 6 config typing is loose — fall back to writing a `config.yaml` into the storage dir and spawning `pnpm exec verdaccio --config ... --listen 0` as a child process, polling the port; keep the same `Registry` interface either way. If anonymous `PUT` is rejected, add `auth: { htpasswd: { file: join(storage, 'htpasswd') } }` and send any well-formed Bearer token with `security.api.legacy: true`.)

`test/helpers/fixture.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, makeRepo, sh } from './scratch-repo.js';
import type { Registry } from './registry.js';

export const PNPM_VERSION = process.env.PNPM_FIXTURE_VERSION ?? '10.34.1';

export type Fixture = { dir: string; registry: Registry; base: string };

export function relock(dir: string): void {
  sh(dir, 'corepack', ['pnpm', 'install', '--lockfile-only', '--ignore-scripts']);
}

export function readLock(dir: string): string {
  return readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8');
}

export async function makeFixtureRepo(registry: Registry, deps: Record<string, string> = {}): Promise<Fixture> {
  const dir = makeRepo({
    'package.json': JSON.stringify(
      { name: 'fixture', version: '1.0.0', packageManager: `pnpm@${PNPM_VERSION}`, dependencies: deps },
      null,
      2,
    ),
    '.npmrc': `registry=${registry.url}\n`,
    '.lockfile-assay.json': '{ "mode": "enforce" }',
  });
  relock(dir);
  const base = commitAll(dir, 'base with lockfile');
  return { dir, registry, base };
}
```

- [ ] **Step 2: Write the proving test**

`test/integration/harness.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtureRepo, readLock } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'left-pad', version: '1.0.0' });
});
afterAll(() => registry.stop());

describe('harness', () => {
  it('publishes to verdaccio and pnpm locks against it', async () => {
    const { dir } = await makeFixtureRepo(registry, { 'left-pad': '^1.0.0' });
    expect(readLock(dir)).toContain('left-pad@1.0.0');
  });
});
```

- [ ] **Step 3: Run it** — `pnpm test:integration` → PASS (first run downloads the pinned pnpm via corepack).

- [ ] **Step 4: Commit.** Header: `feat: hermetic registry test harness`

### Task A14: Empirics suite — pin spec §3's verified claims

`Model: opus`

**Files:**
- Test: `test/integration/empirics.test.ts`

**Interfaces:** consumes the harness exactly as defined in A13.

- [ ] **Step 1: Write the suite** (these must all pass against real pnpm — they are the spec's §3 bullet list, one test per bullet)

`test/integration/empirics.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check.js';
import { revParse } from '../../src/git.js';
import { makeFixtureRepo, readLock, relock } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { commitAll, sh, writeFiles } from '../helpers/scratch-repo.js';

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
  await registry.publish({ name: 'alpha', version: '1.1.0' });
  await registry.publish({ name: 'beta', version: '2.0.0', dependencies: { alpha: '^1.0.0' } });
});
afterAll(() => registry.stop());

describe('spec §3 empirics', () => {
  it('two independent from-scratch resolves are byte-identical', async () => {
    const a = await makeFixtureRepo(registry, { beta: '^2.0.0' });
    const b = await makeFixtureRepo(registry, { beta: '^2.0.0' });
    expect(readLock(a.dir)).toBe(readLock(b.dir));
  });

  it('author path (pnpm add) equals checker path (edit manifest + relock)', async () => {
    const viaAdd = await makeFixtureRepo(registry, {});
    sh(viaAdd.dir, 'corepack', ['pnpm', 'add', '--lockfile-only', '--ignore-scripts', 'alpha@^1.0.0']);
    const viaEdit = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    expect(readLock(viaAdd.dir)).toBe(readLock(viaEdit.dir));
  });

  it('re-running install on an in-sync tree rewrites nothing', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    const before = readLock(f.dir);
    relock(f.dir);
    expect(readLock(f.dir)).toBe(before);
  });

  it('still-satisfying locked versions are reused, not re-resolved', async () => {
    // base locks alpha@1.1.0 via beta’s ^1.0.0; a NEWER alpha appears; untouched specs must not move
    const f = await makeFixtureRepo(registry, { beta: '^2.0.0' });
    await registry.publish({ name: 'alpha', version: '1.2.0' });
    writeFiles(f.dir, { 'README.md': 'touch a resolution-irrelevant file? no — touch the manifest' });
    // change an unrelated manifest field so the check actually stages and re-derives
    const pkg = JSON.parse(sh(f.dir, 'cat', ['package.json']));
    pkg.description = 'bump nothing';
    writeFiles(f.dir, { 'package.json': JSON.stringify(pkg, null, 2) });
    const head = commitAll(f.dir, 'manifest touch');
    const r = await runCheck({ base: f.base, head, cwd: f.dir });
    expect(r.outcome.kind).toBe('pass'); // lockfile unchanged and still derivable ⇒ alpha stayed locked
    expect(readLock(f.dir)).not.toContain('alpha@1.2.0');
  });

  it('an honest dependency bump passes the check', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    const pkg = JSON.parse(sh(f.dir, 'cat', ['package.json']));
    pkg.dependencies.beta = '^2.0.0';
    writeFiles(f.dir, { 'package.json': JSON.stringify(pkg, null, 2) });
    relock(f.dir); // author refreshes honestly
    const head = commitAll(f.dir, 'add beta');
    const r = await runCheck({ base: f.base, head, cwd: f.dir });
    expect(r.outcome.kind).toBe('pass');
    expect(revParse('HEAD', f.dir)).toBe(head);
  });
});
```

- [ ] **Step 2: Run** — `pnpm test:integration` → PASS on pnpm 10.34.1; then `PNPM_FIXTURE_VERSION=9.12.0 pnpm test:integration` → PASS. If a case fails, that is a **spec-level finding** — stop and report, do not massage the test.

- [ ] **Step 3: Commit.** Header: `feat: pin spec empirics as integration tests`

### Task A15: Attack shapes + drift/remedy suite

`Model: fable`

**Files:**
- Test: `test/integration/attacks.test.ts`, `test/integration/drift.test.ts`

**Interfaces:** consumes harness + `runCheck`. Each §1.1 row is one named test.

- [ ] **Step 1: Write the attack suite**

`test/integration/attacks.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check.js';
import { type Fixture, makeFixtureRepo, relock } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { commitAll, writeFiles } from '../helpers/scratch-repo.js';

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
  await registry.publish({ name: 'alpha', version: '1.1.0' });
  await registry.publish({ name: 'evil', version: '9.9.9' });
});
afterAll(() => registry.stop());

/** author honestly bumps alpha ^1.0.0 → head lockfile, then the attacker edits the committed lockfile */
async function tamperedHead(f: Fixture, mutate: (lock: string) => string): Promise<string> {
  const pkg = JSON.parse(readFileSync(join(f.dir, 'package.json'), 'utf8'));
  pkg.dependencies = { ...pkg.dependencies, alpha: '^1.0.0' };
  writeFiles(f.dir, { 'package.json': JSON.stringify(pkg, null, 2) });
  relock(f.dir);
  const honest = readFileSync(join(f.dir, 'pnpm-lock.yaml'), 'utf8');
  const mutated = mutate(honest);
  if (mutated === honest) throw new Error('mutation did not change the lockfile — fix the regex, not the assertion');
  writeFiles(f.dir, { 'pnpm-lock.yaml': mutated });
  return commitAll(f.dir, 'bump alpha (tampered)');
}

async function expectMismatch(mutate: (lock: string) => string): Promise<void> {
  const f = await makeFixtureRepo(registry, {});
  const head = await tamperedHead(f, mutate);
  const r = await runCheck({ base: f.base, head, cwd: f.dir });
  expect(r.outcome.kind).toBe('mismatch');
  expect(r.exit).toBe(1);
}

describe('spec §1.1 attack shapes — every row must byte-fail', () => {
  it('tarball-URL resolution swap', () =>
    expectMismatch((lock) =>
      lock.replace(/alpha@1\.1\.0:\s*\n(\s+)resolution: \{/, (m, indent) =>
        m.replace('resolution: {', `resolution: {tarball: http://evil.example/alpha.tgz, `),
      ),
    ));

  it('phantom edge injected into a snapshot', () =>
    expectMismatch((lock) => lock.replace(/(snapshots:\n\n  alpha@1\.1\.0:)\s*\{\}/, '$1\n    dependencies:\n      evil: 9.9.9')));

  it('integrity lie for a real name@version', () =>
    expectMismatch((lock) => lock.replace(/integrity: sha512-[A-Za-z0-9+/=]+/, 'integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==')));

  it('within-range version-choice game (older but in-range pin)', () =>
    expectMismatch((lock) => lock.replaceAll('1.1.0', '1.0.0')));

  it('.npmrc registry redirect PASSES by design (visible diff, review’s job)', async () => {
    const mirror = await startRegistry();
    await mirror.publish({ name: 'alpha', version: '1.0.0' });
    await mirror.publish({ name: 'alpha', version: '1.1.0' });
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    writeFiles(f.dir, { '.npmrc': `registry=${mirror.url}\n` });
    relock(f.dir); // author relocks against the mirror — same bytes: pnpm registry entries carry no URLs
    const head = commitAll(f.dir, 'redirect registry');
    const r = await runCheck({ base: f.base, head, cwd: f.dir });
    expect(r.outcome.kind).toBe('pass');
    await mirror.stop();
  });
});
```

**Note on the mutation regexes:** exact lockfile text varies slightly between pnpm 9 (`lockfileVersion: '9.0'` in both) — if a `replace` does not change the string (assert `mutated !== honest` inside `tamperedHead` and fail loudly), adjust the regex against the real fixture output; the *scenario* is the contract, the regex is plumbing. Snapshot/quoting details differ per version; make each mutation idempotent-safe by asserting the mutated text differs before committing.

- [ ] **Step 2: Write the drift/remedy suite**

`test/integration/drift.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check.js';
import { makeFixtureRepo, relock } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { commitAll, sh, writeFiles } from '../helpers/scratch-repo.js';

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
});
afterAll(() => registry.stop());

describe('spec §7 drift + §4 self-healing remedy', () => {
  it('registry drift on a floor-moved spec mismatches, and the refresh recipe converges to pass', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    // author bumps the floor and locks against today’s registry (alpha 1.1.0 not yet published… publish then lock)
    await registry.publish({ name: 'alpha', version: '1.1.0' });
    const pkg = JSON.parse(readFileSync(join(f.dir, 'package.json'), 'utf8'));
    pkg.dependencies.alpha = '^1.1.0';
    writeFiles(f.dir, { 'package.json': JSON.stringify(pkg, null, 2) });
    relock(f.dir);
    const head = commitAll(f.dir, 'bump alpha floor');

    // the registry moves before CI runs: a newer in-range alpha appears
    await registry.publish({ name: 'alpha', version: '1.2.0' });
    const drifted = await runCheck({ base: f.base, head, cwd: f.dir });
    expect(drifted.outcome.kind).toBe('mismatch'); // honest PR blocked — fail-closed residual, spec §7

    // apply the report’s refresh recipe verbatim (spec §4)
    sh(f.dir, 'sh', ['-c', `git show ${f.base}:pnpm-lock.yaml > pnpm-lock.yaml`]);
    relock(f.dir);
    const refreshed = commitAll(f.dir, 'refresh lockfile');
    const healed = await runCheck({ base: f.base, head: refreshed, cwd: f.dir });
    expect(healed.outcome.kind).toBe('pass'); // self-healing: refresh replaces drift (and poison) with honest bytes
  });

  it('no-base-lockfile adoption PR derives from scratch and passes honestly', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    // rebuild a base WITHOUT a lockfile: delete it in a new root commit lineage
    sh(f.dir, 'git', ['rm', '-q', 'pnpm-lock.yaml']);
    const base = commitAll(f.dir, 'drop lockfile');
    relock(f.dir);
    const head = commitAll(f.dir, 'adopt pnpm lockfile');
    const r = await runCheck({ base, head, cwd: f.dir });
    expect(r.outcome.kind).toBe('pass');
  });

  it('lockfile deleted in head while base keeps one is a fail-closed mismatch', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    sh(f.dir, 'git', ['rm', '-q', 'pnpm-lock.yaml']);
    const head = commitAll(f.dir, 'delete lockfile');
    const r = await runCheck({ base: f.base, head, cwd: f.dir });
    expect(r.outcome.kind).toBe('mismatch');
  });
});
```

- [ ] **Step 3: Run both suites on both pnpm versions**

Run: `pnpm test:integration && PNPM_FIXTURE_VERSION=9.12.0 pnpm test:integration`
Expected: PASS ×2. Any attack-shape test that *passes the check* is a **security bug** — stop and investigate; never weaken an assertion to green.

- [ ] **Step 4: Commit.** Header: `feat: attack-shape and drift suites`

### Task A16: README, dogfood hardening, PR A

`Model: opus`

**Files:**
- Create: `README.md`
- Modify: `.github/workflows/ci.yml` (drop the dogfood step's scaffolding-tolerance `|| [ "$?" != "1" ]` — run `node dist/cli.js check --base "origin/${{ github.base_ref }}" --head HEAD --json` plain)

**Interfaces:** none new.

- [ ] **Step 1: Write `README.md`** — sections: title + tagline (`lockfile-assay — prove your lockfile is untampered`); the one-paragraph problem (unreviewed write channel, from spec §1); what a pass proves (spec §2 blockquote); quickstart (`.lockfile-assay.json` `{"mode": "warn"}` → CI step `npx lockfile-assay check --base "$MERGE_BASE" --head HEAD`); the verdict table from spec §5; the refresh recipe; a pointer to `docs/spec.md` for everything else; MIT footer. Keep it under 120 lines; the spec is the reference, the README is the pitch.

- [ ] **Step 2: Verify everything** — `pnpm lint && pnpm typecheck && pnpm build && pnpm test` → all green.

- [ ] **Step 3: Commit** (`docs: readme and dogfood hardening`), then **open PR A** via the `git-pull-request` skill: title `feat: core check — byte-exact lockfile derivation gate`, body noting it is PR A of the three-PR v1 stack (B: local forms, C: memo) and that prep-refactor PR 1 was skipped (greenfield).

---

# PR B — Local forms

Branch: `jsalvata/local-forms` (off `jsalvata/assay-core`; rebase onto `main` once A merges).

### Task B1: Index-tree and remote-default plumbing

`Model: opus`

**Files:**
- Modify: `src/git.ts` (append functions)
- Test: `test/unit/git-local.test.ts`

**Interfaces:**
- Produces:

```ts
export function writeIndexTree(cwd?: string): string;        // CannotEvaluate on unmerged index (verified: git exits 128 'error building trees')
export function diffNamesIndex(cwd?: string): string[];      // HEAD → index (staged increment)
export function remoteDefaultBranch(cwd?: string): string | null; // 'origin/main' via origin/HEAD, else null
```

- [ ] **Step 1: Write the failing test**

`test/unit/git-local.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CannotEvaluate } from '../../src/errors.js';
import { diffNamesIndex, remoteDefaultBranch, writeIndexTree } from '../../src/git.js';
import { makeRepo, sh, writeFiles } from '../helpers/scratch-repo.js';

describe('local-form plumbing', () => {
  it('writeIndexTree captures staged content and rejects unmerged indexes', () => {
    const dir = makeRepo({ 'a.txt': 'a' });
    writeFiles(dir, { 'b.txt': 'b' });
    sh(dir, 'git', ['add', 'b.txt']);
    expect(writeIndexTree(dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(diffNamesIndex(dir)).toEqual(['b.txt']);

    // conflicted merge → unmerged index → CannotEvaluate
    sh(dir, 'git', ['stash', '-u']);
    sh(dir, 'git', ['switch', '-qc', 'side']);
    writeFiles(dir, { 'a.txt': 'side' });
    sh(dir, 'git', ['commit', '-qam', 'side']);
    sh(dir, 'git', ['switch', '-q', 'main']);
    writeFiles(dir, { 'a.txt': 'main' });
    sh(dir, 'git', ['commit', '-qam', 'main']);
    try {
      sh(dir, 'git', ['merge', 'side']);
    } catch {
      /* conflict expected */
    }
    expect(() => writeIndexTree(dir)).toThrow(CannotEvaluate);
  });

  it('remoteDefaultBranch is null without a remote', () => {
    const dir = makeRepo({ 'a.txt': 'a' });
    expect(remoteDefaultBranch(dir)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** (append to `src/git.ts`)

```ts
import { CannotEvaluate } from './errors.js'; // merge into the existing errors import

export function writeIndexTree(cwd?: string): string {
  const r = git(['write-tree'], { cwd });
  if (r.status !== 0) {
    throw new CannotEvaluate(`cannot snapshot the index (unmerged entries?): ${r.stderr.toString().trim()}`);
  }
  return r.stdout.toString().trim();
}

export function diffNamesIndex(cwd?: string): string[] {
  const r = git(['diff', '--name-only', '-z', '--cached'], { cwd });
  if (r.status !== 0) throw new CannotEvaluate('cannot diff the index');
  return r.stdout.toString().split('\0').filter(Boolean);
}

export function remoteDefaultBranch(cwd?: string): string | null {
  const r = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd });
  if (r.status === 0) return r.stdout.toString().trim().replace('refs/remotes/', '');
  const probe = git(['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd });
  return probe.status === 0 ? 'origin/main' : null;
}
```

Note: `writeIndexTree` output is a **tree** sha; `runCheck` revParses `^{commit}`. Task B2 threads trees through by extending `runCheck`'s ref handling — see its Interfaces block.

- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit.** Header: `feat: index and remote plumbing for hooks`

### Task B2: `check --staged`

`Model: fable`

**Files:**
- Modify: `src/check.ts`, `src/cli.ts`, `src/git.ts` (revParse gains tree support)
- Test: `test/integration/staged.test.ts`

**Interfaces:**
- `revParse(ref, cwd, { allowTree?: boolean })` — with `allowTree`, verifies `^{tree}` instead of `^{commit}` (staging reads files via `catFile(tree, path)`, which works identically for tree-ish refs).
- Produces:

```ts
export async function runStagedCheck(opts: { cwd?: string; memo?: MemoHook | null }): Promise<CheckResult>;
```

Flow (spec §8): head = `writeIndexTree()`; base = `mergeBase(remoteDefaultBranch(), 'HEAD')`; **trigger = staged increment** `diffNamesIndex()`; everything else identical to `runCheck` (mode from base, staging reads the same paths from the index tree). Degrades: no remote default / no merge-base / `CannotEvaluate` from unmerged index → outcome `cannot-evaluate`, exit 0. CLI: `check --staged [--json]` calls this; `CannotEvaluate` thrown anywhere inside the staged form is *caught* and mapped to the outcome (not the process-level handler), so `--json` still emits a report.

- [ ] **Step 1: Write the failing test**

`test/integration/staged.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runStagedCheck } from '../../src/check.js';
import { makeFixtureRepo, relock } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { sh, writeFiles } from '../helpers/scratch-repo.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
});
afterAll(() => registry.stop());

/** point origin at a clone of itself so origin/HEAD exists */
function addSelfOrigin(dir: string): void {
  sh(dir, 'git', ['clone', '-q', '--bare', '.', join(dir, '.self.git')]);
  sh(dir, 'git', ['remote', 'add', 'origin', join(dir, '.self.git')]);
  sh(dir, 'git', ['fetch', '-q', 'origin']);
  sh(dir, 'git', ['remote', 'set-head', 'origin', '-a']);
}

describe('check --staged', () => {
  it('vacuous on source-only staging; catches a staged tampered lockfile', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    addSelfOrigin(f.dir);

    writeFiles(f.dir, { 'src.ts': 'x' });
    sh(f.dir, 'git', ['add', 'src.ts']);
    expect((await runStagedCheck({ cwd: f.dir })).outcome.kind).toBe('vacuous-pass');

    const lock = readFileSync(join(f.dir, 'pnpm-lock.yaml'), 'utf8');
    writeFiles(f.dir, { 'pnpm-lock.yaml': lock.replaceAll('1.0.0', '1.0.0') + '# tampered\n' });
    sh(f.dir, 'git', ['add', 'pnpm-lock.yaml']);
    const r = await runStagedCheck({ cwd: f.dir });
    expect(r.outcome.kind).toBe('mismatch');
    expect(r.exit).toBe(1);
  });

  it('degrades to cannot-evaluate without a remote default branch', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    writeFiles(f.dir, { 'pnpm-lock.yaml': '# junk\n' });
    sh(f.dir, 'git', ['add', 'pnpm-lock.yaml']);
    const r = await runStagedCheck({ cwd: f.dir });
    expect(r.outcome.kind).toBe('cannot-evaluate');
    expect(r.exit).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `src/git.ts`, extend `revParse`:

```ts
export function revParse(ref: string, cwd?: string, opts: { allowTree?: boolean } = {}): string {
  const suffix = opts.allowTree ? '^{tree}' : '^{commit}';
  const r = git(['rev-parse', '--verify', `${ref}${suffix}`], { cwd });
  if (r.status !== 0) throw new UsageError(`unresolvable ref: ${ref}`);
  return r.stdout.toString().trim();
}
```

In `src/check.ts`: extract the shared tail of `runCheck` into a private `evaluate(base, headTree, changed, cwd, memo)` (config → staging → preflight → pin → memo → materialize → skew → derive → verdict → report) where `headTree` is any tree-ish; `runCheck` calls it with a commit and `diffNames`, and add:

```ts
export async function runStagedCheck(opts: { cwd?: string; memo?: MemoHook | null } = {}): Promise<CheckResult> {
  const cwd = opts.cwd;
  try {
    const remoteDefault = remoteDefaultBranch(cwd);
    if (!remoteDefault) return cannotEvaluate('no origin default branch — cannot derive the PR base; the required check still gates the merge', cwd);
    const base = mergeBase(remoteDefault, 'HEAD', cwd);
    if (!base) return cannotEvaluate(`no merge-base with ${remoteDefault}`, cwd);
    const staged = diffNamesIndex(cwd);
    const declared = declaredPatchPaths(catFile('HEAD', 'pnpm-workspace.yaml', cwd), catFile('HEAD', 'package.json', cwd));
    if (!isTriggered(staged, declared)) return result({ kind: 'vacuous-pass' }, 'off', base, 'INDEX');
    const headTree = writeIndexTree(cwd);
    return await evaluate({ base, headTree, cwd, memo: opts.memo ?? null, headLabel: 'INDEX' });
  } catch (e) {
    if (e instanceof CannotEvaluate) return cannotEvaluate(e.message, cwd);
    throw e;
  }
}

function cannotEvaluate(reason: string, _cwd?: string): CheckResult {
  const outcome = { kind: 'cannot-evaluate', reason } as const;
  return { outcome, mode: 'off', exit: 0, report: { outcome, mode: 'off', base: null, head: 'INDEX' } };
}
```

(Adjust `evaluate`'s signature during the refactor so both callers compile; `collectStagedFiles`/`catFile` already accept tree-ish refs. A registry-unreachable derive failure inside the staged form must ALSO map to `cannot-evaluate` — wrap the `derive` call: on `!ok`, `runCheck` throws (CI fails red, exit 3) while the staged/prepush forms return `cannot-evaluate` with the stderr tail as the reason. Thread a `failClosed: boolean` through `evaluate` to pick the behavior.)

In `src/cli.ts`, replace the `--staged` stub:

```ts
if (o.staged) {
  const r = await runStagedCheck({});
  console.log(o.json ? renderJson(r.report) : renderHuman(r.report));
  process.exitCode = r.exit;
  return;
}
```

- [ ] **Step 4: Run to verify pass** — `pnpm vitest run test/integration/staged.test.ts`, then full `pnpm test`.
- [ ] **Step 5: Commit.** Header: `feat: commit-time check --staged`

### Task B3: `prepush`, hook docs, PR B

`Model: fable`

**Files:**
- Create: `src/prepush.ts`
- Modify: `src/cli.ts`, `README.md` (hook wiring section from spec §8)
- Test: `test/unit/prepush-parse.test.ts`, `test/integration/prepush.test.ts`

**Interfaces:**
- Produces:

```ts
export type PushedTip = { localRef: string; localSha: string };
export function parsePushLines(stdin: string): PushedTip[];  // githooks(5) lines; zero-sha deletions skipped
export async function runPrepush(opts: {
  stdin: string; baseOverride?: string; cwd?: string; memo?: MemoHook | null;
}): Promise<{ tips: CheckResult[]; exit: 0 | 1 }>;
```

Per tip (spec §8): base = `--base` override, else `mergeBase(remoteDefaultBranch(), tip)`; fast path — `diffNames` untriggered → vacuous, no config read; otherwise full `runCheck`. No stdin lines (standalone invocation) → single tip `HEAD`. Exit = max over tips. `--json` output: `{ schemaVersion: 1, tips: [<per-tip report json>] }`.

- [ ] **Step 1: Write the failing parse test**

`test/unit/prepush-parse.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parsePushLines } from '../../src/prepush.js';

const Z = '0'.repeat(40);
describe('parsePushLines', () => {
  it('parses tips and skips deletions', () => {
    const stdin = [
      `refs/heads/f abc123${'0'.repeat(34)} refs/heads/f def456${'0'.repeat(34)}`,
      `refs/heads/gone ${Z} refs/heads/gone abc123${'0'.repeat(34)}`,
    ].join('\n');
    expect(parsePushLines(stdin)).toEqual([{ localRef: 'refs/heads/f', localSha: `abc123${'0'.repeat(34)}` }]);
  });
  it('empty stdin means standalone: HEAD', () => {
    expect(parsePushLines('')).toEqual([{ localRef: 'HEAD', localSha: 'HEAD' }]);
  });
});
```

- [ ] **Step 2: Run to verify failure; implement**

`src/prepush.ts`:

```ts
import type { CheckResult, MemoHook } from './check.js';
import { runCheck } from './check.js';
import { CannotEvaluate } from './errors.js';
import { mergeBase, remoteDefaultBranch } from './git.js';

export type PushedTip = { localRef: string; localSha: string };
const ZERO = /^0{40,64}$/;

export function parsePushLines(stdin: string): PushedTip[] {
  const lines = stdin.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [{ localRef: 'HEAD', localSha: 'HEAD' }];
  const tips: PushedTip[] = [];
  for (const line of lines) {
    const [localRef, localSha] = line.split(/\s+/);
    if (!localRef || !localSha || ZERO.test(localSha)) continue; // deletion pushes nothing
    tips.push({ localRef, localSha });
  }
  return tips;
}

export async function runPrepush(opts: {
  stdin: string;
  baseOverride?: string;
  cwd?: string;
  memo?: MemoHook | null;
}): Promise<{ tips: CheckResult[]; exit: 0 | 1 }> {
  const results: CheckResult[] = [];
  for (const tip of parsePushLines(opts.stdin)) {
    try {
      const base = opts.baseOverride ?? deriveBase(tip.localSha, opts.cwd);
      results.push(await runCheck({ base, head: tip.localSha, cwd: opts.cwd, memo: opts.memo }));
    } catch (e) {
      if (e instanceof CannotEvaluate) {
        const outcome = { kind: 'cannot-evaluate', reason: e.message } as const;
        results.push({ outcome, mode: 'off', exit: 0, report: { outcome, mode: 'off', base: null, head: tip.localSha } });
      } else throw e;
    }
  }
  return { tips: results, exit: results.some((r) => r.exit === 1) ? 1 : 0 };
}

function deriveBase(tip: string, cwd?: string): string {
  const remoteDefault = remoteDefaultBranch(cwd);
  if (!remoteDefault) throw new CannotEvaluate('no origin default branch — the required check still gates the merge');
  const base = mergeBase(remoteDefault, tip, cwd);
  if (!base) throw new CannotEvaluate(`no merge-base between ${tip} and ${remoteDefault}`);
  return base;
}
```

CLI wiring in `src/cli.ts` (new command):

```ts
program
  .command('prepush')
  .description('git pre-push hook form: check every pushed tip against its PR base')
  .option('--base <ref>', 'override the per-tip merge-base')
  .option('--json', 'emit the machine report')
  .action(async (o: { base?: string; json?: boolean }) => {
    const stdin = process.stdin.isTTY ? '' : await new Promise<string>((resolve) => {
      let data = '';
      process.stdin.on('data', (c) => (data += c));
      process.stdin.on('end', () => resolve(data));
    });
    const { tips, exit } = await runPrepush({ stdin, baseOverride: o.base });
    if (o.json) {
      console.log(JSON.stringify({ schemaVersion: 1, tips: tips.map((t) => JSON.parse(renderJson(t.report))) }, null, 2));
    } else {
      for (const t of tips) console.log(renderHuman(t.report));
    }
    process.exitCode = exit;
  });
```

- [ ] **Step 3: Integration test** (first move `addSelfOrigin` from B2's test into `test/helpers/fixture.ts` and export it)

`test/integration/prepush.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPrepush } from '../../src/prepush.js';
import { addSelfOrigin, makeFixtureRepo } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { commitAll, writeFiles } from '../helpers/scratch-repo.js';

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
});
afterAll(() => registry.stop());

const ZERO = '0'.repeat(40);

describe('prepush', () => {
  it('a tampered tip aborts the push; a source-only tip is vacuous', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    addSelfOrigin(f.dir);

    writeFiles(f.dir, { 'pnpm-lock.yaml': `${readFileSync(join(f.dir, 'pnpm-lock.yaml'), 'utf8')}# tampered\n` });
    const tampered = commitAll(f.dir, 'tamper');
    const bad = await runPrepush({ stdin: `refs/heads/x ${tampered} refs/heads/x ${ZERO}`, cwd: f.dir });
    expect(bad.exit).toBe(1);
    expect(bad.tips).toHaveLength(1);
    expect(bad.tips[0]?.outcome.kind).toBe('mismatch');

    writeFiles(f.dir, { 'src.ts': 'x' });
    const clean = commitAll(f.dir, 'source only');
    const ok = await runPrepush({ stdin: `refs/heads/x ${clean} refs/heads/x ${ZERO}`, cwd: f.dir });
    expect(ok.exit).toBe(0);
  });

  it('deletion-only stdin evaluates nothing', async () => {
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    addSelfOrigin(f.dir);
    const r = await runPrepush({ stdin: `refs/heads/gone ${ZERO} refs/heads/gone abc`, cwd: f.dir });
    expect(r.tips).toHaveLength(0);
    expect(r.exit).toBe(0);
  });
});
```

Run: `pnpm vitest run test/integration/prepush.test.ts` → PASS.

- [ ] **Step 4: README hook section** — add spec §8's two husky snippets verbatim (`.husky/pre-commit` → `pnpm exec lockfile-assay check --staged`, `.husky/pre-push` → `pnpm exec lockfile-assay prepush`) plus the `--no-verify` escape-hatch sentence.

- [ ] **Step 5: Full verify + commit + PR** — `pnpm test` green ×both pnpm versions; commit (`feat: prepush hook form`); open PR B via `git-pull-request` (stacked on PR A, body names the stack).

---

# PR C — Derivation memo

Branch: `jsalvata/memo` (off `jsalvata/local-forms`; rebase as the stack merges).

### Task C1: Validation spike — App + ruleset + Contents API (spec §8, §12 Q6)

`Model: opus`

**Files:**
- Create: `docs/spike-memo-store.md` (findings record — committed, since it feeds docs in C6)

This is investigation, not TDD. It gates C3/C6: if any step below fails, STOP and report to Jordi before writing store code.

- [ ] **Step 1: Create a scratch repo** `gh repo create jsalvata/assay-memo-spike --private -y`.
- [ ] **Step 2: Register a GitHub App** (manual, walk Jordi through it or use his session): name `lockfile-assay-memo-spike`, permissions **Contents: Read and write** only, no webhook. Install it on the scratch repo. Record: App ID, installation ID, private key location.
- [ ] **Step 3: Create the orphan branch**: in a clone, `git switch --orphan lockfile-assay/memo && git commit --allow-empty -m "docs: memo branch root" && git push origin lockfile-assay/memo`.
- [ ] **Step 4: Create a ruleset** (repo → Settings → Rules): target branch `lockfile-assay/memo`, restrict updates + creations + deletions, bypass list = ONLY the spike App. Verify: `git push` to that branch with Jordi's own credentials → expect **rejection**; a `PUT /repos/.../contents/...` with a user token → expect **409/403-class rejection**.
- [ ] **Step 5: Mint an installation token in a workflow** using `actions/create-github-app-token@v1` with the App ID + private key as repo secrets; from that workflow, `PUT /repos/jsalvata/assay-memo-spike/contents/memo/1/ab/test.json?branch=...` → expect **201**; `GET` it back raw → expect the JSON; `PUT` the same path again without `sha` → record the exact status (expect **409 or 422** — this pins the retry-on-conflict contract for C3).
- [ ] **Step 6: Read path without credentials**: `gh api` (user token) `GET /repos/.../contents/memo/1/ab/test.json?ref=lockfile-assay/memo` → 200; unauthenticated `fetch` on a **private** repo → 404 (confirms local silent-skip is the right degrade).
- [ ] **Step 7: Write `docs/spike-memo-store.md`** — record each expected/observed pair, exact status codes, the token-minting workflow snippet, and any surprises. Commit (`docs: memo store spike findings`). Delete the scratch repo (`gh repo delete jsalvata/assay-memo-spike --yes`) but keep the App for real use if it worked (rename later) or note that a fresh App per consumer repo is the model.

### Task C2: Memo key — EPOCH + inputsHash

`Model: fable`

**Files:**
- Create: `src/memo/key.ts`
- Test: `test/unit/memo-key.test.ts`

**Interfaces:**
- Consumes: `StagedFile`, `INVOCATION`.
- Produces:

```ts
export const EPOCH = 1;   // bump ONLY for wrongly-passed holes — release checklist item (spec §8)
export function inputsHash(files: StagedFile[], invocation: string): string; // 64-char sha256 hex
```

Canonical encoding (order-independent input, order-fixed digest): sort by path, then for each file feed `utf8(path) ‖ 0x00 ‖ uint64BE(byteLength) ‖ bytes ‖ 0x00`, finally `utf8(invocation)`. The length prefix prevents boundary-shifting collisions between adjacent files; the sort makes hashing independent of collection order. **Soundness note (do not weaken):** every byte that can influence derivation must be inside `files` — that is guaranteed by `collectStagedFiles` being the single source for both staging and hashing.

- [ ] **Step 1: Write the failing test**

`test/unit/memo-key.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { INVOCATION } from '../../src/derive.js';
import { EPOCH, inputsHash } from '../../src/memo/key.js';

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
    expect(inputsHash([f('a', 'xy'), f('b', 'z')], INVOCATION)).not.toBe(inputsHash([f('a', 'x'), f('b', 'yz')], INVOCATION));
  });
  it('EPOCH is 1', () => expect(EPOCH).toBe(1));
});
```

- [ ] **Step 2: Run to verify failure; implement**

`src/memo/key.ts`:

```ts
import { createHash } from 'node:crypto';
import type { StagedFile } from '../staging.js';

export const EPOCH = 1;

export function inputsHash(files: StagedFile[], invocation: string): string {
  const h = createHash('sha256');
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    h.update(f.path, 'utf8');
    h.update(Buffer.from([0]));
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(f.bytes.length));
    h.update(len);
    h.update(f.bytes);
    h.update(Buffer.from([0]));
  }
  h.update(invocation, 'utf8');
  return h.digest('hex');
}
```

- [ ] **Step 3: Run to verify pass; commit.** Header: `feat: memo key with source-constant epoch`

### Task C3: Memo store — Contents API backend

`Model: fable`

**Files:**
- Create: `src/memo/store.ts`
- Test: `test/unit/memo-store.test.ts` (against a local fake Contents API)

**Interfaces:**
- Produces:

```ts
export type MemoRecord = { derivedLockfileSha256: string; toolVersion: string; pnpmVersion: string; derivedAt: string };
export interface MemoStore {
  get(epoch: number, hash: string): Promise<MemoRecord | null>;
  put(epoch: number, hash: string, record: MemoRecord): Promise<void>;
}
export function contentsApiStore(opts: {
  repo: string;          // 'owner/name'
  token: string;
  branch?: string;       // default 'lockfile-assay/memo'
  apiBase?: string;      // default 'https://api.github.com' — tests point this at the fake
}): MemoStore;
```

Layout (spec §8): `memo/<epoch>/<hash[0:2]>/<hash>.json`. `get`: `GET /repos/{repo}/contents/{path}?ref={branch}` with `Accept: application/vnd.github.raw+json`; 404 → null; other non-200 → **null** (reads must never fail the check). `put`: `PUT` with `{message, content: base64, branch}`; on 409/422 → one re-`GET` (another writer won the race — fine, records for the same key are equivalent) and swallow; other errors → **swallow with a stderr warning** (memo writes are best-effort; the verdict already happened). C1's observed conflict status refines the retry condition.

- [ ] **Step 1: Write the failing test** — spin an in-process `node:http` server implementing just enough: `GET` returns 404 then the stored blob; `PUT` stores; second `PUT` same path returns 422; a `GET` returning 500 must yield `null`, not a throw. Assert paths carry `/memo/1/<hh>/<hash>.json` fanout and the `ref` query. (~60 lines; standard `createServer` + a `Map`.)

- [ ] **Step 2: Implement**

`src/memo/store.ts`:

```ts
export type MemoRecord = { derivedLockfileSha256: string; toolVersion: string; pnpmVersion: string; derivedAt: string };

export interface MemoStore {
  get(epoch: number, hash: string): Promise<MemoRecord | null>;
  put(epoch: number, hash: string, record: MemoRecord): Promise<void>;
}

export function contentsApiStore(opts: { repo: string; token: string; branch?: string; apiBase?: string }): MemoStore {
  const branch = opts.branch ?? 'lockfile-assay/memo';
  const apiBase = opts.apiBase ?? 'https://api.github.com';
  const headers = {
    authorization: `Bearer ${opts.token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'lockfile-assay',
  };
  const pathFor = (epoch: number, hash: string) => `memo/${epoch}/${hash.slice(0, 2)}/${hash}.json`;
  const urlFor = (epoch: number, hash: string) =>
    `${apiBase}/repos/${opts.repo}/contents/${pathFor(epoch, hash)}?ref=${encodeURIComponent(branch)}`;

  return {
    async get(epoch, hash) {
      try {
        const res = await fetch(urlFor(epoch, hash), { headers: { ...headers, accept: 'application/vnd.github.raw+json' } });
        if (!res.ok) return null; // 404 = miss; anything else must not fail the check
        return (await res.json()) as MemoRecord;
      } catch {
        return null;
      }
    },
    async put(epoch, hash, record) {
      try {
        const body = JSON.stringify({
          message: `memo: ${hash.slice(0, 12)} (epoch ${epoch})`,
          content: Buffer.from(JSON.stringify(record, null, 2)).toString('base64'),
          branch,
        });
        const res = await fetch(`${apiBase}/repos/${opts.repo}/contents/${pathFor(epoch, hash)}`, {
          method: 'PUT',
          headers: { ...headers, 'content-type': 'application/json' },
          body,
        });
        if (res.status === 409 || res.status === 422) return; // lost the race: an equivalent record already exists
        if (!res.ok) console.error(`lockfile-assay: memo write failed (${res.status}) — continuing without memo`);
      } catch (e) {
        console.error(`lockfile-assay: memo write failed (${e instanceof Error ? e.message : e}) — continuing`);
      }
    },
  };
}
```

- [ ] **Step 3: Run to verify pass; commit.** Header: `feat: contents-api memo store`

### Task C4: Token discovery + memo client

`Model: opus`

**Files:**
- Create: `src/memo/auth.ts`, `src/memo/client.ts`
- Test: `test/unit/memo-client.test.ts`

**Interfaces:**
- Produces:

```ts
// auth.ts — chain per spec §8: explicit env → GITHUB_TOKEN → ambient gh → null
export function discoverToken(env?: NodeJS.ProcessEnv): string | null; // LOCKFILE_ASSAY_TOKEN, GITHUB_TOKEN, `gh auth token`
export function originRepo(cwd?: string): string | null;               // 'owner/name' from origin URL (ssh or https), else null
// client.ts — adapts a MemoStore to check.ts's MemoHook
export function makeMemoClient(store: MemoStore, opts: { write: boolean; pnpmVersion?: string }): MemoHook;
```

`consult(files, committed)`: `committed === null` → null; `get(EPOCH, inputsHash(files, INVOCATION))`; hit **iff** `record.derivedLockfileSha256 === sha256(committed)` → `{ hit: true, derivedAt, toolVersion }`; else null (stale entries fall through to a live resolve — spec §8 step 3). `record(files, derived)`: no-op when `write: false` (local forms never write); else `put` with sha256(derived), tool version, pnpm version, `new Date().toISOString()`.

- [ ] **Step 1: Write the failing test** — in-memory `MemoStore` stub (a `Map`); cover: hit on equal hashes with provenance; stale record (different lockfile sha) → null → after live pass `record` overwrites; `write: false` never calls `put`; mismatch flows never reach `record` (assert by API shape: client has no "record mismatch" path); `discoverToken` prefers `LOCKFILE_ASSAY_TOKEN` over `GITHUB_TOKEN` and returns null when neither exists and `gh` is absent (point `PATH` at an empty dir); `originRepo` parses `git@github.com:owner/name.git` and `https://github.com/owner/name.git`.

- [ ] **Step 2: Implement**

`src/memo/auth.ts`:

```ts
import { spawnSync } from 'node:child_process';
import { git } from '../git.js';

export function discoverToken(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.LOCKFILE_ASSAY_TOKEN) return env.LOCKFILE_ASSAY_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  const token = r.status === 0 ? r.stdout.trim() : '';
  return token || null;
}

export function originRepo(cwd?: string): string | null {
  const r = git(['remote', 'get-url', 'origin'], { cwd });
  if (r.status !== 0) return null;
  const url = r.stdout.toString().trim();
  const m = /github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/.exec(url);
  return m?.[1] ?? null;
}
```

`src/memo/client.ts`:

```ts
import { createHash } from 'node:crypto';
import type { MemoHook } from '../check.js';
import { INVOCATION } from '../derive.js';
import { EPOCH, inputsHash } from './key.js';
import type { MemoStore } from './store.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const TOOL_VERSION = process.env.npm_package_version ?? 'unknown';

export function makeMemoClient(store: MemoStore, opts: { write: boolean; pnpmVersion?: string }): MemoHook {
  return {
    async consult(files, committed) {
      if (committed === null) return null;
      const record = await store.get(EPOCH, inputsHash(files, INVOCATION));
      if (!record || record.derivedLockfileSha256 !== sha256(committed)) return null;
      return { hit: true, derivedAt: record.derivedAt, toolVersion: record.toolVersion };
    },
    async record(files, derived) {
      if (!opts.write) return;
      await store.put(EPOCH, inputsHash(files, INVOCATION), {
        derivedLockfileSha256: sha256(derived),
        toolVersion: TOOL_VERSION,
        pnpmVersion: opts.pnpmVersion ?? 'unknown',
        derivedAt: new Date().toISOString(),
      });
    },
  };
}
```

- [ ] **Step 3: Run to verify pass; commit.** Header: `feat: memo client and token discovery`

### Task C5: Wire the memo into the CLI + integration proof

`Model: fable`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/integration/memo.test.ts`

**Interfaces:** CLI assembly only — `check` gains `--memo-write` (set by the anchored CI workflow; local forms never pass it): memo is active when a token AND origin repo are discoverable; `check --base/--head` passes `write: !!o.memoWrite`, `--staged`/`prepush` hard-code `write: false`. Absent token/repo → `memo: null`, silent (spec §8).

- [ ] **Step 1: Write the integration test** — `test/integration/memo.test.ts` with an in-memory `MemoStore` injected through `runCheck({ memo: makeMemoClient(...) })`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check.js';
import { makeMemoClient } from '../../src/memo/client.js';
import type { MemoRecord, MemoStore } from '../../src/memo/store.js';
import { makeFixtureRepo, relock } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { commitAll, sh, writeFiles } from '../helpers/scratch-repo.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function memStore(): MemoStore & { size(): number } {
  const m = new Map<string, MemoRecord>();
  return {
    async get(e, h) { return m.get(`${e}/${h}`) ?? null; },
    async put(e, h, r) { m.set(`${e}/${h}`, r); },
    size: () => m.size,
  };
}

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
});
afterAll(() => registry.stop());

describe('derivation memo (spec §8)', () => {
  it('records on a live pass, then serves the hit with the REGISTRY DEAD', async () => {
    const store = memStore();
    const memo = makeMemoClient(store, { write: true });
    const f = await makeFixtureRepo(registry, {});
    const pkg = JSON.parse(readFileSync(join(f.dir, 'package.json'), 'utf8'));
    pkg.dependencies = { alpha: '^1.0.0' };
    writeFiles(f.dir, { 'package.json': JSON.stringify(pkg, null, 2) });
    relock(f.dir);
    const head = commitAll(f.dir, 'bump');

    const live = await runCheck({ base: f.base, head, cwd: f.dir, memo });
    expect(live.outcome.kind).toBe('pass');
    expect(store.size()).toBe(1);

    await registry.stop(); // the registry is GONE — only a memo hit can pass now
    const remembered = await runCheck({ base: f.base, head, cwd: f.dir, memo });
    expect(remembered.outcome.kind).toBe('pass');
    expect(remembered.outcome.kind === 'pass' && remembered.outcome.memo?.hit).toBe(true);
    registry = await startRegistry(); // restore for the suite's afterAll + later tests
    await registry.publish({ name: 'alpha', version: '1.0.0' });
  });

  it('a mismatch is never memoised; a tampered lockfile cannot hit a stale record', async () => {
    const store = memStore();
    const memo = makeMemoClient(store, { write: true });
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    writeFiles(f.dir, { 'pnpm-lock.yaml': `${readFileSync(join(f.dir, 'pnpm-lock.yaml'), 'utf8')}# tampered\n` });
    const tampered = commitAll(f.dir, 'tamper');
    const r = await runCheck({ base: f.base, head: tampered, cwd: f.dir, memo });
    expect(r.outcome.kind).toBe('mismatch');
    expect(store.size()).toBe(0); // never memoised (spec §8 step 4)
  });

  it('write:false clients never write', async () => {
    const store = memStore();
    const memo = makeMemoClient(store, { write: false });
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    writeFiles(f.dir, { 'src.ts': 'x' });
    sh(f.dir, 'git', ['add', '-A']);
    const head = commitAll(f.dir, 'src only + relock noop');
    await runCheck({ base: f.base, head, cwd: f.dir, memo });
    expect(store.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Wire the CLI** — in `src/cli.ts`'s `check` action, before `runCheck`:

```ts
import { discoverToken, originRepo } from './memo/auth.js';
import { makeMemoClient } from './memo/client.js';
import { contentsApiStore } from './memo/store.js';

function buildMemo(write: boolean): MemoHook | null {
  const token = discoverToken();
  const repo = originRepo();
  if (!token || !repo) return null; // silent skip — spec §8
  return makeMemoClient(contentsApiStore({ repo, token }), { write });
}
```

`check`: `memo: buildMemo(!!o.memoWrite)` with new option `--memo-write`; `--staged` and `prepush` paths: `memo: buildMemo(false)`.

- [ ] **Step 3: Run** — `pnpm test` green on both pnpm versions; commit. Header: `feat: memo consult and write in the cli`

### Task C6: Consumer docs, action, release checklist, PR C

`Model: opus`

**Files:**
- Create: `docs/setup-github-app.md`, `docs/RELEASING.md`, `examples/assay.yml`, `action.yml`
- Modify: `README.md` (memo section), `.github/workflows/ci.yml` (dogfood step gains `--memo-write` once the App exists on this repo — optional follow-up, note it)

- [ ] **Step 1: `docs/setup-github-app.md`** — from C1's spike findings, the consumer walkthrough: create App (Contents RW) → install on repo → secrets `ASSAY_APP_ID`/`ASSAY_APP_PRIVATE_KEY` → orphan branch `lockfile-assay/memo` → ruleset restricting the branch to the App → wire `examples/assay.yml`. Include the observed failure modes (user push rejected, race status) as verification steps.

- [ ] **Step 2: `examples/assay.yml`** — the reference required-check workflow:

```yaml
name: lockfile-assay
on:
  pull_request:
jobs:
  assay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: actions/create-github-app-token@v1
        id: memo-token
        with:
          app-id: ${{ secrets.ASSAY_APP_ID }}
          private-key: ${{ secrets.ASSAY_APP_PRIVATE_KEY }}
      - name: lockfile-assay
        env:
          LOCKFILE_ASSAY_TOKEN: ${{ steps.memo-token.outputs.token }}
        run: |
          npx --yes lockfile-assay check \
            --base "origin/${{ github.base_ref }}" --head HEAD \
            --memo-write --json
```

- [ ] **Step 3: `action.yml`** — thin composite mirroring the example (inputs: `base`, `head`, `memo-token`; runs the same npx invocation). Smoke-check syntax with `actions/runner` conventions only (no test infra for composites — keep it 30 lines).

- [ ] **Step 4: `docs/RELEASING.md`** — semantic-release does versions/changelog/publish on main; the **one manual gate**: *"If this release fixes a case where earlier releases could WRONGLY PASS, bump `EPOCH` in `src/memo/key.ts` in the same PR. When in doubt, bump — cost is one live re-derivation round across open PRs (spec §8)."*

- [ ] **Step 5: README memo section** — what the memo buys (no re-rolls), what it never does (short-circuit to fail), setup pointer.

- [ ] **Step 6: Full verify, commit (`docs: memo setup and release checklist`), open PR C** via `git-pull-request` (stacked; body includes the spike findings summary and the §12 Q6 resolution).

### Task C7: Cleanup verdict (PR 3 of the refactor bookend — conditional)

`Model: opus`

- [ ] **Step 1: Audit the residue** with the feature complete. Known candidates to evaluate — not a to-do list, an audit list:
  - `addSelfOrigin` and other helpers grown inside test files during B2/B3 — consolidate into `test/helpers/fixture.ts` if duplicated.
  - `evaluate()` extraction in `src/check.ts` (B2) — check no dead parameters or leftover single-caller indirection.
  - Naming drift between `MemoHook`/`MemoClient`/`MemoStore` — one glossary pass.
- [ ] **Step 2: Render the verdict.** If ≥ 2 real items: open `jsalvata/cleanup-v1` as a **pure refactor** PR (tests green before and after, zero behavior change, no new test logic). If not: record "PR 3 skipped: no residue worth a PR" in PR C's description. Either way, note any insight that **would recur** for the npm backend as candidate prep in a new `docs/superpowers/plans/` stub line — that feedback is the point of the bookend.

---

## Execution notes

- **Order:** A1→A16 strictly (each task's Interfaces block assumes its predecessors), then B, then C. C1 (spike) can run any time after PR A merges — it needs no code.
- **Every task:** run `pnpm lint && pnpm typecheck` before its commit (the pre-commit hook enforces this anyway).
- **Both pnpm versions** (`PNPM_FIXTURE_VERSION=9.12.0`) before opening each PR.
- **Never weaken a failing attack-shape or empirics assertion** — those failures are findings about the spec or the tool, and Jordi wants to hear about them.
