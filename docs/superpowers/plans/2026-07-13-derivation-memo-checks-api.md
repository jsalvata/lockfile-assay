# Derivation-Memo Checks-API Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the derivation memo work — a passing derivation is recorded as a
GitHub App check run so later checks on the same PR reuse it instead of
re-resolving against the registry — under the anchored Checks-API store.

**Architecture:** A three-layer memo under `src/memo/`: a `fetch`-based
Checks-API transport (`checks-api.ts`) behind a narrow `Backend` interface; an
adapter (`store.ts`) that owns the trust boundary (compare recorded
`derivedHash` to `sha256(committed)`, validate record shape, honor `EPOCH`,
record only on pass) and the outcome→check-run mapping; and CLI wiring that
constructs it and posts one App check run per outcome (the full verdict
channel). The existing `MemoHook` seam in `check.ts` is unchanged.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), vitest, biome, commander. Runtime
deps unchanged (`commander`, `yaml`); the transport uses built-in `fetch` and
`node:crypto` only — no third-party, no `yaml`, no `report/` import.

## Global Constraints

- **Node ≥ 22**; ESM (`.js` import specifiers in TS source).
- **Trust-path discipline (spec §13):** nothing under `src/memo/` imports
  `report/` or `yaml`. The transport uses only `node:*` builtins + `fetch`.
- **Failure semantics (spec §8, load-bearing):** consult produces **pass or
  miss, never a failure**; a mismatch is **never** memoised; every read error /
  malformed record → miss; every write is best-effort and never fails the check
  (it warns instead). Records live only in **success** check runs.
- **`EPOCH`** is the integer source constant in `src/memo/key.ts` (currently
  `1`); it is part of every record and every match.
- **`INVOCATION`** (from `src/derive.ts`) is the `inputsHash` invocation string —
  the memo must hash with the exact same value.
- **Conventional Commits**, `feat:` / `fix:` / `docs:` only, header ≤ 50 chars,
  all lowercase, no ticket trailer (branch has no Linear key). Use the
  `git-commit` skill for real commits; the plan shows the intended message.
- **Green gate at every commit:** `pnpm lint && pnpm typecheck && pnpm build &&
  pnpm test:unit`, plus `pnpm test:integration` where integration tests change.

## PR Plan

Reasoning order: feature spike → prep → cleanup. Ship order: 0 → 1..N → N+1.

- **PR 0 — Prep refactor.** *Skipped: no friction to remove.* The `MemoHook`
  boundary in `check.ts` and `evaluate()` already call `consult` before the
  derive and `record` on a byte-match pass; `CheckResult.report.head` already
  carries the head SHA the verdict poster needs; the new `conclusion()` slots in
  beside the existing `exitCode()` in `outcome.ts`. `check.ts`/`evaluate()` do
  not change. The feature is purely additive into clean seams.
- **PR 1 — Memo backend + transport + adapter, fully tested, unwired**
  (`memo-checks-api-backend` off `main`): `src/memo/checks-api.ts`,
  `src/memo/store.ts`, an `appId` reader in `src/memo/auth.ts`; unit tests
  against a fake `Backend`, an integration test against a faked Checks-API HTTP
  server, and the `import-graph` guard extension. Production behaviour is
  unchanged (the CLI does not use it yet), so this PR is safe to review in
  isolation — all the trust logic and transport arrive with their tests.
- **PR 2 — Wire the memo + verdict channel into the CLI and the anchored
  contract** (`memo-checks-api-wiring` off PR 1): `--pr` on `check`; the CLI
  constructs the driver, passes it to `runCheck`, and posts the verdict after;
  `warnings` on the report + render; `action.yml`, `examples/lockfile-assay.yml`,
  `docs/setup-github-app.md` updated. This turns the machinery on.
- **PR N+1 — Cleanup refactor.** *Skipped: nothing to clean up.* The feature
  adds; it leaves no dead branches or duplication. The stale `action.yml` text
  and the "not wired in this build" `cli.ts` comment are corrected inside PR 2's
  contract/wiring changes, not as separate cleanup.

Candidate prep for next time: none discovered.

---

## PR 1 — Memo backend (unwired)

Branch: `jsalvata/memo-checks-api-backend` (this worktree — already created off
up-to-date `main`).

File structure created/modified in PR 1:

- Create `src/memo/store.ts` — `Backend` interface, `StoredRecord`, `sha256`,
  `conclusion()`, `verdictSummary()`, the `MemoDriver` adapter (consult / record
  / postVerdict), `CHECK_NAME`, `buildMemoDriver()`.
- Create `src/memo/checks-api.ts` — `MARKER`, `embedRecord()`, `parseRecord()`,
  `ChecksApiBackend implements Backend` (list PR commits, GraphQL force-push
  heads, list check runs, create check run).
- Create `src/memo/store.test.ts`, `src/memo/checks-api.test.ts`.
- Modify `src/memo/auth.ts` — add `appId(env)`; modify `src/memo/auth.test.ts`.
- Modify `src/import-graph.test.ts` — add the `memo/ ↛ report/` rule.
- Create `test/integration/memo.test.ts`.

---

### Task 1.1: `StoredRecord`, `sha256`, and the record marker (embed/parse)

**Files:**
- Create: `src/memo/store.ts` (types + `sha256` only in this task)
- Create: `src/memo/checks-api.ts` (`MARKER`, `embedRecord`, `parseRecord`)
- Test: `src/memo/checks-api.test.ts`

**Interfaces:**
- Produces: `type StoredRecord = { epoch: number; inputsHash: string;
  derivedHash: string; toolVersion: string; pnpmVersion: string; timestamp:
  string }` (in `store.ts`); `sha256(buf: Buffer): string` (in `store.ts`);
  `embedRecord(record: StoredRecord): string`, `parseRecord(summary: string |
  null | undefined): StoredRecord | null` (in `checks-api.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/memo/checks-api.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { embedRecord, parseRecord } from './checks-api.js';
import type { StoredRecord } from './store.js';

const rec: StoredRecord = {
  epoch: 1,
  inputsHash: 'a'.repeat(64),
  derivedHash: 'b'.repeat(64),
  toolVersion: '1.2.3',
  pnpmVersion: '10.34.1',
  timestamp: '2026-07-13T00:00:00.000Z',
};

describe('record marker embed/parse', () => {
  it('round-trips a record through a check-run summary', () => {
    const summary = `A human line.\n${embedRecord(rec)}`;
    expect(parseRecord(summary)).toEqual(rec);
  });

  it('returns null when the marker is absent', () => {
    expect(parseRecord('just a human summary, no marker')).toBeNull();
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord(undefined)).toBeNull();
  });

  it('returns null on a malformed / garbled record (never a false record)', () => {
    // marker present but JSON broken
    expect(parseRecord('<!--lockfile-assay-memo:v1 {not json} -->')).toBeNull();
    // marker present, JSON valid, but a required field missing/wrong type
    expect(
      parseRecord('<!--lockfile-assay-memo:v1 {"epoch":"1","inputsHash":"x"} -->'),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/memo/checks-api.test.ts`
Expected: FAIL — cannot import `embedRecord`/`parseRecord`/`StoredRecord`.

- [ ] **Step 3: Write minimal implementation**

Create `src/memo/store.ts` with the type + hash (rest of `store.ts` arrives in
later tasks):

```ts
import { createHash } from 'node:crypto';

export type StoredRecord = {
  epoch: number;
  inputsHash: string;
  derivedHash: string; // sha256 of the derived lockfile, hex
  toolVersion: string;
  pnpmVersion: string;
  timestamp: string; // ISO-8601
};

/** SHA-256 of a buffer, hex. Used to hash the committed and derived lockfiles. */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
```

Create `src/memo/checks-api.ts` (marker helpers only for now):

```ts
import type { StoredRecord } from './store.js';

export const MARKER = 'lockfile-assay-memo:v1';

/** Embed a record inside a check-run summary, behind an HTML-comment marker so
 * it is invisible in rendered markdown and unambiguous to parse. */
export function embedRecord(record: StoredRecord): string {
  return `<!--${MARKER} ${JSON.stringify(record)} -->`;
}

/** Extract a record from a check-run summary. Any deviation — no marker, broken
 * JSON, a missing/mistyped field — yields null (a miss, never a false record). */
export function parseRecord(summary: string | null | undefined): StoredRecord | null {
  if (!summary) return null;
  const m = new RegExp(`<!--${MARKER} (\\{.*\\}) -->`).exec(summary);
  if (!m) return null;
  let o: unknown;
  try {
    o = JSON.parse(m[1] as string);
  } catch {
    return null;
  }
  const r = o as Record<string, unknown>;
  if (
    typeof r.epoch === 'number' &&
    typeof r.inputsHash === 'string' &&
    typeof r.derivedHash === 'string' &&
    typeof r.toolVersion === 'string' &&
    typeof r.pnpmVersion === 'string' &&
    typeof r.timestamp === 'string'
  ) {
    return {
      epoch: r.epoch,
      inputsHash: r.inputsHash,
      derivedHash: r.derivedHash,
      toolVersion: r.toolVersion,
      pnpmVersion: r.pnpmVersion,
      timestamp: r.timestamp,
    };
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/memo/checks-api.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/memo/store.ts src/memo/checks-api.ts src/memo/checks-api.test.ts
git commit -m "feat: add the memo record marker embed/parse"
```

---

### Task 1.2: `appId` env reader

**Files:**
- Modify: `src/memo/auth.ts`
- Test: `src/memo/auth.test.ts`

**Interfaces:**
- Produces: `appId(env?: NodeJS.ProcessEnv): number | null`.

- [ ] **Step 1: Write the failing test** — append to `src/memo/auth.test.ts`:

```ts
import { appId } from './auth.js'; // add to the existing import from './auth.js'

describe('appId — the App identity for the consult filter', () => {
  it('reads a positive integer from LOCKFILE_ASSAY_APP_ID', () => {
    expect(appId({ LOCKFILE_ASSAY_APP_ID: '12345' })).toBe(12345);
  });
  it('is null when unset', () => {
    expect(appId({})).toBeNull();
  });
  it('is null for a non-integer or non-positive value', () => {
    expect(appId({ LOCKFILE_ASSAY_APP_ID: 'abc' })).toBeNull();
    expect(appId({ LOCKFILE_ASSAY_APP_ID: '0' })).toBeNull();
    expect(appId({ LOCKFILE_ASSAY_APP_ID: '1.5' })).toBeNull();
  });
});
```

(Adjust the existing top `import { discoverToken, originRepo } from './auth.js';`
to also import `appId`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/memo/auth.test.ts`
Expected: FAIL — `appId` is not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/memo/auth.ts`:

```ts
/**
 * The dedicated App's numeric id, from `LOCKFILE_ASSAY_APP_ID` (spec §8). Consult
 * filters check runs to this id — the security anchor that stops a same-named
 * `GITHUB_TOKEN`-authored check from being read as a record. Null (no id) simply
 * disables consult; a check never fails for lack of one.
 */
export function appId(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.LOCKFILE_ASSAY_APP_ID;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/memo/auth.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/memo/auth.ts src/memo/auth.test.ts
git commit -m "feat: read the memo app id from the environment"
```

---

### Task 1.3: `conclusion()` + `verdictSummary()` (pure outcome→check-run mapping)

**Files:**
- Modify: `src/memo/store.ts`
- Test: `src/memo/store.test.ts` (create)

**Interfaces:**
- Consumes: `Outcome` from `../outcome.js`.
- Produces: `conclusion(outcome: Outcome, exit: 0 | 1): 'success' | 'failure' |
  'neutral'`; `verdictSummary(outcome: Outcome): string`.

- [ ] **Step 1: Write the failing test** — create `src/memo/store.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Outcome } from '../outcome.js';
import { conclusion } from './store.js';

const O = {
  pass: { kind: 'pass' } as Outcome,
  vacuous: { kind: 'vacuous-pass' } as Outcome,
  off: { kind: 'not-evaluated' } as Outcome,
  mismatch: { kind: 'mismatch', committed: null, derived: Buffer.alloc(0) } as Outcome,
  skew: { kind: 'toolchain-skew', pinned: '10.0.0', effective: '9.0.0' } as Outcome,
  unsupported: { kind: 'unsupported-input', reasons: ['pnpmfile'] } as Outcome,
};

describe('conclusion — (outcome, exit) → check-run conclusion', () => {
  it('maps passes to success', () => {
    expect(conclusion(O.pass, 0)).toBe('success');
    expect(conclusion(O.vacuous, 0)).toBe('success');
  });
  it('maps off to neutral', () => {
    expect(conclusion(O.off, 0)).toBe('neutral');
  });
  it('maps enforce failures (exit 1) to failure', () => {
    expect(conclusion(O.mismatch, 1)).toBe('failure');
    expect(conclusion(O.skew, 1)).toBe('failure');
    expect(conclusion(O.unsupported, 1)).toBe('failure');
  });
  it('maps warn-mode failing kinds (exit 0) to neutral', () => {
    expect(conclusion(O.mismatch, 0)).toBe('neutral');
    expect(conclusion(O.skew, 0)).toBe('neutral');
    expect(conclusion(O.unsupported, 0)).toBe('neutral');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/memo/store.test.ts`
Expected: FAIL — `conclusion` is not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/memo/store.ts`:

```ts
import type { Outcome } from '../outcome.js';

/**
 * The check-run conclusion for a verdict (spec §8 verdict channel). `failure`
 * iff the assay's own exit is 1 (enforce + a failing outcome); a pass/vacuous
 * is `success`; everything else at exit 0 — `off`, or a warn-mode failing kind
 * — is `neutral` (visible, non-blocking). `neutral`/`success` both satisfy a
 * required check; `failure` blocks.
 */
export function conclusion(outcome: Outcome, exit: 0 | 1): 'success' | 'failure' | 'neutral' {
  if (exit === 1) return 'failure';
  if (outcome.kind === 'pass' || outcome.kind === 'vacuous-pass') return 'success';
  return 'neutral';
}

/** A one-line human summary for the verdict check run (kept minimal — the full
 * failure report is on the job's stdout; memo/ must not import report/). */
export function verdictSummary(outcome: Outcome): string {
  switch (outcome.kind) {
    case 'pass':
      return 'The committed lockfile derives honestly from reviewable inputs.';
    case 'vacuous-pass':
      return 'No resolution inputs changed; nothing to derive.';
    case 'not-evaluated':
      return 'lockfile-assay is off for this repository.';
    case 'mismatch':
      return 'The committed lockfile is NOT what honest re-derivation produces.';
    case 'toolchain-skew':
      return `Toolchain skew: pinned pnpm ${outcome.pinned}, effective ${outcome.effective}.`;
    case 'unsupported-input':
      return `Unsupported input: ${outcome.reasons.join('; ')}.`;
    case 'cannot-evaluate':
      return outcome.reason;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/memo/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memo/store.ts src/memo/store.test.ts
git commit -m "feat: map assay outcomes to check-run conclusions"
```

---

### Task 1.4: `Backend` interface + `MemoDriver.consult` (trust boundary)

**Files:**
- Modify: `src/memo/store.ts`
- Test: `src/memo/store.test.ts`

**Interfaces:**
- Consumes: `StagedFile` from `../staging.js`; `MemoProvenance` from
  `../outcome.js`; `inputsHash`, `EPOCH` from `./key.js`; `INVOCATION` from
  `../derive.js`; `MemoHook` from `../check.js` (implemented).
- Produces: `interface Backend { listRecords(): Promise<StoredRecord[]>;
  postVerdict(v: { headSha: string; conclusion: 'success' | 'failure' |
  'neutral'; title: string; summary: string }): Promise<void> }`; class
  `MemoDriver implements MemoHook` with `consult(files, committed)`.

- [ ] **Step 1: Write the failing test** — append to `src/memo/store.test.ts`:

```ts
import type { StoredRecord } from './store.js';
import { MemoDriver, sha256 } from './store.js';
import { EPOCH, inputsHash } from './key.js';
import { INVOCATION } from '../derive.js';
import type { StagedFile } from '../staging.js';
import type { Backend } from './store.js';

const files: StagedFile[] = [{ path: 'pnpm-lock.yaml', bytes: Buffer.from('lock') }];
const committed = Buffer.from('committed-lock');
const want = inputsHash(files, INVOCATION);

function fakeBackend(records: StoredRecord[]): Backend {
  return {
    listRecords: async () => records,
    postVerdict: async () => {},
  };
}

const good: StoredRecord = {
  epoch: EPOCH,
  inputsHash: want,
  derivedHash: sha256(committed),
  toolVersion: '1.0.0',
  pnpmVersion: '10.34.1',
  timestamp: '2026-07-13T00:00:00.000Z',
};

describe('MemoDriver.consult — pass or miss, never a failure', () => {
  it('hits when epoch + inputsHash + derivedHash all match', async () => {
    const d = new MemoDriver(fakeBackend([good]), false);
    expect(await d.consult(files, committed)).toEqual({
      hit: true,
      derivedAt: good.timestamp,
      toolVersion: good.toolVersion,
    });
  });

  it('misses (stale record) when derivedHash != sha256(committed)', async () => {
    const stale = { ...good, derivedHash: sha256(Buffer.from('other')) };
    const d = new MemoDriver(fakeBackend([stale]), false);
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('misses under a different epoch (isolation)', async () => {
    const d = new MemoDriver(fakeBackend([{ ...good, epoch: EPOCH + 1 }]), false);
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('misses when there is no committed lockfile', async () => {
    const d = new MemoDriver(fakeBackend([good]), false);
    expect(await d.consult(files, null)).toBeNull();
  });

  it('degrades a transport error to a miss (never throws)', async () => {
    const throwing: Backend = {
      listRecords: async () => {
        throw new Error('502 from GitHub');
      },
      postVerdict: async () => {},
    };
    const d = new MemoDriver(throwing, false);
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('is a no-op (miss) with a null backend', async () => {
    const d = new MemoDriver(null, false);
    expect(await d.consult(files, committed)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/memo/store.test.ts`
Expected: FAIL — `MemoDriver` / `Backend` not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/memo/store.ts`:

```ts
import type { MemoHook } from '../check.js';
import { INVOCATION } from '../derive.js';
import type { MemoProvenance } from '../outcome.js';
import type { StagedFile } from '../staging.js';
import { EPOCH, inputsHash } from './key.js';

export interface Backend {
  // records parsed from the *success* check runs on every head SHA this PR has
  // run against (current chain + force-pushed-away heads), filtered to the App
  // id + check name. Throws on transport error; the adapter maps it to a miss.
  listRecords(): Promise<StoredRecord[]>;
  postVerdict(v: {
    headSha: string;
    conclusion: 'success' | 'failure' | 'neutral';
    title: string;
    summary: string;
  }): Promise<void>;
}

export class MemoDriver implements MemoHook {
  private pending: StoredRecord | null = null;

  constructor(
    private readonly backend: Backend | null,
    private readonly write: boolean,
  ) {}

  async consult(files: StagedFile[], committed: Buffer | null): Promise<MemoProvenance | null> {
    if (!this.backend || !committed) return null;
    try {
      const want = inputsHash(files, INVOCATION);
      const committedHash = sha256(committed);
      for (const r of await this.backend.listRecords()) {
        if (r.epoch === EPOCH && r.inputsHash === want && r.derivedHash === committedHash) {
          return { hit: true, derivedAt: r.timestamp, toolVersion: r.toolVersion };
        }
      }
      return null;
    } catch {
      return null; // every read error degrades to a miss (spec §8)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/memo/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memo/store.ts src/memo/store.test.ts
git commit -m "feat: add the memo consult trust boundary"
```

---

### Task 1.5: `MemoDriver.record` + `postVerdict` (best-effort write + warning)

**Files:**
- Modify: `src/memo/store.ts`
- Test: `src/memo/store.test.ts`

**Interfaces:**
- Consumes: `toolVersion` from `../version.js`; `embedRecord` from
  `./checks-api.js`; `conclusion`, `verdictSummary` (same file).
- Produces: `MemoDriver.record(files, derived, pnpmVersion?): Promise<void>`
  (builds + stashes on a live pass); `MemoDriver.postVerdict(v: { outcome:
  Outcome; exit: 0 | 1; headSha: string }): Promise<string[]>` (posts one check
  run, returns warnings).

- [ ] **Step 1: Write the failing test** — append to `src/memo/store.test.ts`:

```ts
import type { Outcome } from '../outcome.js';
import { parseRecord } from './checks-api.js';

function capturingBackend() {
  const posted: Parameters<Backend['postVerdict']>[0][] = [];
  const backend: Backend = {
    listRecords: async () => [],
    postVerdict: async (v) => {
      posted.push(v);
    },
  };
  return { backend, posted };
}

const derived = Buffer.from('derived-lock');

describe('MemoDriver.record + postVerdict — the write path', () => {
  it('embeds the record in a success verdict on a live pass', async () => {
    const { backend, posted } = capturingBackend();
    const d = new MemoDriver(backend, true);
    await d.record(files, derived, '10.34.1'); // evaluate() calls this on a byte-match pass
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'deadbeef',
    });
    expect(warnings).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0].conclusion).toBe('success');
    expect(posted[0].headSha).toBe('deadbeef');
    const rec = parseRecord(posted[0].summary);
    expect(rec?.inputsHash).toBe(inputsHash(files, INVOCATION));
    expect(rec?.derivedHash).toBe(sha256(derived));
    expect(rec?.pnpmVersion).toBe('10.34.1');
    expect(rec?.epoch).toBe(EPOCH);
  });

  it('posts a failure verdict with no record on a mismatch (never memoised)', async () => {
    const { backend, posted } = capturingBackend();
    const d = new MemoDriver(backend, true);
    // record() is NOT called on a mismatch — evaluate() only calls it on a pass
    const warnings = await d.postVerdict({
      outcome: { kind: 'mismatch', committed, derived } as Outcome,
      exit: 1,
      headSha: 'deadbeef',
    });
    expect(warnings).toEqual([]);
    expect(posted[0].conclusion).toBe('failure');
    expect(parseRecord(posted[0].summary)).toBeNull();
  });

  it('warns (drift wording) but never throws when a pass write fails', async () => {
    const backend: Backend = {
      listRecords: async () => [],
      postVerdict: async () => {
        throw new Error('403 Forbidden');
      },
    };
    const d = new MemoDriver(backend, true);
    await d.record(files, derived, '10.34.1');
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'deadbeef',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not durable/);
    expect(warnings[0]).toMatch(/drift/);
  });

  it('is a no-op when write is false (local read-only forms never post)', async () => {
    const { backend, posted } = capturingBackend();
    const d = new MemoDriver(backend, false);
    await d.record(files, derived, '10.34.1');
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'deadbeef',
    });
    expect(warnings).toEqual([]);
    expect(posted).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/memo/store.test.ts`
Expected: FAIL — `record`/`postVerdict` not defined on `MemoDriver`.

- [ ] **Step 3: Write minimal implementation** — add the imports and the two
methods to `MemoDriver` in `src/memo/store.ts`:

```ts
// add to the imports at the top of store.ts:
import { toolVersion } from '../version.js';
import { embedRecord } from './checks-api.js';
// (conclusion + verdictSummary are already in this file)

// add these methods inside class MemoDriver:

  async record(files: StagedFile[], derived: Buffer, pnpmVersion?: string): Promise<void> {
    if (!this.backend || !this.write) return; // local forms never write
    this.pending = {
      epoch: EPOCH,
      inputsHash: inputsHash(files, INVOCATION),
      derivedHash: sha256(derived),
      toolVersion: toolVersion(),
      pnpmVersion: pnpmVersion ?? 'unknown',
      timestamp: new Date().toISOString(),
    };
  }

  /** Post one verdict check run for this run's outcome, embedding the stashed
   * record on a pass. Best-effort: a failure never changes the verdict — it
   * returns a warning (drift wording on the pass path). */
  async postVerdict(v: {
    outcome: Outcome;
    exit: 0 | 1;
    headSha: string;
  }): Promise<string[]> {
    if (!this.backend || !this.write) return [];
    const isPass = v.outcome.kind === 'pass';
    let summary = verdictSummary(v.outcome);
    if (isPass && this.pending) summary += `\n${embedRecord(this.pending)}`;
    try {
      await this.backend.postVerdict({
        headSha: v.headSha,
        conclusion: conclusion(v.outcome, v.exit),
        title: `lockfile-assay: ${v.outcome.kind}`,
        summary,
      });
      return [];
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return [
        isPass
          ? `could not record the derivation memo (${reason}); this pass is not durable — re-runs will re-resolve against the registry (spec §7 drift)`
          : `could not post the verdict check run (${reason})`,
      ];
    }
  }
```

Note: `embedRecord` (checks-api.ts) imports only the `StoredRecord` *type* from
store.ts (`import type`), so this store→checks-api runtime edge has no cycle.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/memo/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memo/store.ts src/memo/store.test.ts
git commit -m "feat: post verdicts and warn on failed memo writes"
```

---

### Task 1.6: `buildMemoDriver` + `CHECK_NAME` (construction / null-object)

**Files:**
- Modify: `src/memo/store.ts`
- Test: `src/memo/store.test.ts`

**Interfaces:**
- Consumes: `discoverToken`, `originRepo`, `appId` from `./auth.js`;
  `ChecksApiBackend` from `./checks-api.js` (defined in Task 1.7 — this task
  imports the class name; run Task 1.7's implementation first if executing
  strictly TDD, or stub the class import and let Task 1.7 fill it).
- Produces: `const CHECK_NAME = 'lockfile-assay'`; `buildMemoDriver(opts: {
  write: boolean; pr?: number; cwd?: string; env?: NodeJS.ProcessEnv; apiBase?:
  string; fetchImpl?: typeof fetch }): MemoDriver`.

> Ordering note: this task references `ChecksApiBackend`. Implement **Task 1.7
> first**, then this task — or create the empty `ChecksApiBackend` class shell in
> 1.7's file before wiring here. The test below only exercises the null-object
> path, so it does not require a working backend.

- [ ] **Step 1: Write the failing test** — append to `src/memo/store.test.ts`:

```ts
import { buildMemoDriver, CHECK_NAME } from './store.js';

describe('buildMemoDriver — null-object when context is absent', () => {
  it('CHECK_NAME is the stable required-check name', () => {
    expect(CHECK_NAME).toBe('lockfile-assay');
  });

  it('returns a driver that misses/no-ops when there is no token', async () => {
    // env with no token and an empty PATH so `gh auth token` finds nothing
    const d = buildMemoDriver({ write: true, pr: 1, env: { PATH: '/nonexistent' }, cwd: '.' });
    expect(await d.consult(files, committed)).toBeNull();
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'x',
    });
    expect(warnings).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/memo/store.test.ts`
Expected: FAIL — `buildMemoDriver`/`CHECK_NAME` not exported.

- [ ] **Step 3: Write minimal implementation** — append to `src/memo/store.ts`:

```ts
// add to imports:
import { appId, discoverToken, originRepo } from './auth.js';
import { ChecksApiBackend } from './checks-api.js';

export const CHECK_NAME = 'lockfile-assay';

/**
 * Construct a memo driver from the ambient CI context. Requires a token, a
 * github origin, and the App id; missing any of them yields a null-object
 * driver (consult → miss, postVerdict → no-op). `pr` is needed only for consult
 * (posting a verdict needs the head SHA, not the PR number). `apiBase` /
 * `fetchImpl` are test seams.
 */
export function buildMemoDriver(opts: {
  write: boolean;
  pr?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  apiBase?: string;
  fetchImpl?: typeof fetch;
}): MemoDriver {
  const env = opts.env ?? process.env;
  const token = discoverToken(env);
  const repo = originRepo(opts.cwd);
  const id = appId(env);
  if (!token || !repo || id === null) return new MemoDriver(null, opts.write);
  const slash = repo.indexOf('/');
  const backend = new ChecksApiBackend({
    token,
    owner: repo.slice(0, slash),
    repo: repo.slice(slash + 1),
    appId: id,
    checkName: CHECK_NAME,
    pr: opts.pr,
    apiBase: opts.apiBase,
    fetchImpl: opts.fetchImpl,
  });
  return new MemoDriver(backend, opts.write);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/memo/store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/memo/store.ts src/memo/store.test.ts
git commit -m "feat: build the memo driver from ci context"
```

---

### Task 1.7: `ChecksApiBackend` transport (REST + GraphQL)

**Files:**
- Modify: `src/memo/checks-api.ts`
- Test: covered by the integration test (Task 1.8); this task adds no unit test
  of its own beyond compilation (the transport is exercised end-to-end against a
  faked HTTP server, which is the meaningful test).

**Interfaces:**
- Consumes: `Backend`, `StoredRecord` (type) from `./store.js`.
- Produces: `class ChecksApiBackend implements Backend` with constructor `{
  token, owner, repo, appId, checkName, pr?, apiBase?, fetchImpl? }`.

- [ ] **Step 1: Write the implementation** (its test is Task 1.8) — append to
`src/memo/checks-api.ts`:

```ts
import type { Backend, StoredRecord } from './store.js';

const DEFAULT_API = 'https://api.github.com';

type Ctor = {
  token: string;
  owner: string;
  repo: string;
  appId: number;
  checkName: string;
  pr?: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
};

export class ChecksApiBackend implements Backend {
  private readonly api: string;
  private readonly f: typeof fetch;
  constructor(private readonly o: Ctor) {
    this.api = o.apiBase ?? DEFAULT_API;
    this.f = o.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.o.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'lockfile-assay',
      ...extra,
    };
  }

  async listRecords(): Promise<StoredRecord[]> {
    if (this.o.pr === undefined) return []; // no PR context → nothing to consult
    const shas = await this.candidateShas(this.o.pr);
    const records: StoredRecord[] = [];
    for (const sha of shas) {
      const url =
        `${this.api}/repos/${this.o.owner}/${this.o.repo}/commits/${sha}/check-runs` +
        `?app_id=${this.o.appId}&check_name=${encodeURIComponent(this.o.checkName)}&per_page=100`;
      const res = await this.f(url, { headers: this.headers() });
      if (!res.ok) continue; // a GC'd / unreadable SHA → skip (safe miss)
      const body = (await res.json()) as { check_runs?: CheckRun[] };
      for (const run of body.check_runs ?? []) {
        if (run.conclusion !== 'success') continue; // records live only in success runs
        const rec = parseRecord(run.output?.summary);
        if (rec) records.push(rec);
      }
    }
    return records;
  }

  /** Head SHAs this PR has ever run against: the current commit chain (REST)
   * plus force-pushed-away heads recovered from the timeline (GraphQL). */
  private async candidateShas(pr: number): Promise<string[]> {
    const shas = new Set<string>();
    for (let page = 1; page < 50; page++) {
      const url = `${this.api}/repos/${this.o.owner}/${this.o.repo}/pulls/${pr}/commits?per_page=100&page=${page}`;
      const res = await this.f(url, { headers: this.headers() });
      if (!res.ok) break;
      const arr = (await res.json()) as { sha: string }[];
      for (const c of arr) shas.add(c.sha);
      if (arr.length < 100) break;
    }
    for (const sha of await this.forcePushedHeads(pr)) shas.add(sha);
    return [...shas];
  }

  private async forcePushedHeads(pr: number): Promise<string[]> {
    const query =
      'query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo)' +
      '{pullRequest(number:$pr){timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],first:100)' +
      '{nodes{... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid}}}}}}}';
    const res = await this.f(`${this.api}/graphql`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ query, variables: { owner: this.o.owner, repo: this.o.repo, pr } }),
    });
    if (!res.ok) return []; // GraphQL unavailable → fall back to the current chain only
    const body = (await res.json()) as ForcePushResponse;
    const nodes = body?.data?.repository?.pullRequest?.timelineItems?.nodes ?? [];
    const out: string[] = [];
    for (const n of nodes) {
      if (n?.beforeCommit?.oid) out.push(n.beforeCommit.oid);
      if (n?.afterCommit?.oid) out.push(n.afterCommit.oid);
    }
    return out;
  }

  async postVerdict(v: {
    headSha: string;
    conclusion: 'success' | 'failure' | 'neutral';
    title: string;
    summary: string;
  }): Promise<void> {
    const url = `${this.api}/repos/${this.o.owner}/${this.o.repo}/check-runs`;
    const res = await this.f(url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: this.o.checkName,
        head_sha: v.headSha,
        status: 'completed',
        conclusion: v.conclusion,
        output: { title: v.title, summary: v.summary },
      }),
    });
    if (!res.ok) throw new Error(`check-run create failed: ${res.status} ${await res.text()}`);
  }
}

type CheckRun = {
  conclusion: string | null;
  output?: { summary?: string | null };
};
type ForcePushResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        timelineItems?: { nodes?: { beforeCommit?: { oid?: string }; afterCommit?: { oid?: string } }[] };
      };
    };
  };
};
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm typecheck`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/memo/checks-api.ts
git commit -m "feat: add the checks-api memo transport"
```

---

### Task 1.8: Integration test — adapter + transport against a faked Checks API

**Files:**
- Create: `test/integration/memo.test.ts`

**Interfaces:**
- Consumes: `buildMemoDriver` (`src/memo/store.js`), `CHECK_NAME`,
  `parseRecord`/`embedRecord` where useful; a local `node:http` server as the
  fake GitHub API.

This test re-creates the shape of the removed `test/integration/memo.test.ts`
(PR #6), now against a faked **Checks API** rather than a faked contents store.
It drives the real `ChecksApiBackend` (via `buildMemoDriver` with an injected
`apiBase` + env) against a `node:http` server that mimics the GitHub endpoints.

- [ ] **Step 1: Write the test**

Create `test/integration/memo.test.ts`:

```ts
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION } from '../../src/derive.js';
import { EPOCH, inputsHash } from '../../src/memo/key.js';
import { buildMemoDriver, CHECK_NAME, sha256, type StoredRecord } from '../../src/memo/store.js';
import { embedRecord } from '../../src/memo/checks-api.js';
import type { StagedFile } from '../../src/staging.js';

// A faked GitHub Checks API. Tests seed check runs keyed by commit SHA and
// register which commits belong to the PR's current chain vs its force-pushed
// history, then assert what the driver reads / writes.
type Run = { conclusion: string; summary: string; app_id: number; name: string };
class FakeGitHub {
  server!: Server;
  base = '';
  chain: string[] = []; // current PR commits
  forced: string[] = []; // force-pushed-away head SHAs (timeline beforeCommit)
  runs = new Map<string, Run[]>(); // sha -> check runs
  posted: { head_sha: string; conclusion: string; summary: string }[] = [];

  seedRun(sha: string, run: Run) {
    const list = this.runs.get(sha) ?? [];
    list.push(run);
    this.runs.set(sha, list);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://x');
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      // list PR commits
      let m = /\/pulls\/\d+\/commits$/.exec(url.pathname);
      if (m && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? '1');
        return send(200, page === 1 ? this.chain.map((sha) => ({ sha })) : []);
      }
      // list check runs for a sha
      m = /\/commits\/([0-9a-f]+)\/check-runs$/.exec(url.pathname);
      if (m && req.method === 'GET') {
        const appId = Number(url.searchParams.get('app_id'));
        const name = url.searchParams.get('check_name');
        const all = this.runs.get(m[1] as string) ?? [];
        const check_runs = all
          .filter((r) => r.app_id === appId && r.name === name)
          .map((r) => ({ conclusion: r.conclusion, output: { summary: r.summary } }));
        return send(200, { check_runs });
      }
      // graphql force-push timeline
      if (url.pathname === '/graphql' && req.method === 'POST') {
        return send(200, {
          data: {
            repository: {
              pullRequest: {
                timelineItems: {
                  nodes: this.forced.map((oid) => ({ beforeCommit: { oid }, afterCommit: null })),
                },
              },
            },
          },
        });
      }
      // create check run
      if (/\/check-runs$/.test(url.pathname) && req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const body = JSON.parse(raw);
          this.posted.push({
            head_sha: body.head_sha,
            conclusion: body.conclusion,
            summary: body.output.summary,
          });
          // reflect it into the store so a later consult can read it
          this.seedRun(body.head_sha, {
            conclusion: body.conclusion,
            summary: body.output.summary,
            app_id: 999,
            name: CHECK_NAME,
          });
          send(201, { id: 1, app: { id: 999 } });
        });
        return;
      }
      send(404, {});
    });
    await new Promise<void>((r) => this.server.listen(0, r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const APP_ID = 999;
const files: StagedFile[] = [{ path: 'pnpm-lock.yaml', bytes: Buffer.from('lock') }];
const committed = Buffer.from('committed-lock');

function record(over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    epoch: EPOCH,
    inputsHash: inputsHash(files, INVOCATION),
    derivedHash: sha256(committed),
    toolVersion: '1.0.0',
    pnpmVersion: '10.34.1',
    timestamp: '2026-07-13T00:00:00.000Z',
    ...over,
  };
}
const successRun = (rec: StoredRecord): Run => ({
  conclusion: 'success',
  summary: `ok\n${embedRecord(rec)}`,
  app_id: APP_ID,
  name: CHECK_NAME,
});

// A repo with a github origin so originRepo() resolves; env carries the token
// and app id. cwd points at it so buildMemoDriver has a repo.
let repoDir: string;
let gh: FakeGitHub;
function driver(pr: number | undefined, write: boolean) {
  return buildMemoDriver({
    write,
    pr,
    cwd: repoDir,
    apiBase: gh.base,
    fetchImpl: fetch,
    env: { LOCKFILE_ASSAY_TOKEN: 'ghs_x', LOCKFILE_ASSAY_APP_ID: String(APP_ID) },
  });
}

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'assay-memo-int-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:octo/assay.git'], { cwd: repoDir });
  gh = new FakeGitHub();
  await gh.start();
});
afterEach(async () => {
  await gh.stop();
  rmSync(repoDir, { recursive: true, force: true });
});

describe('memo, against a faked Checks API', () => {
  it('append survival: a record on an earlier commit in the chain hits', async () => {
    gh.chain = ['sha_old', 'sha_head'];
    gh.seedRun('sha_old', successRun(record()));
    expect(await driver(7, false).consult(files, committed)).toMatchObject({ hit: true });
  });

  it('force-push survival: a record only on a force-pushed-away head hits', async () => {
    gh.chain = ['sha_squashed']; // current chain has no record
    gh.forced = ['sha_orphan'];
    gh.seedRun('sha_orphan', successRun(record()));
    expect(await driver(7, false).consult(files, committed)).toMatchObject({ hit: true });
  });

  it('hit short-circuits with no further lookups needed (no live re-roll)', async () => {
    gh.chain = ['sha_head'];
    gh.seedRun('sha_head', successRun(record()));
    const prov = await driver(7, false).consult(files, committed);
    expect(prov).toEqual({ hit: true, derivedAt: '2026-07-13T00:00:00.000Z', toolVersion: '1.0.0' });
  });

  it('stale memo (derivedHash mismatch) falls through to a miss', async () => {
    gh.chain = ['sha_head'];
    gh.seedRun('sha_head', successRun(record({ derivedHash: sha256(Buffer.from('other')) })));
    expect(await driver(7, false).consult(files, committed)).toBeNull();
  });

  it('a mismatch verdict is never memoised (failure run carries no record)', async () => {
    const d = driver(7, true);
    await d.postVerdict({
      outcome: { kind: 'mismatch', committed, derived: Buffer.from('d') } as never,
      exit: 1,
      headSha: 'sha_head',
    });
    expect(gh.posted[0].conclusion).toBe('failure');
    // reflected into the store as a failure run; a later consult must not hit
    gh.chain = ['sha_head'];
    expect(await driver(7, false).consult(files, committed)).toBeNull();
  });

  it('epoch isolation: a record under a bumped epoch misses', async () => {
    gh.chain = ['sha_head'];
    gh.seedRun('sha_head', successRun(record({ epoch: EPOCH + 1 })));
    expect(await driver(7, false).consult(files, committed)).toBeNull();
  });

  it('duplicate records from concurrent runs read as equivalent (still one hit)', async () => {
    gh.chain = ['sha_head'];
    gh.seedRun('sha_head', successRun(record()));
    gh.seedRun('sha_head', successRun(record())); // a second concurrent run posted the same
    expect(await driver(7, false).consult(files, committed)).toMatchObject({ hit: true });
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `pnpm vitest run test/integration/memo.test.ts`
Expected: PASS (7 tests). (If any fetch/host detail differs, fix the transport
or the fake — the fake is the contract the spike will validate against real
GitHub.)

- [ ] **Step 3: Commit**

```bash
git add test/integration/memo.test.ts
git commit -m "feat: test the memo against a faked checks api"
```

---

### Task 1.9: Extend the import-graph guard — `memo/ ↛ report/`

**Files:**
- Modify: `src/import-graph.test.ts`

- [ ] **Step 1: Write the failing test** — add a new `it` inside the existing
`describe('spec §13 trust-path discipline', …)` in `src/import-graph.test.ts`:

```ts
  // The memo must not pull the report layer into the trust path (spec §13). An
  // explicit guard so it cannot silently regress.
  it('memo/ imports no report/ module', () => {
    for (const file of allSrcFiles()) {
      if (!file.startsWith('memo/')) continue;
      for (const imp of importsOf(file)) {
        const reachesReport = imp.includes('report/');
        expect(reachesReport, `${file} must not import ${imp}`).toBe(false);
      }
    }
  });
```

- [ ] **Step 2: Run the guard**

Run: `pnpm vitest run src/import-graph.test.ts`
Expected: PASS — the memo modules import no `report/` (they use `node:crypto`,
`fetch`, `./key.js`, `./auth.js`, `../outcome.js`, `../staging.js`,
`../derive.js`, `../version.js`, `../check.js`). If it FAILS, a memo module is
reaching into `report/` — remove that import.

- [ ] **Step 3: Commit**

```bash
git add src/import-graph.test.ts
git commit -m "feat: guard the memo against report imports"
```

---

### Task 1.10: Green gate + open PR 1

- [ ] **Step 1: Full gate**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test:unit && pnpm test:integration`
Expected: all PASS. Fix any biome/tsc issues inline (e.g. unused vars, import
ordering) and re-run.

- [ ] **Step 2: Push and open the PR** — use the `git-pull-request` skill.
Title: `feat: derivation-memo Checks-API backend`. Body notes: this PR adds the
memo backend + transport + adapter with full unit/integration tests but does
**not** wire it into the CLI — production behaviour is unchanged; PR 2
(`memo-checks-api-wiring`) turns it on. Draft PR; keep it green.

---

## PR 2 — Wire the memo + verdict channel into the CLI and the anchored contract

Branch: `jsalvata/memo-checks-api-wiring` off `jsalvata/memo-checks-api-backend`
(stacked; use the `git-branch` skill, then rebase on PR 1 as it merges).

File structure modified in PR 2:

- Modify `src/report/render.ts` — add `warnings?: string[]` to `ReportInput`;
  render it in `renderJson` (a `warnings` field) and `renderHuman` (lines).
- Modify `src/cli.ts` — add `--pr <number>`; construct `buildMemoDriver`, pass
  it to `runCheck`/`runStagedCheck`, post the verdict after the CI form, thread
  warnings into the rendered report; drop the "not wired" comment.
- Modify `src/cli.test.ts` — assert `--pr` parses and the verdict wiring runs
  against a faked driver context.
- Modify `action.yml`, `examples/lockfile-assay.yml`, `docs/setup-github-app.md`.

---

### Task 2.1: `warnings` on the report

**Files:**
- Modify: `src/report/render.ts`
- Test: create `src/report/render.test.ts` (if none exists) or add to it

**Interfaces:**
- Produces: `ReportInput.warnings?: string[]`; `renderJson` emits `warnings`;
  `renderHuman` prints each warning on its own `warning: …` line.

- [ ] **Step 1: Write the failing test** — create `src/report/render.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderHuman, renderJson } from './render.js';
import type { ReportInput } from './render.js';

const base: ReportInput = {
  outcome: { kind: 'pass' },
  mode: 'enforce',
  base: 'abc',
  head: 'def',
  warnings: ['could not record the derivation memo (403); this pass is not durable'],
};

describe('report warnings', () => {
  it('renders warnings in the json report', () => {
    const j = JSON.parse(renderJson(base));
    expect(j.warnings).toEqual(base.warnings);
  });
  it('renders warnings as warning: lines in the human report', () => {
    expect(renderHuman(base)).toMatch(/warning: could not record the derivation memo/);
  });
  it('omits warnings when there are none', () => {
    const j = JSON.parse(renderJson({ ...base, warnings: undefined }));
    expect(j.warnings).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/report/render.test.ts`
Expected: FAIL — `warnings` not on `ReportInput` / not rendered.

- [ ] **Step 3: Write minimal implementation** — in `src/report/render.ts`:

Add to `ReportInput`:

```ts
  warnings?: string[];
```

In `renderJson`, add `warnings: r.warnings,` to the emitted object (place it
after `memo`).

In `renderHuman`, before `return lines.join('\n');`, add:

```ts
  for (const w of r.warnings ?? []) lines.push(`warning: ${w}`);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/report/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/report/render.ts src/report/render.test.ts
git commit -m "feat: surface memo warnings in the report"
```

---

### Task 2.2: Wire the driver into the CLI (`--pr`, consult, verdict post)

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli.test.ts`

**Interfaces:**
- Consumes: `buildMemoDriver` from `./memo/store.js`.
- Produces: `check --pr <number>`; the CI form consults + posts the verdict; the
  local `--staged` form consults read-only (never posts). Behaviour of `off` /
  vacuous / failing outcomes is that the CI form posts one App check run per run.

- [ ] **Step 1: Write the failing test** — append to `src/cli.test.ts`:

```ts
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
```

> Note: this test runs against the real repo cwd; with `--base HEAD --head HEAD`
> the net diff is empty → vacuous pass, no config/network. It asserts `--pr` is a
> known option. Keep it minimal; the memo logic itself is covered in PR 1.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/cli.test.ts`
Expected: FAIL — commander reports unknown option `--pr`.

- [ ] **Step 3: Write the implementation** — edit `src/cli.ts`:

Replace the module-doc comment paragraph about "The derivation memo … is not
wired in this build" with a short note that the memo is wired via
`buildMemoDriver` (CI form writes + consults; local forms read-only).

Add the import:

```ts
import { buildMemoDriver } from './memo/store.js';
```

Add the option to the `check` command (after `--memo-write`):

```ts
    .option('--pr <number>', 'PR number (enables memo consult in the CI form)', (v) => Number(v))
```

Update the `check` action handler body. Keep the existing `--staged`+`--memo-write`
guard. Replace the two run branches with driver-wired versions:

```ts
        if (o.staged) {
          // local hook form: read-only memo (consult only when --pr given), never posts
          const memo = buildMemoDriver({ write: false, pr: o.pr });
          const r = await runStagedCheck({ memo });
          console.log(o.json ? renderJson(r.report) : renderHuman(r.report));
          process.exitCode = r.exit;
          return;
        }
        if (!o.base) throw new UsageError('--base <ref> is required');
        const memo = buildMemoDriver({ write: !!o.memoWrite, pr: o.pr });
        const r = await runCheck({ base: o.base, head: o.head, memo });
        const warnings = await memo.postVerdict({
          outcome: r.outcome,
          exit: r.exit,
          headSha: r.report.head,
        });
        const report = warnings.length ? { ...r.report, warnings } : r.report;
        console.log(o.json ? renderJson(report) : renderHuman(report));
        process.exitCode = r.exit;
```

Extend the action's option type to include `pr?: number`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/cli.test.ts`
Expected: PASS (existing guard test + the new `--pr` test).

- [ ] **Step 5: Full gate**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test:unit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: wire the memo and verdict channel into the cli"
```

---

### Task 2.3: Update the anchored contract (action, example, setup doc)

**Files:**
- Modify: `action.yml`
- Modify: `examples/lockfile-assay.yml`
- Modify: `docs/setup-github-app.md`

- [ ] **Step 1: `action.yml`** — add `pr` and `app-id` inputs, fix the stale
`memo-token` description, and pass both through. Replace the file with:

```yaml
name: lockfile-assay
description: >-
  Verify the committed lockfile derives honestly from reviewable inputs, and
  record passing derivations to the memo (anchored CI form — spec §8).
inputs:
  base:
    description: Base ref (the PR merge-base), e.g. origin/${{ github.base_ref }}.
    required: true
  head:
    description: Head ref to check.
    required: false
    default: HEAD
  pr:
    description: PR number, for memo consult (github.event.pull_request.number).
    required: true
  app-id:
    description: The dedicated App's id, for the consult identity filter.
    required: true
  memo-token:
    description: >-
      GitHub App installation token with Checks: write, from the dedicated App
      (actions/create-github-app-token). Passed to the CLI as
      LOCKFILE_ASSAY_TOKEN. See docs/setup-github-app.md.
    required: true
runs:
  using: composite
  steps:
    - name: lockfile-assay
      shell: bash
      env:
        LOCKFILE_ASSAY_TOKEN: ${{ inputs.memo-token }}
        LOCKFILE_ASSAY_APP_ID: ${{ inputs.app-id }}
      run: |
        npx --yes lockfile-assay check \
          --base "${{ inputs.base }}" --head "${{ inputs.head }}" \
          --pr "${{ inputs.pr }}" \
          --memo-write --json
```

- [ ] **Step 2: `examples/lockfile-assay.yml`** — pass `--pr` and the app id
env. In the final `lockfile-assay` step, replace its `env:` and `run:` with:

```yaml
      - name: lockfile-assay
        env:
          LOCKFILE_ASSAY_TOKEN: ${{ steps.app-token.outputs.token }}
          LOCKFILE_ASSAY_APP_ID: ${{ secrets.ASSAY_APP_ID }}
        run: |
          npx --yes lockfile-assay check \
            --base "origin/${{ github.base_ref }}" \
            --head "${{ github.event.pull_request.head.sha }}" \
            --pr "${{ github.event.pull_request.number }}" \
            --memo-write --json
```

And in the Option-B snippet inside `docs/setup-github-app.md` (the `uses:
jsalvata/lockfile-assay@v1` block), add the two new `with:` inputs:

```yaml
      - uses: jsalvata/lockfile-assay@v1
        with:
          base: origin/${{ github.base_ref }}
          head: ${{ github.event.pull_request.head.sha }}
          pr: ${{ github.event.pull_request.number }}
          app-id: ${{ secrets.ASSAY_APP_ID }}
          app-token: ${{ steps.app-token.outputs.token }}
```

(Rename the action input if you prefer `memo-token` vs `app-token` — keep it
consistent with `action.yml`; the current file uses `memo-token`, so use that.)

- [ ] **Step 3: `docs/setup-github-app.md`** — in §4's Option-B snippet and any
prose that lists what the workflow passes, add `LOCKFILE_ASSAY_APP_ID:
${{ secrets.ASSAY_APP_ID }}` and `--pr ${{ github.event.pull_request.number }}`,
and add one sentence under §1/§3 that the App id (already stored as
`ASSAY_APP_ID`) is now also passed to the CLI for the consult identity filter.

- [ ] **Step 4: Verify YAML + docs**

Run: `pnpm lint` (biome does not lint YAML, but keeps TS/JSON clean); manually
re-read `action.yml` and `examples/lockfile-assay.yml` for a consistent set of
inputs (`base`, `head`, `pr`, `app-id`, `memo-token`).

- [ ] **Step 5: Commit**

```bash
git add action.yml examples/lockfile-assay.yml docs/setup-github-app.md
git commit -m "docs: pass pr and app id through the anchored contract"
```

---

### Task 2.4: Green gate + open PR 2

- [ ] **Step 1: Full gate**

Run: `pnpm lint && pnpm typecheck && pnpm build && pnpm test:unit && pnpm test:integration`
Expected: all PASS.

- [ ] **Step 2: Open the PR** — `git-pull-request` skill. Title: `feat: wire the
memo verdict channel into the CLI`. Body: stacked on PR 1; turns the memo on in
the CI form (`--pr` + `LOCKFILE_ASSAY_APP_ID`); notes the pre-merge validation
spike (below) is still required before either PR merges.

---

## Pre-merge validation spike (spec §8 — collaborative, before merge)

Not a code task — done with the user on a scratch repo (App creation is UI-only).
Prove and capture in a spike doc (`docs/spike-checks-api-memo.md`):

1. A deployment-branch-restricted Environment admits `pull_request_target` and
   refuses `pull_request` (including a PR-added workflow).
2. An App-pinned required check refuses a same-named `GITHUB_TOKEN` check.
3. Check-run immutability (only the creating App updates its runs).
4. In-workflow installation-token minting.
5. consult/write mechanics + equivalent duplicate records from concurrent runs.
6. **List-endpoint shape:** does `GET …/commits/{sha}/check-runs` return
   `output.summary` in the list? If not, switch `listRecords` to a per-run `GET`
   (Backend interface unchanged). Confirm `app_id` + `check_name` filters.
7. **Force-push discovery:** `HeadRefForcePushedEvent.beforeCommit.oid` via
   GraphQL; orphaned-commit check-run listability by SHA; GC window. Fallback to
   an alternate head-SHA source if GraphQL is unworkable.

## Self-review (done while writing this plan)

- **Spec coverage:** record contents (Task 1.5) ✓; write = App check run with
  embedded record (1.5/1.7) ✓; consult filtered to app id + name, PR-scoped,
  pass-or-miss (1.4/1.7/1.8) ✓; force-push survival (1.7/1.8) ✓; best-effort +
  warning (1.5, 2.1) ✓; epoch isolation (1.4/1.8) ✓; malformed → miss (1.1/1.4)
  ✓; full verdict channel incl. off/vacuous/fail mapping (1.3/1.5) ✓; `--pr` +
  `LOCKFILE_ASSAY_APP_ID` contract (1.2/2.2/2.3) ✓; import guard (1.9) ✓; faked
  Checks-API integration ring (1.8) ✓; spike items (above) ✓.
- **Placeholder scan:** none — every code step carries complete code.
- **Type consistency:** `StoredRecord`, `Backend`, `MemoDriver`,
  `buildMemoDriver`, `conclusion`, `CHECK_NAME`, `appId`, `embedRecord`/
  `parseRecord`, `sha256` are used with identical signatures across tasks.
