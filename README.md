# lockfile-assay

*Prove your lockfile is untampered.*

## The problem

Every JavaScript CI pipeline runs a frozen install (`pnpm install --frozen-lockfile`)
and treats success as proof that the dependency tree is what the PR claims. It is not.
A frozen install verifies that the lockfile's importers match the `package.json`
specifiers, then trusts the rest of the file wholesale — the entire transitive
dependency graph and every `resolution:` entry. And no human backstops that trust: code
hosts collapse lockfiles as generated, and nobody expands thousands of lines of YAML in
review. The result is an **unreviewed write channel into `node_modules`**: anyone who
can get a PR merged can edit the lockfile so that CI installs, tests green, and ships
code that appears in no diff a reviewer read.

## What a pass proves

> **The committed lockfile is exactly what the repo's own package manager derives from
> the files a reviewer can read** — the manifests and committed configuration —
> against the registry those files name, at check time.

This moves the trust boundary off a generated file nobody reads and onto the diff humans
already review. A registry redirect, a new dependency, a changed range all remain
possible — but each is a small, visible, reviewable change. What becomes impossible is
the lockfile adding *anything* beyond them.

## Supported environments & limitations

**Package manager:** pnpm only — npm and Yarn are out of scope for v1. The assay
re-derives with the exact pnpm your repo pins via `packageManager` (see the Quickstart).

**Repository shape:** a single root `pnpm-lock.yaml`. pnpm workspaces (monorepos) are
supported precisely because they share that one lockfile.

**Runner:** Node ≥ 22 with `git` and Corepack available — the defaults on the standard CI
images.

Even on pnpm, a handful of resolution inputs are deliberately **not honoured**. The assay
refuses them as `unsupported-input` (a spurious mismatch, never a silent pass) rather than
derive a result it can't trust — under `enforce` that fails the check, so the PR must drop
them:

- **`.pnpmfile.cjs` / `global-pnpmfile`** — executable resolution hooks the assay cannot
  reproduce safely.
- **`package.yaml` / `package.json5`** — alternative manifest formats pnpm reads alongside
  `package.json`, which v1 does not stage.
- **`shared-workspace-lockfile=false`** — splits the single root lockfile the assay relies
  on.

## Quickstart

1. Pin pnpm in your root `package.json` (Corepack format) so the assay derives with the
   same version you develop against:

   ```json
   { "packageManager": "pnpm@<version>" }
   ```

2. Add `.lockfile-assay.json` at the repo root:

   ```json
   { "mode": "warn" }
   ```

   `mode` is `off` | `warn` | `enforce` (default `off`). The config is read from the
   **base** commit, so a PR cannot reconfigure the check that polices it — changing the
   mode requires a separately reviewed PR that lands first.

   > **Expect `mode: off` on the PR that adds this file — your config takes effect from
   > the next PR.** Config is read from base, and the base of *this* PR has no config
   > yet. Nothing is misconfigured; there is nothing to fix. You will also see
   > `mode: unknown` on any PR that touches no resolution input — there the check
   > short-circuits before reading config at all, so no mode was ever determined. That
   > one is permanent, not a first-PR artifact.

3. Add the anchored workflow: copy
   [`examples/lockfile-assay.yml`](examples/lockfile-assay.yml) to
   `.github/workflows/lockfile-assay.yml`. It is complete and copy-pasteable, and it
   already carries the two things the check does not work without:

   - **`fetch-depth: 0`** on `actions/checkout` — the default shallow clone has no
     merge-base for the check to derive from.
   - **`node-version: 22`** — the CLI requires Node ≥ 22 and dies on the engine check
     under Node 20.

   Then follow [`docs/setup-github-app.md`](docs/setup-github-app.md) for the one-time
   App setup, and pin the result as a **required status check**. Leave the mode on
   `warn` until the mismatch rate is quiet, then move it to `enforce` — that is the
   intended end state, and `warn` is a rollout stage rather than a resting posture
   (`docs/spec.md` §9).

   The workflow triggers on `pull_request_target` and posts its verdict as a dedicated
   GitHub App's check run. Both are load-bearing rather than ceremony: together they are
   what stops a PR from rewriting the gate that polices it. A check wired on a plain
   `pull_request` trigger runs the PR's *own* copy of the workflow, so it can be edited
   to always pass — which is why this repo ships no such example. `docs/spec.md` §6 is
   the full argument.

## Installing it

Two contexts, one rule — **always run a pinned version**:

| Where | How |
|---|---|
| CI | the pinned action: `uses: jsalvata/lockfile-assay@vX.Y.Z` (it installs its own pinned CLI — you do **not** add a dependency) |
| Local hooks | a devDependency: `pnpm add -D lockfile-assay`, invoked as `pnpm exec lockfile-assay` |

Do **not** invoke it as bare `npx lockfile-assay`: that resolves to whatever is `latest`
on npm at the moment it runs. A tool whose whole job is proving your dependencies are
pinned and untampered has no business running itself unpinned.

## Verdicts

The verdict depends on the outcome and the configured mode:

| Outcome | `off` | `warn` | `enforce` |
|---|---|---|---|
| byte match | not evaluated (exit 0) | pass (exit 0) | pass (exit 0) |
| mismatch | not evaluated (exit 0) | exit 0, warning report | **exit 1**, failure report |
| toolchain-skew | not evaluated (exit 0) | exit 0, warning report | **exit 1**, failure report |
| unsupported-input | not evaluated (exit 0) | exit 0, warning report | **exit 1**, failure report |

A PR that changes no resolution input never reaches that table at all: it is a **vacuous
pass** (exit 0), settled by a single `git diff --name-only` before any config is read.
Its report says `"mode": "unknown"` — which means *no mode was determined*, not `off`.
The same applies to a local hook with no base to read config from. `unknown` is never a
setting; the only settings are `off` | `warn` | `enforce`.

Exit `2` is a malformed invocation (unresolvable refs, no pnpm pin, malformed base
config); exit `3` is an internal error (resolver or network failure in CI). `--json`
emits the machine report for CI annotation layers.

## When it fails — the refresh recipe

A mismatch conflates honest **drift** (the inputs to re-resolution moved) with
**tampering** (content re-resolution cannot derive). The assay treats them identically;
the remedy is the same **refresh**:

```sh
git show <base>:pnpm-lock.yaml > pnpm-lock.yaml   # restore the reviewed prior state
pnpm install --lockfile-only --ignore-scripts --prefer-frozen-lockfile
git add pnpm-lock.yaml && git commit              # or --amend, as fits the branch
```

Restoring base's lockfile first is load-bearing, not ceremony: a plain `pnpm install`
reuses every locked entry — drifted and tampered alike — and refreshes nothing. Staged
from base, every entry the PR changed must re-derive honestly, so even a reflexive
refresh converges to a safe lockfile. Read the failure report to tell the two apart: a
version delta reads as drift; a `tarball:` URL or a novel edge reads as an attack.

## Local hooks

The same check runs where the author still is: at commit time on the staged index, at
push time on every pushed tip. Both are a courtesy preview of the required check — a
broken local environment (no reachable registry, no derivable base) degrades to a
notice and exit 0 instead of blocking. Add the devDependency
(`pnpm add -D lockfile-assay`), then wire the hooks — with
[husky](https://typicode.github.io/husky/) below, though any hook manager works, as
these are plain git hooks:

```sh
# .husky/pre-commit
pnpm exec lockfile-assay check --staged
```

```sh
# .husky/pre-push
pnpm exec lockfile-assay prepush
```

The escape hatch is git's native `--no-verify`, on either hook — skipping a courtesy
preview changes nothing about the required check.

## Durable verdicts — the derivation memo

Every evaluation re-resolves against the registry, and each resolution is a fresh roll
of the drift dice (§7): a passing PR that keeps receiving source-only pushes, a flaky
re-run, a merge-queue re-validation — all re-ask a question already answered. The memo
records the *first* trusted evaluation of a given input set so identical inputs later
short-circuit instead of re-rolling.

- **What it buys:** no re-rolls of §7's drift dice. Once a trusted CI run has recorded
  that these exact staged inputs derive this lockfile, a later run on the identical
  bytes serves the remembered pass — no registry round-trip, no new drift window.
- **What it never does:** a memo can **only** short-circuit to a **pass**. It cannot
  produce a failure. A stale record falls through to a live re-derive; a mismatch is
  never memoised. Only the anchored CI form (`check --memo-write`) writes; the local
  hook forms read at most.

The record rides in the verdict itself: the anchored check posts its result as a
**check run** under a dedicated GitHub App, memo record included. GitHub sets
check-run authorship server-side and only the creating App can update its runs — so
a PR author cannot forge a verdict, and there is no store to provision or protect.
Setup (App, secrets, anchored workflow, required-check pinning) is in
[`docs/setup-github-app.md`](docs/setup-github-app.md). See spec §8 for the full design.

See [`docs/spec.md`](docs/spec.md) for the full design: the check mechanics, the
failure-report contract, the local `prepush` / `--staged` forms, the derivation memo,
prior art, and the roadmap.

## License

MIT
