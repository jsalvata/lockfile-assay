# Design: derivation-memo backend + anchored verdict channel (Checks API)

*Status: approved 2026-07-13. Implements spec §8 ("durable verdicts — the
derivation memo") and §13 (module layout, trust-path discipline) under the
anchored Checks-API store. Supersedes the removed Contents-API branch store
(PR #6). Source of truth for the feature; the normative contract stays spec
§8/§13, `docs/external-app-direction.md`, and `docs/setup-github-app.md`.*

## 0. Context and what changed

Today the memo is inert: `check.ts` calls a `MemoHook` boundary that is always
null, and `--memo-write` is parsed but does nothing (`cli.ts` comment). The
Contents-API orphan-branch store was removed in PR #6 and rejected in spec §8's
alternatives table; this feature builds the store the spec now names — **the
verdict channel itself**: the anchored check posts its verdict as a **check run
under a dedicated GitHub App**, and the memo record rides in that run's output.
Authorship is server-inherent (GitHub sets a check run's creating App from the
token; only that App can update it), so there is no second ACL to provision.

Two decisions taken at design time, beyond the minimal "memo backend":

1. **Full verdict channel now.** The CI form posts one App check run per run
   reflecting the outcome (success / failure / neutral), not only a memo record
   on pass. This makes the App-pinned required check (spec §6, setup doc §5)
   real. Failing-verdict posting is therefore in scope, unified with the memo
   write.
2. **Warn on a failed memo write.** A best-effort write that fails never changes
   the verdict — but it emits a warning, because a non-recorded pass re-opens
   the §7 registry-drift exposure the memo exists to close. (Re-creates the
   intent of the removed `feat: warn when --memo-write can't record` /
   `feat: annotate the memo warning in ci`.)
3. **Force-push-surviving discovery.** consult collects candidate head SHAs from
   both the current PR commit chain and the force-pushed-away heads in the PR
   timeline, so a squash / amend / rebase that preserves `inputsHash` still hits
   (best-effort, GC-bounded — §4). Records are pinned to commit SHAs, so this is
   how a content-preserving history rewrite is recovered without the rejected
   content-addressed store.

## 1. What stays, what is new

**Keep / reuse (post-#6):**

- `src/memo/key.ts` — `EPOCH` (integer source constant, currently `1`) and
  `inputsHash(files, invocation)` (collision-resistant SHA-256 over staged
  bytes; `invocation` = `derive.ts`'s `INVOCATION`). This is the memo key.
- `src/memo/auth.ts` — `discoverToken(env)` (`LOCKFILE_ASSAY_TOKEN` →
  `GITHUB_TOKEN` → `gh auth token` → null) and `originRepo(cwd)` (host-anchored
  `owner/name` from `origin`). Covered by `auth.test.ts`.
- `src/check.ts` — the `MemoHook` boundary and `evaluate()` shape are unchanged
  in spirit: `consult` runs before the derive (a truthy `{hit:true,…}`
  short-circuits to `pass`); `record` runs only on a byte-match pass. Only the
  *posting* of the verdict/record moves to the CLI layer (§4).

**New:**

- `src/memo/checks-api.ts` — the Checks-API transport (`fetch` + `node:crypto`,
  no third-party; no `yaml`, no `report/`).
- `src/memo/store.ts` — the `Backend` interface, `StoredRecord` type, the
  `MemoHook` adapter (trust boundary), the outcome→conclusion mapping and the
  verdict poster, and `buildMemo(...)` (lazy null-object when creds/context are
  absent).
- CLI/action contract additions: `--pr <number>`, `LOCKFILE_ASSAY_APP_ID` env.
- Tests: `store.test.ts` (unit, faked `Backend`), `test/integration/memo.test.ts`
  (adapter + real transport against a faked Checks-API HTTP server), an
  extension to `import-graph.test.ts` (`memo/ ↛ report/`), `checks-api` embed/
  parse unit coverage, and an `auth.test.ts` extension for the app-id reader.

## 2. Layered architecture

Three layers, so the trust boundary is independent of transport and both are
testable in isolation (spec §13 "memo, against a faked Checks API"):

```
check.ts ── MemoHook ─┐
cli.ts ── postVerdict ─┤→  store.ts (adapter: trust boundary + verdict mapping)
                       │        │  depends on ↓ a narrow interface
                       │   Backend  ── checks-api.ts (transport: fetch, node:crypto)
                       └── buildMemo(...) constructs both, or a null-object
```

- **Transport (`checks-api.ts`).** Design-independent HTTP against the GitHub
  Checks, Pulls, and GraphQL APIs. Knows nothing about trust: it lists a PR's
  current commits (REST) and its force-pushed-away heads (GraphQL timeline),
  lists a commit's check runs filtered to an app id + check name (REST), creates
  a check run, and embeds/parses the record JSON in a run's output. `Backend` is
  the interface it satisfies.
- **Adapter (`store.ts`).** Owns the design-independent trust boundary: compute
  `inputsHash`, compare a record's `derivedHash` to `sha256(committed)`,
  validate record shape before trusting it, honor `EPOCH`, and record only on a
  pass. Never imports `report/`. Consumes a `Backend`.
- **Wiring (`cli.ts`).** `buildMemo` assembles the adapter over a real transport
  when the CI context is present (token, repo, app id, PR, head SHA), else a
  null-object. The CI form additionally drives `postVerdict` after `runCheck`.

### `Backend` interface

```ts
type StoredRecord = {
  epoch: number;
  inputsHash: string;
  derivedHash: string;   // sha256 of the derived lockfile, hex
  toolVersion: string;
  pnpmVersion: string;
  timestamp: string;     // ISO-8601
};

interface Backend {
  // consult: records parsed from the *success* check runs on every head SHA
  // this PR has run against — the current commit chain plus force-pushed-away
  // heads from the timeline — filtered to the App's identity + check name. Any
  // transport error throws; the adapter maps a throw to a miss.
  listRecords(): Promise<StoredRecord[]>;
  // verdict post: one check run reflecting this run's outcome, embedding
  // `record` on a pass. Throws on failure; the caller treats a throw as a
  // best-effort miss and warns.
  postVerdict(v: {
    headSha: string;
    conclusion: 'success' | 'failure' | 'neutral';
    title: string;
    summary: string;
    record?: StoredRecord;
  }): Promise<void>;
}
```

## 3. The record and where it lives

`StoredRecord` (above) carries everything spec §8 names: epoch, inputs hash,
derived lockfile hash, assay + effective pnpm versions, timestamp.

It is embedded as JSON inside a **success** check run's `output.summary`, behind
an HTML-comment marker so it is invisible in rendered markdown and unambiguous
to parse:

```
<!--lockfile-assay-memo:v1 {"epoch":1,"inputsHash":"…",…} -->
```

`output.summary` (not `output.text`) is chosen because the check-runs *list*
endpoint is expected to return `summary`; whether it also returns `text` is a
spike-validation item (§8). Only success runs carry a record; failure/neutral
runs carry the report text only, and the adapter never reads a record from a
non-success run (defense in depth — a failure run cannot smuggle a forged
record).

## 4. consult, record, and the verdict channel

### consult(files, committed) — read, may only short-circuit to a pass

1. No committed lockfile, or no PR/token/app-id context → **miss** (null).
2. `want = inputsHash(files, INVOCATION)`; `committedHash = sha256(committed)`.
3. `backend.listRecords()` gathers the candidate head SHAs this PR has ever run
   against, then reads their records:
   - **current chain:** `GET /repos/{o}/{r}/pulls/{pr}/commits` (paginated);
   - **force-pushed-away heads:** the `beforeCommit` oid of every
     `HeadRefForcePushedEvent` in the PR's timeline, via GraphQL (still `fetch`,
     no third-party — REST does not expose the before-SHA);
   - for each unique SHA: `GET /repos/{o}/{r}/commits/{sha}/check-runs?app_id={id}&check_name={name}&per_page=100`;
   - parse the record from each **success** run's `output.summary`.
4. First record with `epoch === EPOCH && inputsHash === want && derivedHash ===
   committedHash` → `{ hit: true, derivedAt: timestamp, toolVersion }`.
5. No match / any transport error / malformed record → **miss**.

**Why these SHAs — surviving both appends and force-pushes.** A push keeps
`inputsHash` identical but changes the head SHA, and check runs are keyed to the
SHA they ran against, so the matching record lives on an *earlier* head. A
source-only append leaves that head in the current chain (`GET …/commits` finds
it). A squash / amend / rebase force-pushes the head away, orphaning it — so
consult *also* collects the force-pushed-away heads from the PR timeline
(`HeadRefForcePushedEvent.beforeCommit`) and lists their check runs. This is why
the PR number is required (§5).

**GC caveat.** GitHub eventually garbage-collects orphaned commits; once
collected, their check runs are unreachable by SHA and that record is lost — a
**safe miss** (live re-derive + re-record), never a false pass. Force-push
survival is therefore best-effort and time-bounded, covering the common
squash-then-continue case. A base advance that changes the staged lockfile is a
*different* `inputsHash` and misses by design (§7 base drift), force-push or not.
The spike validates the timeline mechanism and orphaned-SHA listability (§8).

**Why the `app_id` filter is load-bearing.** Without it, a same-PR laundering
attack works: a PR-added `pull_request` job (no secrets, `GITHUB_TOKEN`) posts a
check run *named* like ours carrying a poisoned record on an early commit, then a
clean push rides it. Filtering to the App's numeric identity ignores any
`GITHUB_TOKEN`-authored (`github-actions`) check, because check-run authorship is
server-set. This is why the CLI must know the App id (§5).

Consult is **PR-scoped** by construction (no cross-PR hits): every re-roll the
memo kills is same-PR — source-only pushes, flaky re-runs, merge-queue
re-validation.

### record(files, derived, pnpmVersion) — build only, on a live pass

Called only on a live byte-match pass (unchanged). It **builds** the
`StoredRecord` (`derivedHash = sha256(derived)`, `toolVersion = toolVersion()`,
`pnpmVersion`, `timestamp = now`, `epoch = EPOCH`) and stashes it on the memo
instance. It never posts and never throws. (`record()` returning `void` and
being called on pass is preserved; only the posting moves to §4's poster.)

### The verdict channel — one post per run, at the CLI layer

After `runCheck` returns, the **CI form** posts exactly one App check run via
`backend.postVerdict`, embedding the stashed record on a pass. The conclusion
maps from `(outcome, exit)`:

| Outcome | exit | conclusion | record embedded |
|---|---|---|---|
| pass (live) | 0 | `success` | yes (the stashed record) |
| pass (memo hit) / vacuous-pass | 0 | `success` | no (hit: record already on an earlier commit) |
| not-evaluated (`off`) | 0 | `neutral` | no |
| mismatch / skew / unsupported — `warn` | 0 | `neutral` | no |
| mismatch / skew / unsupported — `enforce` | 1 | `failure` | no |

`conclusion = failure` iff `result.exit === 1`; a failing kind at exit 0 (warn)
→ `neutral` (visible, non-blocking); a pass/vacuous → `success`; `off` →
`neutral`. `neutral`/`success` both satisfy a required check; `failure` blocks.

Posting on **every** returned outcome — including `off` and vacuous — is
deliberate: a required App check must report on every run or it bricks merges
(an absent required check stays pending). A `neutral`/`success` run under
`off`/vacuous carries **no** memo record, so it does not contradict spec §8's
"`off` neither reads nor writes memos" — that is about *records*, not the
verdict channel. **`cannot-evaluate` is not in the table**: the CI form is
fail-closed (`failClosed: true`), so it throws before returning a result — the
CLI exits 3 and posts nothing, leaving the required check pending (merges
block). That is the intended fail-closed-availability posture (setup doc, "What
can go wrong").

**Best-effort + warning.** `postVerdict` throwing never changes the verdict or
exit code. On a throw the CLI emits a warning:

- **pass path:** *"could not record the derivation memo (`<reason>`); this pass
  is not durable — re-runs will re-resolve against the registry (§7 drift)."*
- **non-pass path:** *"could not post the verdict check run (`<reason>`)."*

Warning sinks: stderr (always); a GitHub Actions `::warning::` annotation when
`GITHUB_ACTIONS` is set; and a `warnings: string[]` field on the `--json`
report. A missing App check remains fail-closed via branch protection (the
required check stays pending → merges block), exactly as the setup doc's "What
can go wrong" section states.

**Local forms never post.** `prepush` / `check --staged` hold no writer
credential and never call `postVerdict`. They construct a **read-only** memo that
consults only when `--pr <n>` is passed (and a token is ambient); otherwise the
memo is a null-object and they derive live. No PR auto-discovery in v1.

## 5. CLI and action contract

- **`--pr <number>`** — new option on `check`. Enables consult (PR-commit
  enumeration). Optional; absent → no consult context (miss). The anchored
  workflow passes `github.event.pull_request.number`.
- **`LOCKFILE_ASSAY_APP_ID`** — new env var (parallel to `LOCKFILE_ASSAY_TOKEN`),
  read by a new helper in `auth.ts`. Supplies the App's numeric id for the
  security-critical consult filter. The workflow sources it from
  `secrets.ASSAY_APP_ID` (already provisioned by the setup doc). Not secret.
- The existing `--memo-write` + `--staged` incompatibility guard stays (local
  hook forms never write).
- `buildMemo({ write, head, pr, cwd })` → `{ memo: MemoHook, backend: Backend |
  null }`. `write` false (local) → read-only adapter; missing token/repo/app-id/
  pr → null-object memo. The CI form uses `backend` for `postVerdict`.

**Files updated for the contract:**

- `action.yml`: add `pr` and `app-id` inputs; fix the stale `memo-token`
  description ("Contents: write on the memo branch" → "Checks: write, from the
  dedicated App"); pass `--pr` and `LOCKFILE_ASSAY_APP_ID` through.
- `examples/lockfile-assay.yml`: pass `--pr ${{ github.event.pull_request.number
  }}` and `LOCKFILE_ASSAY_APP_ID: ${{ secrets.ASSAY_APP_ID }}`.
- `docs/setup-github-app.md`: document both inputs where the workflow is shown.

## 6. Load-bearing invariants (spec §8)

- Consult produces **pass or miss, never a failure**. A mismatch is **never**
  memoised. Every read error / malformed record degrades to a miss.
- Every write is **best-effort**: it never fails the check; it warns on failure.
- Records live only in **success** check runs; consult reads records only from
  success runs, filtered to the App id.
- A memo **hit** skips the derive *and* the toolchain-skew pre-check (the pinned
  pnpm rides inside the staged manifest and is part of the key).
- `off` evaluates nothing — neither reads nor writes.
- Trust-path discipline: `memo/` imports no `report/` and no `yaml`; the
  extended `import-graph.test.ts` enforces both.

## 7. Tests (spec §13 "three rings")

**Unit — the adapter's trust boundary (`src/memo/store.test.ts`), faked
`Backend`:**

- hit short-circuit (matching epoch + inputsHash + derivedHash → provenance);
- stale-record fallthrough (inputsHash matches, derivedHash ≠ committed → miss);
- mismatch is never memoised (record not built/posted on a non-pass — asserted
  via the poster, since `record()` isn't called on mismatch);
- epoch isolation (a record under a different epoch → miss);
- malformed / garbled record → miss (never a false pass);
- verdict conclusion mapping table (`(outcome, exit)` → conclusion), including a
  failed `postVerdict` → warning, verdict unchanged.

**Integration — adapter + real transport against a faked Checks-API HTTP server
(`test/integration/memo.test.ts`):**

- hit short-circuit with the registry killed (proves no live re-roll);
- **append survival**: a record on an earlier commit in the current chain is
  found → hit;
- **force-push survival**: a record on a force-pushed-away head — reachable only
  via the timeline before-SHA the fake serves — is found → hit;
- stale-memo fallthrough (live re-derive + fresh record on success);
- mismatch never memoised;
- epoch isolation;
- duplicate records from concurrent runs read as equivalent.

**Guard + helpers:** `import-graph.test.ts` extended (`memo/ ↛ report/`);
`checks-api` embed/parse round-trip + malformed-input unit test; `auth.test.ts`
extended for the app-id reader.

Keep green throughout: `pnpm lint && pnpm typecheck && pnpm build &&
pnpm test:unit`, plus `pnpm test:integration`.

## 8. Validation spike (before merge — spec §8, needs collaboration)

App / environment / ruleset creation is UI-only, so this is done with the user
on a scratch repo, and findings captured in a spike doc. Prove:

1. A deployment-branch-restricted Environment **admits** `pull_request_target`
   runs and **refuses** `pull_request` ones — including a workflow the PR itself
   adds.
2. An App-pinned required check **refuses** a same-named `GITHUB_TOKEN` check.
3. Check-run **immutability**: only the creating App can update its runs.
4. In-workflow **installation-token minting** (`actions/create-github-app-token`).
5. **consult/write mechanics**, including equivalent duplicate records from two
   concurrent runs.
6. **Exact list-endpoint shape**: does `GET …/commits/{sha}/check-runs` return
   `output.summary` (and `output.text`) in the list, or is a per-run `GET`
   needed? Confirm the `app_id` + `check_name` query filters behave as assumed.
   (Adjust the transport's `listRecords` if a per-run GET turns out necessary —
   the `Backend` interface is unaffected.)
7. **Force-push discovery**: that `HeadRefForcePushedEvent.beforeCommit.oid` is
   available via GraphQL; that a check run on an orphaned (force-pushed-away,
   not-yet-GC'd) commit stays listable by SHA; and roughly how fast GitHub GCs
   such commits (bounds the survival window). If GraphQL proves unworkable,
   fall back to an alternate head-SHA source (e.g. Actions run associations) —
   `listRecords` changes, the `Backend` interface does not.

The code is fully developable and unit/integration-testable against the faked
Checks API without any live infra; the spike validates the infra chain, which is
orthogonal to the code logic.

## 9. PR structure (refactor-bookended)

To be finalized by the writing-plans step. Expected shape: a small refactor
bookend that threads the head SHA and a `record`/`memoWritten` seam cleanly
through `CheckResult` (pure, behaviour-preserving), then the feature (transport,
adapter, verdict channel, contract, tests). Kept green at each commit. The
dogfood re-adoption (running the published `setup-github-app.md` from a clean
slate) is an explicit **follow-up**, not this feature.
