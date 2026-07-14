# lockfile-assay — specification

*Prove your lockfile is untampered.*

A CI gate that proves a pull request's lockfile is **honest**: exactly the file the
repo's own package manager derives from inputs a human reviewer can actually read.
Byte-for-byte, fail-closed, anchored where the PR cannot switch it off.

**Status:** founding spec for **v1** — semantics settled 2026-07-04: the open
questions are resolved in §12 and the implementation design is §13. Drift *prevention*
(§8) ships with v1: its local-checking piece (`prepush`, `check --staged`, hook
wiring) and its durable-verdicts piece (the derivation memo) are specified below;
quarantine-window guidance remains open.

---

## 1. The problem

Every JavaScript CI pipeline runs a frozen install (`pnpm install --frozen-lockfile`
or its equivalents) and treats success as proof that the dependency tree is what the
PR claims. It is not proof. A frozen install verifies that the lockfile's *importers*
match the `package.json` specifiers, then trusts the rest of the file wholesale — the
transitive dependency graph and every `resolution:` entry. And no human backstops that
trust: code hosts collapse lockfiles as generated, and nobody expands thousands of
lines of YAML in review.

The result is an **unreviewed write channel into `node_modules`**: anyone who can get
a PR merged — a compromised maintainer account, a malicious insider, a subverted
coding agent — can edit the lockfile so that CI installs, tests green, and ships code
that appears in no diff a reviewer read.

### 1.1 Attack shapes

| Attack | Frozen install | Human review | This check |
|---|---|---|---|
| A legit package's registry resolution swapped for a `tarball:` URL (attacker code runs on import) | installs it | never reads the lockfile | byte mismatch — an honest re-resolve never emits the URL entry |
| Phantom edge injected into a snapshot's `dependencies` | installs it | never reads it | byte mismatch — the edge has no honest origin |
| Integrity lie for a real `name@version` | install *fails* (the registry serves the real tarball; hash mismatch) | — | byte mismatch (defense in depth) |
| Within-range **version-choice games** (pinning a real but vulnerable older version the ranges admit) | installs it | manifest visible; the lockfile *choice* is not | byte mismatch — the honest derivation makes its own choice; **no surveyed alternative closes this channel** (§10) |
| Registry redirect via `.npmrc` / workspace config | n/a | **visible diff** — review's job | passes by design (§3 stages head's config) |
| Malicious *fresh release* of a real in-range package | installs it (unless quarantined) | — | out of scope — registry-content trust (§1.2); mitigated by registry-side and package-manager policies (§10) |

### 1.2 Trust posture

Fail-closed, downside-bounded: every uncertainty degrades to a blocked or flagged PR,
never to a silent pass. The check proves **derivation**, not **goodness**: it does not
vet what the registry serves. A malicious-but-real package added to `package.json` is
review's problem — it is *visible*. The assay's job is to guarantee that the visible
diff is the *whole* story.

---

## 2. The claim

After a pass:

> **The committed lockfile is exactly what the repo's own package manager derives from
> the files a reviewer can read** — the manifests and committed configuration —
> against the registry those files name, at check time.

This moves the trust boundary off a generated file nobody reads and onto the diff
humans already review. A registry redirect, a new dependency, a changed range — all of
those remain possible, and all of them are small, visible, reviewable changes. What
becomes impossible is the lockfile adding *anything* beyond them.

Because the check is deterministic given (base tree, head tree, registry state) and is
anchored outside the PR's control (§6), downstream automation — merge queues,
auto-approval bots — can treat a green check as a machine-verified guarantee that the
lockfile carries nothing the visible diff didn't state.

---

## 3. The check

**Trigger.** The PR's **net base→head** diff touches the lockfile or any resolution
input: `pnpm-lock.yaml`, any `package.json` (any at all — over-triggering is safe,
under-triggering never is), `.npmrc`, `pnpm-workspace.yaml`, `patches/`, any path
named by `patchedDependencies`, and any `.pnpmfile.*` (so the PR that introduces
executable resolution hooks reaches the preflight refusal below rather than passing
vacuously). PRs that touch none of these are out of scope and pass vacuously —
decided from one `git diff --name-only`, before config is read.

**Staging.**

| Input | Taken from | Why |
|---|---|---|
| `pnpm-lock.yaml` | **base** | the reviewed prior state; as pnpm's resolution cache it keeps every still-satisfying locked version pinned, so only changed and new edges resolve fresh |
| every workspace `package.json`, `.npmrc`, `pnpm-workspace.yaml`, the patch files `patchedDependencies` declares (conventionally `patches/`) | **head** | the visible, reviewable inputs — a registry redirect here is review's job, not the assay's |
| package manager | head's `packageManager` pin | must name pnpm with a version; honored by corepack and by pnpm ≥ 10 self-management |

Staging is always whole-workspace: every importer's manifest is materialized even when
only one changed — the lockfile is a single whole-workspace artifact with coupled
shared sections, and base's staged lockfile already narrows the fresh-resolve surface
to exactly the changed specs (§12 Q3). When base has **no** lockfile (the PR that
adopts pnpm), nothing is staged as cache and the derivation runs from scratch —
deterministic per the empirics below — with the byte compare deciding as usual; the
drift surface is then the whole file rather than the changed specs.

**Preflight.** Three head shapes are refused as **unsupported-input** (§5),
v1's fail-closed answer to inputs it cannot honor honestly: a **pnpmfile**
(`.pnpmfile.cjs`, or `pnpmfile`/`ignore-pnpmfile` in config) — executable resolution
hooks; honoring them is roadmap (§11), since it breaks §8's "nothing executes"
argument, not §2's (the file is reviewable diff); **`shared-workspace-lockfile=false`**,
which splits the single root lockfile v1 assumes; and a **non-`package.json` manifest**
(`package.yaml` or `package.json5`, which pnpm also reads) — v1 stages only
`package.json`, so a repo using these would otherwise derive against an incomplete
workspace and mismatch confusingly. A clean refusal beats that; broadening staging to
the other manifest formats is roadmap (§11).

**Invocation.** In an isolated copy of the staged tree:

```
pnpm install --lockfile-only --ignore-scripts --prefer-frozen-lockfile --ignore-pnpmfile
```

`--lockfile-only` writes no `node_modules` and fetches no tarballs; `--ignore-scripts`
keeps package code inert; `--ignore-pnpmfile` is belt-and-braces — a pnpmfile already
failed preflight, and the flag keeps "nothing executes" true even if detection missed
a variant (inert in supported repos, which is why §4's author-side recipe need not
carry it). Before resolving, the effective `pnpm --version` is compared
against the pin: a disagreement fails as **toolchain-skew**, its own finding with its
own remedy — never conflated with a resolution mismatch.

**Compare.** Whole-file **byte equality** between the re-derived lockfile and head's
committed `pnpm-lock.yaml`.

**Why bytes, not a semantic compare.** Byte equality has zero parser-differential
surface — a crafted lockfile cannot parse one way for a comparator and another way for
pnpm, because there is no comparator-side parse in the trust path. And pnpm's
serializer is canonical, so bytes don't flake by themselves. Verified empirically
(2026-07-04, pnpm 9.12.0 and 10.34.1), pinned as integration tests (§13):

- two independent from-scratch resolves of the same manifest are byte-identical;
- re-running the install above on a repo's **committed** manifest reproduces its
  **committed** lockfile byte-for-byte — the checker path reproduces whatever the
  author committed, *however* the author edited the manifest. (This is the property
  the check relies on, and it is what the author↔checker agreement means. Note that
  two *different* author actions need not agree at the byte level: `pnpm add
  pkg@range` on pnpm ≥ 10 rewrites the saved specifier to the caret of the resolved
  version, so it differs from a hand-edit by that one `specifier:` line — irrelevant
  to the check, which always re-derives from the committed manifest, not from a
  hypothetical alternative edit.)
- re-running install on an in-sync tree rewrites nothing (idempotent);
- locked versions that still satisfy their (possibly changed) ranges are **reused**,
  not re-resolved — only specs whose floor moved above base's lock, and edges new to
  the tree, resolve fresh. That fresh surface is the drift residual (§7).

**Why the net diff, not per-commit.** Intermediate lockfile states inside a PR are
installed by no one; only the merged result ships. Per-commit checking would flag the
routine "fix the lockfile in a follow-up commit" pattern for no security gain.

**Why base's lockfile.** Staging the reviewed prior state as the resolution cache is
what turns regeneration into an honesty check. Regenerating from the *committed*
lockfile — the naive "install and `git diff`" — preserves tampered entries, because
the resolver treats them as already locked. Regenerating from *base* forces every
entry the PR changed to justify itself as a fresh, honest derivation.

Match → pass; no further findings. Mismatch → §4.

---

## 4. Mismatch handling

A mismatch conflates **tampering** (content re-resolution cannot derive) with honest
**drift** (the inputs to re-resolution moved — §7). The assay treats them
identically: same mode-level verdict (§5), same remedy — **refresh**, verbatim:

```sh
git show <base>:pnpm-lock.yaml > pnpm-lock.yaml   # restore the reviewed prior state
pnpm install --lockfile-only --ignore-scripts --prefer-frozen-lockfile
git add pnpm-lock.yaml && git commit              # or --amend, as fits the branch
```

(the report substitutes the real base ref; when base had no lockfile, restoration
becomes deletion — `rm pnpm-lock.yaml` — before the re-resolve). Restoring base's
lockfile first is load-bearing, not ceremony: re-running the install on the committed tree is a no-op —
pnpm reuses every locked entry that still satisfies its range (§3 empirics), drifted
and tampered entries alike — so the naive "just `pnpm install`" refreshes nothing.
Staged from base, every entry the PR changed must re-derive honestly, which is what
makes the remedy self-healing: refreshing a tampered lockfile replaces the poison with
the honest re-derivation, so even a reflexive "just refresh it" response converges to
a safe lockfile.

There is deliberately no automated *alarm* — no machine judgment that a mismatch was
an attack rather than drift. The failure report hands that judgment to the human
reading it:

**The failure report contract** (required, not cosmetic — it carries the judgment a
classifier would have automated):

- a bounded **diff excerpt** of committed vs re-derived lockfile (default bound: 100
  lines, middle elided) — a version delta reads as drift; a `tarball:` URL or a novel
  edge reads as an attack;
- a **per-package delta summary** (committed vs re-derived version for each
  disagreeing package), computed by parsing the two lockfiles locally — **no registry
  queries**; this is also the interface drift-prevention tooling consumes (§8);
- the **refresh recipe**, verbatim;
- **toolchain-skew** reported as its own failure, with the pinned and effective
  versions.

### Rejected alternative: a registry-truth triage tier

The obvious extension is a classification pass on mismatch: validate each disagreeing
entry against the registry (resolution-shape legality, integrity equality for the
exact `name@version`, graph consistency against the real packages' manifests, importer
equality, reachability), label the mismatch **drift** (all entries honest) or
**tamper** (anything else), and soften the drift verdict. **Rejected 2026-07-04 —
this project will not build it.** Reasons:

- **Zero added detection.** Byte-equality already fails closed on every deviation; a
  classifier would only relabel failures. Its entire payoff assumes drift is *common*
  — it exists to keep an enforcing gate liveable amid frequent honest mismatches.
- **Drift is better addressed at the source** (§8: keep honest lockfiles byte-stable
  and check them while fresh), which removes that payoff. A classifier for a rare
  event is machinery without a customer.
- **Its hardest sub-problem buys nothing.** Re-deriving the legal peer-suffix set
  without running the resolver is the bulk of the subtlety — all of it in service of
  the relabeling.
- **It would introduce a subtle leniency.** The drift class softens the verdict for
  any mismatch whose entries are individually registry-true — exactly the shape of a
  within-range version-choice attack (§1.1). With no lenient class, under `enforce` a
  chosen resolution that differs from the honest derivation simply does not merge.

Costs accepted with the rejection: no automated tamper alarm (mitigated by the report
contract above), and no registry-audit machinery that could double as an enablement
baseline scan (§9).

---

## 5. Configuration, CLI, verdicts

**Configuration** lives in `.lockfile-assay.json` at the repo root and is read from
**base** — a PR cannot reconfigure the check that polices it; changing the mode
requires a separately reviewed PR that lands first.

```json
{ "mode": "enforce" }
```

`"mode": "off" | "warn" | "enforce"`, default `off` (nothing is auto-enabled). A
malformed config in base — unparseable JSON, unknown `mode` — is exit `2`, with the
report noting that the config broke on an earlier merge, not in this PR.

**CLI.**

```
lockfile-assay check --base <ref> --head <ref> [--json]
lockfile-assay check --staged [--json]            # commit-time form (§8)
lockfile-assay prepush [--base <ref>] [--json]    # push-time form (§8)
```

| Outcome | `off` | `warn` | `enforce` |
|---|---|---|---|
| byte match | not evaluated (exit 0) | pass (exit 0) | pass (exit 0) |
| mismatch | not evaluated (exit 0) | exit 0, **warning report** emitted | **exit 1**, failure report |
| toolchain-skew | not evaluated (exit 0) | exit 0, warning report | **exit 1**, failure report |
| unsupported-input (§3 preflight) | not evaluated (exit 0) | exit 0, warning report | **exit 1**, failure report |

Exit `2` — malformed invocation: unresolvable refs, no pnpm pin, malformed base
config. A missing lockfile in base with one present in head is **not** malformed: the
check runs from scratch (§3) and the bytes decide. The mirror — a lockfile deleted in
head while base keeps one — is a fail-closed **mismatch** whose report names it. Exit
`3` — internal error, including resolver or network failure in the CI form: an
evaluation that cannot complete fails red in any mode, never silently (the local
forms instead degrade to a notice, §8). `--json` emits the machine report
(`schemaVersion: 1`): outcome, mode, per-package delta summary, diff excerpt, pinned
and effective toolchain versions, memo provenance — the seam for CI annotation
layers; `prepush --json` wraps per-tip reports in one `{schemaVersion, tips: []}`
document.

**The report's `mode` is not the config's `mode`.** Beyond the three settings it
also carries `"unknown"`, meaning *no mode was determined* — the evaluation
short-circuited before the config read (a vacuous pass; a local form with no base to
read from). A consumer must not collapse `unknown` into `off`: `off` says the repo
disabled the assay, `unknown` says the question never came up. Emitting `off` there
instead — as the vacuous-pass path once did — reads to an adopter as "my config is
being ignored", and cost the first one a long detour.

Under `warn`, a mismatch never breaks the build; surfacing the warning (PR comment,
check-run annotation) is the CI wiring's job, driven by the `--json` report.

The local forms (`--staged`, `prepush`) share this verdict table; how they derive
their refs and degrade when evaluation is impossible is §8's.

---

## 6. CI integration and anchoring

The intended deployment is a **required status check** on the protected branch,
running `lockfile-assay check --base <merge-base> --head <head>` with `enforce`
read from base config.

**The anchor caveat.** Any check is only as strong as what prevents the PR from
editing its wiring. The mode knob is safe (read from base), but a workflow file is
repo content like any other — and a same-repo `pull_request` workflow runs the
definition **from the PR head, with secrets, at open time**, before any review. A
required status check gates *merging*, not *running*; by itself it cannot stop a PR
from rewriting its own gate. This is a property of CI-based enforcement in general,
not of this tool; it is named here so nobody mistakes an unanchored required check
for more than it is.

**The anchored form** dissolves the caveat with server-enforced facts — no external
service required. The check runs from a workflow triggered on
**`pull_request_target`**, which executes the **base branch's** workflow
definition: a PR can neither edit the definition that runs (its edits are not on
base) nor smuggle in a replacement (a `pull_request_target` workflow added by a PR
is not on base and does not trigger). The verdict is posted as a **check run under
a dedicated GitHub App** (§8), and branch protection requires that check **from
that App's identity** — a same-named check posted via a PR job's self-granted
`GITHUB_TOKEN` reports from the built-in Actions identity and cannot satisfy the
requirement. The App's credentials live on a GitHub Environment whose
deployment-branch policy admits only base-context runs, so no PR-reachable job can
mint its token. Running the check privileged is safe because §3 keeps PR content
inert — no scripts, no tarballs, nothing executes; the anchored workflow must
preserve that property: check out the base, read head content as git data only,
invoke a pinned published assay, and execute nothing from the head tree.
`docs/setup-github-app.md` walks the setup.

**The workflow's own supply chain.** The anchor's facts are server-enforced, but the
*steps* that carry them are not: a workflow is a list of third-party actions, and
`uses: foo@v4` names a **git tag**, which is mutable. Whoever can move that tag
substitutes new code into a job that already holds the credentials — and in this
workflow one of those actions (`create-github-app-token`) *mints the App token whose
identity the whole argument above rests on*. "Only the creating App can update its
runs" stays true; it simply stops being a constraint on an attacker who can mint that
App's token, and forged verdicts follow. This is the same trust the assay refuses to
extend to a lockfile — a range is not a pin — so the workflow must not extend it
either. Every third-party action is therefore pinned by **commit SHA**, which is a
content hash and cannot be repointed; `src/workflow-pins.test.ts` fails the build if
one reverts to a tag, and Dependabot keeps the pins from freezing onto stale code.

The one exception is the assay's own action, which cannot self-pin: its tag is
rewritten during the release that creates it, before that commit's SHA exists
(`docs/RELEASING.md`). Its integrity therefore rests on the tag being immutable,
which a repository ruleset enforces — `refs/tags/v*`, update/deletion/non-fast-forward
restricted, no bypass actors — making it server-enforced like the rest of the anchor.
That ruleset is a standing obligation on this repo, not an optimisation: the code the
action *executes* is pinned a second time by the exact npm version inside `action.yml`,
but that second pin is only as trustworthy as the `action.yml` the tag resolves to.
Weaken the ruleset and the npm pin silently stops meaning anything.

**Prerequisites.** The job needs registry reachability and credentials for every scope
the lockfile resolves (private registries included), and the pnpm version pinned by
`packageManager` (corepack or pnpm ≥ 10 provide this from the pin itself).

The check trusts its runtime the way it trusts the pnpm binary itself: runner-level
configuration (a user `~/.npmrc`) supplies credentials — and can supply registry
settings wherever committed config names none. That surface belongs to whoever
operates CI, not to the PR; provision runners accordingly.

---

## 7. Determinism and drift

The check is deterministic given (base tree, head tree, registry state): pnpm's
resolver reuses every locked, still-satisfying version from the staged base lockfile
and its serializer is canonical (§3 empirics). What it is **not** is time-invariant.
Two residuals, both fail-closed:

- **Registry drift.** Specs the resolver must fetch fresh — a changed spec whose floor
  moved above base's locked version, or an edge new to the tree — resolve to the best
  candidate *at check time*. A new in-range publish between the author's resolve and
  the check yields a byte mismatch on an honest PR. The surface is narrow (fresh
  specs only; everything already locked and satisfying is immune) but real, and it
  grows with the delay between authoring and checking.
- **Base drift.** Rebases and merge queues re-stage the check against a *newer* base
  lockfile. A head lockfile derived from the old base can then mismatch with zero
  registry movement — the staging inputs themselves moved. The remedy is the same
  refresh, performed on the rebased branch.

Both residuals block honest PRs when they fire; neither ever passes a dishonest one.
Keeping them *rare* is §8's job:

---

## 8. Drift prevention — checking where the author still is

Both §7 residuals grow with the delay between the author's resolve and the check. The
cheapest prevention is not new machinery but **the same check, run earlier** — at push
time and at commit time, on the machine where a refresh costs seconds and no CI
round-trip — and, once a trusted run has evaluated a given input set, **never re-rolled**
(the derivation memo, below). This section specifies the local forms and the memo; the
quarantine-window direction at the end remains open.

**Local runs are a courtesy preview, not a gate.** The anchor stays in CI (§6). Two
consequences, both deliberate:

- **Verdicts match §5.** Mode is read from base exactly as in CI, so a local run
  *predicts* the required check rather than second-guessing it: `off` evaluates
  nothing, `warn` reports and exits 0, `enforce` blocks the commit or push. There is
  deliberately no local-only strictness override (hooks at `enforce` while CI sits at
  `warn`) — YAGNI until warn-stage data argues otherwise (§12 Q5).
- **Cannot-evaluate degrades to a notice, not a block.** No reachable registry, no
  derivable base — the local forms say why and exit 0. Fail-closed is the anchored
  check's discipline; a hook that bricked offline commits would just get uninstalled,
  and the required check still gates the merge.

### Push time — `lockfile-assay prepush`

```
lockfile-assay prepush [--base <ref>] [--json]
```

`check` (§3) with its refs derived from push context, plus a fast path:

- **Tips.** As a git `pre-push` hook, the pushed tips are read from the ref lines git
  supplies on stdin (`<local-ref> <local-sha> <remote-ref> <remote-sha>`,
  githooks(5)); ref deletions (all-zero local sha) push nothing and are skipped.
  Standalone — no ref lines — the tip is `HEAD`.
- **Base.** Per tip: the merge-base with the remote default branch (`origin/HEAD`),
  which is what the PR's required check will use; `--base` overrides. The ref line's
  remote sha is deliberately *not* the base — the pushed branch's own previous state
  predicts nothing about the PR verdict.
- **Fast path.** If the net base→tip diff touches no resolution input (§3 trigger),
  the tip passes vacuously: one `git diff --name-only`, no config read, no network.
  Ordinary pushes cost milliseconds.
- Each tip is checked independently; `--json` emits one report per evaluated tip,
  wrapped in the single `{schemaVersion, tips: []}` document (§5). A failure prints
  §4's report — refresh recipe included — and, under `enforce`, exit 1 aborts the
  push.

What this buys: the registry-drift window (§7) shrinks from author→CI (hours to days)
to push→CI (minutes), and **base drift is caught at the rebase** — re-pushing a
rebased branch re-derives against the new merge-base before CI ever sees it.

### Commit time — `lockfile-assay check --staged`

```
lockfile-assay check --staged [--json]
```

Head is the **index tree** — exactly the content of the pending commit — and base the
merge-base with the remote default branch, as above (§3's staging reads the same
files whether head is a commit or the index). The **trigger is the staged
increment**, `HEAD` → index: a commit that stages no resolution input passes
vacuously at ~0 cost, even mid-branch on a dependency-bumping PR; the commit that
does stage one gets the full net-diff check.

Why a commit-time hook when push time is already covered: **timing turns the mismatch
into a signal.** At commit the author's resolve is typically seconds old — registry
drift needs time it has not had — so a `--staged` mismatch is rarely drift. It is
toolchain skew, a hand-edited lockfile, or tampering: the subverted-agent shape of
§1.1, caught on the machine where the bytes were made, before they enter history.
This recovers most of what the rejected triage tier (§4) would have bought — by
moving the check to a moment that excludes drift, instead of building machinery to
subtract it. The judgment stays human (§4), but at this hook a mismatch deserves
reading, not a reflexive refresh.

### Hook wiring

With [husky](https://typicode.github.io/husky/) (any hook manager works — these are
plain git hooks):

```sh
# .husky/pre-commit
pnpm exec lockfile-assay check --staged
```

```sh
# .husky/pre-push
pnpm exec lockfile-assay prepush
```

- **Cost.** ~0 unless the commit or push actually carries resolution-input changes;
  then one `--lockfile-only` resolve, needing the same registry reachability and
  credentials as authoring the change (§6).
- **Escape hatch.** Git's native `--no-verify`, on either hook. Skipping a courtesy
  preview changes nothing about the required check.
- **No agent-tier hook.** Coding agents commit and push through git, so these hooks
  fire for them unchanged; a tool-level guard (e.g. a Claude Code `PreToolUse` hook
  on `git push`) would duplicate the pre-push hook without adding an anchor, and is
  deliberately not part of this design.

### Durable verdicts — the derivation memo

The local forms shrink the drift *window*; the memo removes drift *re-rolls*. Today
every evaluation re-resolves: a dependency-bumping PR that keeps receiving
source-only pushes stages the identical resolution inputs on every CI run, and each
run is a fresh roll of the §7 dice — as are re-runs of a flaky workflow and
merge-queue re-validations. A pass can silently decay into a mismatch with nothing
about the PR's dependency change having changed.

It need not, because a pass is a statement about exact bytes — *these staged inputs
derive this lockfile* — and that statement cannot rot: a published `name@version` is
immutable and "best candidate at check time" only moves forward, so a forged
lockfile never becomes derivable and an honest derivation never becomes a forgery.
The **first** trusted evaluation of a given input set is the right observable;
re-evaluating the identical set later asks a strictly worse question. The memo is
not a cache bolted onto the check — it is the check's correct temporal semantics.

**The record.** Key: `(epoch, inputsHash)` — SHA-256 over the exact bytes staged per
§3 (base's lockfile; head's manifests, config, patches; the invocation), in a fixed
order. Value: the derived lockfile's SHA-256, the assay and effective pnpm
versions, a timestamp. Content-keying rather than ref-keying is the point: a merge
queue whose target branch advanced without touching resolution inputs, a re-run on
the same pair, a push that changed only source files — identical bytes, memo hit, no
registry roll. A rebase that moves base's lockfile misses and re-derives — correct:
§7's base drift is a genuinely different derivation. (The `packageManager` pin rides
inside a staged manifest, so the pnpm version is implicitly part of the key. A memo
**hit** therefore skips the §3 skew pre-check — no derivation runs, so the runner's
live toolchain is irrelevant; the remembered pass was minted under the pinned
toolchain, which is part of the key. The skew pre-check runs only on the live-derive
path, per §13's flow.)

**Consult — the memo may only short-circuit to a pass.**

1. Hash the staged inputs.
2. Hit, and the memoised derivation hash equals the committed lockfile's hash →
   **byte match**, registry untouched. The pass report discloses provenance
   (`memo: { hit, derivedAt, toolVersion }`) — unnecessary for the verdict but nearly
   free, shipped as diagnostics (§12 Q7), so a green check says whether it resolved
   live or served a remembered derivation.
3. Otherwise resolve live — §3 exactly, today's behavior. A match writes (or
   refreshes) the memo — from the anchored CI form only; the local forms never write.
4. A mismatch is handled per §4 and is **never memoised** — transient resolver
   failures and registry movement must not stick.

Step 3 makes the memo unable to create failures: a stale entry — same inputs, head's
lockfile since honestly re-authored after the registry moved — falls through to a
live resolve and refreshes itself on success. Step 2 is where re-rolls die.

**Epoch — revocation shipped with the validator.** Memos are keyed under an integer
constant in the assay's source, bumped only when a fix means earlier releases may
have *wrongly passed* — a hole, not a tightening. Keying on the tool version instead
would flush every open PR's memos on every release for no reason; holding the epoch
in configuration reintroduces rollout skew (a stale binary happily writes under a
bumped config value). A source constant makes epoch and check semantics one
artifact: a binary cannot write under an epoch it does not know. The bump is a
release-checklist item — the failure mode of forgetting is silent; when in doubt,
bump, since the cost is one round of live re-derivation across open PRs,
fail-closed. Records carry the writing version and timestamp regardless: after an
incident, "every pass minted by ≤ vX" is one query over the store, which is also why
old-epoch records are never pruned.

**The store — writes are the trust boundary.** The adversary is whoever authors the
PR (§1); a memo store the PR's own CI run can write is bring-your-own-verdict:

| Candidate | Why not |
|---|---|
| GitHub Actions cache | evicted (~7 days idle, LRU size cap) — gone exactly when a long-lived PR needs it; and PR-branch runs (author-controlled code) can write their own cache scope — a known poisoning class |
| Check runs / statuses via `GITHUB_TOKEN` | a same-repo author can self-grant `checks: write` from a workflow file, and every `GITHUB_TOKEN` writer is the same indistinguishable `github-actions` identity — the writer fails, not the medium: check runs under a *dedicated App* identity are exactly the chosen store |
| An orphan memo branch, ruleset-restricted to a dedicated App | sound, and previously chosen — but heavier and more fragile than needed: a second permission (Contents: write), a branch and a ruleset to provision, and an ACL whose misconfiguration **fails silent-insecure** (a missing or mistargeted ruleset leaves the branch writable by anyone, with nothing visibly wrong), all to guard records the verdict channel can carry under a server-inherent ACL |
| Signed records (Sigstore, OIDC-bound to the workflow identity) | sound and storage-agnostic — but verification (sigstore-js, TUF roots) enters the reader's trust path, identity policy must pin a workflow ref outside PR reach, and private repos — exactly where the threat lives (§10) — either leak metadata to the public Rekor log or need GitHub Enterprise Cloud's private store. The growth path: GitHub artifact attestations as a second backend behind the store interface, likely the public-repo default later |

Chosen: **the verdict channel itself.** The anchored check posts its verdict as a
**check run** under a dedicated GitHub App (§12 Q6: a named, auditable actor with a
revocable installation), and the memo record — epoch, inputs hash, derived lockfile
hash, tool versions, timestamp — rides in that check run's output. Authorship is
server-inherent: GitHub sets a check run's creating App from the token that made
it, and **only that App can update it** — nothing to provision, no ACL to
misconfigure, no edit surface for collaborators. Consult lists the PR's prior check
runs filtered to the App's identity and matches the recorded inputs hash against
the currently staged inputs; anything else — no match, a lost or unreachable
record — is a miss that falls through to a live re-derive. Concurrent runs on the
same key each post a record; duplicates are equivalent, so there is no write race
to handle. Consult is PR-scoped, foregoing cross-PR hits (two PRs staging identical
inputs each derive live once) — every re-roll the memo exists to kill is same-PR:
source-only pushes, flaky re-runs, merge-queue re-validation. There is no retention
or pruning story: check runs persist with the repo, and a record goes inert the
moment its key moves anyway (base's lockfile advancing, §7). The CLI never mints
App credentials: the anchored workflow mints a short-lived installation token (e.g.
`actions/create-github-app-token`) and passes it in env. The store sits behind a
narrow backend interface (§13), so the backend can change without touching consult
semantics.

The writer credential is unreachable from PR-editable definitions **by
construction** (§6): the anchored workflow's definition comes from base, its
secrets from a branch-restricted Environment, and the required check is pinned to
the App identity. The local forms (`prepush`, `--staged`) hold no writer
credential: they consult read-only via whatever is ambient — env token →
`GITHUB_TOKEN` → ambient `gh` → none — where an associated PR exists, and skip
silently otherwise; record integrity comes from check-run authorship, not from the
reader. They never write; nothing they could hold would let them, since only the
creating App can update its check runs — the design working as intended. Mode
gating is unchanged: `off` evaluates nothing, so it neither reads nor writes
memos.

**Validation spike (pre-implementation, §12 Q6).** Prove the chain on a scratch repo
before the memo lands: a deployment-branch-restricted Environment admitting
`pull_request_target` runs and refusing `pull_request` ones (including from
PR-added workflows); an App-pinned required check refusing a same-named
`GITHUB_TOKEN` check; check-run immutability (only the creating App can update its
runs); in-workflow installation-token minting; and consult/write mechanics,
including equivalent duplicate records from concurrent runs.

**What the memo does not fix.** The *first* evaluation of fresh inputs still races
the registry — that window belongs to `prepush` and `--staged` above. An epoch bump
deliberately re-opens one round of live re-derivation across open PRs. And any real
movement of resolution inputs — including base's lockfile advancing — misses by
construction: §7's base drift, handled by refresh as before.

### Open direction

- **Registry quarantine windows** — pnpm's `minimumReleaseAge` in committed config is
  honored by the assay's own re-resolve (§10), making "best candidate at check
  time" stable across the window; guidance on sizing it belongs here.

The interface pinned for this work is unchanged, and the memo does not alter it: the
**per-package delta summary** of the failure report (§4) — committed vs re-derived
version per disagreeing package, derived by pure lockfile parsing.

---

## 9. Rollout

1. **off** (default) — the tool ships dormant; nothing is auto-enabled.
2. **warn** — collect mismatch rate and human dispositions (refreshed vs
   investigated). The check earns trust here; the drift-prevention work (§8) drives
   the rate toward zero.
3. **enforce** — the gate. Prerequisites: registry access in CI (§6) and a quiet
   warn-mode record.

**Enablement induction.** The first enforced check trusts the lockfile already on the
protected branch as its base state — the assay guards *deltas* from there. It does
not audit history, and (with the triage alternative rejected, §4) it ships no
whole-lockfile baseline scanner; a repo that wants a baseline can lean on pnpm ≥ 11's
install-time integrity checks or an external scanner as a compensating one-time scan.

**The `warn`-stage caveat, named.** Without classification, a real attack during the
warn stage surfaces as a warning report, not a blocked merge. The self-healing refresh
bounds the damage — the poisoned bytes cannot survive anyone acting on the report —
but a repo that ignores warnings keeps them. `warn` is a rollout stage, not a resting
posture.

---

## 10. Prior art

Surveyed 2026-07-04. Partial solutions exist — the wave dates from the 2025–26 npm
supply-chain compromises (Shai-Hulud, Glassworm) — but none re-derives from base and
compares bytes, and none closes the version-choice channel (§1.1).

- **Yarn Berry hardened mode** (`enableHardenedMode`, Yarn 4, 2023) — the nearest
  neighbour. On install it requires every resolution to be a *valid candidate* for its
  range (`--check-resolutions`) and lockfile metadata to match the registry
  (`--refresh-lockfile`). Two gaps this check closes: it accepts **any** range-valid
  registry-true resolution, so version-choice games pass — that leniency is how it
  bought drift immunity, the same trade the rejected triage-tier alternative (§4)
  would have made; and it runs inside the PR's own install under PR-editable
  `.yarnrc.yml`, **default-on only for public GitHub PRs** — off exactly where the
  modern threat lives (private repos, compromised-maintainer and agent-authored PRs).
  This check's mode is read from base and enforced as a required check (§5, §6).
- **pnpm ≥ 11 install-time hardening** — integrity mismatches are hard failures
  (`ERR_PNPM_TARBALL_INTEGRITY`, 11.4), missing-integrity entries rejected, explicit
  tarball URLs checked against registry metadata, `blockExoticSubdeps` (no git/tarball
  resolutions in transitive deps), `minimumReleaseAge` (quarantine window on fresh
  releases), `trustPolicy`. **Composes, doesn't compete**: it protects every install
  everywhere (dev machines included) but does not validate the graph (phantom edges to
  real registry packages pass frozen installs) and accepts any valid version choice.
  Synergy worth exploiting: `minimumReleaseAge` committed in base config is honored by
  the assay's own re-resolve (staging runs under committed config), so it
  quarantines fresh malware *and* stabilizes re-resolution (§8).
- **lockfile-lint** (~2019) — static shape lint over npm/yarn `resolved` URLs (allowed
  hosts/registries, https, integrity presence). No re-derivation; pnpm's registry
  entries carry no URLs, so it has little to check there.
- **Lockfile-changed-without-manifest tripwires** (CI actions) — a one-signal
  heuristic; misses poison folded into a legitimate-looking bump.
- **Folk practice** — the lockfile design-space study (arXiv 2505.04834) records a
  practitioner doing exactly this check by hand: *"I'll pull their change into a
  branch… and then see if my lockfile changed in the exact same way."* The assay is
  that practice, automated and anchored where the PR can't switch it off.

References: [Yarn security features](https://yarnpkg.com/features/security) ·
[pnpm 11.4 release notes](https://pnpm.io/blog/releases/11.4) ·
[npm supply-chain defenses survey, 2026](https://mondoo.com/blog/npm-supply-chain-security-package-manager-defenses-2026) ·
[The Design Space of Lockfiles Across Package Managers](https://arxiv.org/html/2505.04834v3)

---

## 11. Scope and roadmap

**v1 — pnpm.** One workspace, one root `pnpm-lock.yaml` (pnpm monorepos included —
they share a single lockfile); the check, the mode knob, the report contract, the CLI
including the local forms (§8), and the derivation memo (§8). Implementation design:
§13.

**Later.**
- **npm** — `package-lock.json` records `resolved` URLs in-file, the classic
  lockfile-injection surface: a richer attack surface and a richer checkable
  structure. **yarn** after that (hardened mode covers parts, §10; base-staged
  byte-derivation would still add exactness and anchoring).
- Report ergonomics: check-run annotations, PR comments, verbosity knobs.
- Per-path exemptions, if real repos demonstrate a need (vendored tarballs, generated
  patches) — exemptions are attack surface, so none ship until demanded.
- **Honoring `.pnpmfile.cjs`** — refused in v1 (§3 preflight). Honoring keeps §2's
  claim intact (the file is reviewable diff) but needs a credential-isolation story
  for §8's memo-writing run, where "nothing executes" currently carries the safety
  argument.
- The remaining §8 direction — quarantine-window guidance — lands when specified.

## 12. Open questions — all resolved 2026-07-04

1. **`warn` exposure (§9)** — acceptable; `warn` stays a legitimate mode, and §9's
   caveat stays printed as its warning label: a rollout stage, not a resting posture.
2. **Config shape** — a single `mode` knob is enough for v1; report/annotation wiring
   stays in the `--json` seam.
3. **Monorepo scoping** — stage all importers, always (§3). The lockfile is one
   whole-workspace artifact with coupled shared sections, so partial derivation
   cannot byte-reproduce it — and base-lockfile staging already narrows the fresh
   surface to the changed specs. Narrower staging is machinery with a correctness
   cliff.
4. **Merge queues** — no queue-specific handling; branch protection's re-check
   against the final base is sufficient. Queue-induced base drift is §7's, remedied
   by refresh.
5. **Local strictness override** — no; YAGNI until warn-stage data argues otherwise
   (§8).
6. **Memo writer identity** — a dedicated GitHub App; local forms read via ambient
   credentials and skip silently without one (§8). Mechanics get a pre-implementation
   validation spike (§8).
7. **Memo provenance in reports** — yes: unnecessary for the verdict but nearly free,
   shipped as diagnostics (§8).

---

## 13. Implementation design (v1)

Decided 2026-07-04. The sections above are the contract; this is how v1 builds it.

**Stack.** TypeScript (ESM) on Node ≥ 22; published as the npm package
`lockfile-assay` (bin of the same name) from `jsalvata/lockfile-assay`, MIT. Tooling
per the waiver-stamp skeleton: biome, vitest, `tsc` build, husky + commitlint
(Conventional Commits), semantic-release with npm OIDC trusted publishing. The repo
dogfoods: its own CI runs the assay on itself.

**Shape: a thin orchestrator over real binaries.** The assay never re-implements
resolution — pnpm-as-a-library was rejected outright: an in-process resolver is the
assay's bundled version, not the repo's pinned one (§3). Git content comes from
plumbing (`rev-parse`, `cat-file`, `ls-tree`, `write-tree`, `merge-base`,
`diff --name-only`); the pinned pnpm runs via corepack in an isolated temp tree,
whose staged root manifest itself carries the pin corepack honors.

**Trust-path discipline.** `git → staging → toolchain → derive → verdict` import no
third-party code and never import the report layer; the verdict is raw byte
equality. Lockfile YAML parsing exists only in `report/` (the delta summary). An
import-graph guard test enforces both properties so they cannot silently regress.
Runtime dependencies: `commander` and `yaml`, exact-pinned — the Checks API via
built-in `fetch`, hashing via `node:crypto`.

**Modules.**

```
src/
  cli.ts          # commander: check | prepush
  git.ts          # plumbing helpers
  config.ts       # .lockfile-assay.json read from base
  trigger.ts      # net-diff + staged-increment triggers
  staging.ts      # staged file-set computation + temp-tree materialization
  toolchain.ts    # packageManager pin, corepack invocation, skew detection
  derive.ts       # runs the pinned pnpm in the staged tree → derived bytes
  verdict.ts      # byte compare → outcome
  memo/           # key.ts (EPOCH + inputsHash) · auth.ts (token chain) ·
                  # store.ts (Checks API behind a backend interface)
  report/         # delta.ts (YAML parse, report-side only) · render.ts (human + --json)
```

**Flow (`check --base X --head Y`).** rev-parse → trigger (vacuous pass exits before
config is read) → config from base → §3 preflight → pin parse → memo consult
(`inputsHash` computed from git objects; a hit short-circuits to pass with
provenance) → stage temp tree → skew check → derive → byte verdict → memo write on
pass (CI form holding a token) or §4 report on mismatch. `--staged` takes head = the
index tree (`git write-tree`); `prepush` takes tips from the githooks(5) stdin ref
lines, skipping deletions, fast-path diff first.

**Tests.** Three rings.

- *Unit*: trigger filtering; staged-set computation (workspace globs,
  `patchedDependencies`); config incl. malformed → exit 2; delta parser; report
  goldens; the §5 exit-code matrix, table-driven; the import-graph guard.
- *Hermetic integration* — a per-suite Verdaccio registry with synthetic packages,
  programmatically built git fixture repos, the real corepack-selected pnpm, matrixed
  over 9.12.0 and 10.34.1:
  - the §3 **empirics**: from-scratch determinism, author-path ≡ checker-path,
    idempotency, reuse-not-re-resolve;
  - the §1.1 **attack shapes**, one test per row: tarball swap, phantom edge,
    integrity lie, version-choice pin — all must byte-fail; the `.npmrc` redirect
    must pass (visible diff, by design);
  - **drift and remedy**: a floor-moved spec racing a fresh publish; a base advance;
    then the refresh recipe converging to a pass — the self-healing property, tested;
  - **local forms**: index-tree head, stdin ref lines, every cannot-evaluate degrade;
  - **memo**, against a faked Checks API: hit short-circuit with the registry
    killed (proving no registry roll), stale-memo fallthrough, mismatch never
    memoised, epoch isolation, duplicate records from concurrent runs read as
    equivalent.
- *Dogfood + smoke*: CI runs `node dist/cli.js check` on the repo itself; CLI smoke
  tests per waiver-stamp; the release checklist carries §8's epoch-bump rule ("when
  in doubt, bump").

**Verified at plan time, not assumed:** corepack's bundling status on current Node
(fallback: invoking the pinned pnpm without corepack), and `git write-tree` behavior
on a mid-merge index.
