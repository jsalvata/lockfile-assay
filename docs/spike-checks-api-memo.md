# Validation spike — anchored Checks-API memo

Spec §8 mandates a pre-adoption spike proving the anchored chain on live GitHub.
Run 2026-07-14 on a throwaway repo (`jsalvata/lockfile-assay-spike`): a minimal
pnpm workspace in `enforce` mode, guarded by a **verbatim** copy of
`examples/lockfile-assay.yml` running the **published** action
(`jsalvata/lockfile-assay@v1.0.1`) under a dedicated Checks-R/W App
(id `4293435`, slug `lockfile-assay`) whose credentials live on a
`main`-restricted Environment. Every claim below was observed against real
GitHub, most through the real published code path.

## Verdict: all items confirmed

| # | Claim | Result |
|---|---|---|
| 1 | Environment admits `pull_request_target`, refuses `pull_request` | ✅ confirmed |
| 2 | App-pinned required check refuses a `GITHUB_TOKEN` check | ✅ mechanics confirmed |
| 3 | Only the creating App can update its check run | ✅ confirmed (two identities) |
| 4 | In-workflow installation-token minting | ✅ confirmed |
| 5 | consult/write + duplicate equivalence + re-embed-on-hit | ✅ confirmed |
| 6 | The check-runs *list* returns `output.summary` (no per-run GET) | ✅ confirmed (read-only + live) |
| 7 | Force-push survival via GraphQL `beforeCommit` | ✅ confirmed |

### Bug the spike caught (before adoption)

`v1.0.0`'s `action.yml` embedded `${{ github.* }}` in three input
**descriptions**. GitHub evaluates `${{ }}` at action-**load** time, where the
`github` context is unavailable, so **every `uses: jsalvata/lockfile-assay@v1.0.0`
failed to load** (`Unrecognized named-value: 'github'`). The repo's CI runs
`node dist/cli.js` and never loads `action.yml`, so it shipped clean — the spike
is the first thing that actually `uses:`d the action. Fixed in v1.0.1 (#10) with
a regression guard (`src/action-yml.test.ts`).

## Evidence

**Item 4 + 5-write** — the anchored `pull_request_target` run minted the App
token and posted the verdict as a check run **under the App** (`app_id 4293435`,
`conclusion success`, title `lockfile-assay: pass`) with the memo record embedded
in `output.summary`:

```json
{ "epoch":1, "inputsHash":"c1163db5…", "derivedHash":"1e67c936…",
  "toolVersion":"1.0.1", "pnpmVersion":"10.34.1", "timestamp":"2026-07-14T11:46:57.453Z" }
```

**Item 6** — read-only, the check-runs *list* endpoint returns
`output.summary`/`output.text` byte-identical to a per-run GET (verified on two
unrelated public Apps: vite/`pkg-pr-new` 23+736 chars, uv/`codspeed` 1081 chars).
Live, the record above was read straight from the **list** response — so
`listRuns` needs no per-run GET.

**Item 5-consult (the headline)** — a source-only push (README only; git trees
byte-identical) moved the head SHA with `inputsHash` unchanged. The next run
returned `outcome: pass`, `memo.hit: true`, `derivedAt: 2026-07-14T11:46:57.453Z`
— the *original* record's timestamp, i.e. the real `listRuns` found the earlier
commit's record and passed **without re-deriving**. The hit run also **re-embedded**
the same record on the new head (review #4 — GC mitigation), verified identical.

**Item 7** — the branch was squashed and force-pushed (both prior commits
orphaned; new tree byte-identical, `790ae8a`). The run still hit
(`derivedAt` unchanged) — the record was reachable **only** via the GraphQL
`HeadRefForcePushedEvent.beforeCommit` path, and the orphaned commit's check run
was still listable by SHA. *GC window:* immediate listability confirmed; how long
GitHub keeps an orphaned commit reachable is GitHub-internal and only **bounds**
survival — a GC'd commit is a safe miss (live re-derive), never a false pass.

**Item 3 (immutability)** — a non-App identity (user token) PATCHing the App's
verdict: `403 "You must authenticate via a GitHub App."` A **different App**
(github-actions `GITHUB_TOKEN`, `app_id 15368`) PATCHing it:
`403 "Invalid app_id 4293435 - check run can only be modified by the GitHub App
that created it."` The verdict stayed `success` in both cases.

**Item 2 (mechanics)** — a same-named `lockfile-assay` check posted with the
Actions `GITHUB_TOKEN` carries `app_id 15368` (`github-actions`), **not** our App
`4293435`. So both the adapter's consult `app_id` filter and a branch-protection
required check *pinned to the App identity* exclude it. (Pinning the required
check to the App is the adopter's config step, `setup-github-app.md` §5; the
identity distinction that makes it work is what the spike confirms here.)

**Item 1 (environment gating)** — a PR that **added** a `pull_request` workflow
referencing the `lockfile-assay` environment and trying to echo
`ASSAY_APP_PRIVATE_KEY` ran **zero steps**: GitHub refused it at the environment's
deployment-branch policy (the PR ref is not `main`) before any step executed, so
the secret was never exposed. The anchored `pull_request_target` workflow (the
base branch's definition) ran normally alongside it. A PR cannot add a
`pull_request_target` workflow that triggers — only base-branch definitions run.

## What this establishes

The three server-enforced facts the design rests on all hold: (1) the
branch-restricted Environment keeps the writer credential unreachable from
PR-editable definitions; (2) check-run authorship is server-set and immutable to
every non-creating identity; (3) the memo record rides in the verdict check run
and is read back from the list, filtered to the App id — unforgeable. The memo's
own mechanics (write, consult-hit, re-embed, force-push survival) work end-to-end
through the published code. The anchored form is safe to adopt (dogfood
re-adoption via `setup-github-app.md`).
