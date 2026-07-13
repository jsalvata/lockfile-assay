# Setting up the anchored check

The anchored form of the check (spec §6, §8) posts its verdict as a **check run
under a dedicated GitHub App** and memoises passing derivations inside those
check runs, so identical inputs later short-circuit to a pass instead of
re-rolling the registry-drift dice (§7). A memo can **only** turn a live
re-derive into a remembered pass — it never produces a failure — so the only
thing that must be trustworthy is **who can write records**, and here that is
whoever can mint the App's token.

The App is an **identity, not a service** — there is nothing to host. Its token
is minted inside the anchored workflow run, and three server-enforced facts
carry the trust:

1. The anchored workflow triggers on **`pull_request_target`**, so the
   definition that runs is the **base branch's** — a PR cannot edit its own
   gate, and a `pull_request_target` workflow added by a PR does not trigger.
2. The App's credentials live on an **Environment restricted to base-context
   runs** — a `pull_request` workflow (including one the PR itself adds) runs
   on the PR's merge ref, fails the branch policy, and is refused the secrets.
3. Branch protection requires the verdict check **from this App's identity** —
   a same-named check posted with a PR job's `GITHUB_TOKEN` comes from the
   built-in Actions identity and cannot satisfy it.

## Prerequisites

- Admin on the repo (App install, environment, branch protection).
- The check already wired as described in the [README](../README.md) / spec §6
  (registry reachability and the pnpm version pinned by `packageManager`).
- **Private registries:** the derivation strips `npm_config_*` environment
  variables so ambient env can't silently override the staged `.npmrc`
  (spec §3 / §6). If your lockfile resolves from a private registry, supply
  those credentials via the **runner's `~/.npmrc` FILE**, not `npm_config_*`
  env vars — add a step to the anchored workflow that writes `~/.npmrc` before
  the check runs.

## 1. Create a dedicated GitHub App

Create a new GitHub App (org or personal account — Settings → Developer
settings → GitHub Apps → New GitHub App).

- **Permissions:** Repository permissions → **Checks: Read and write**. Grant
  **nothing else** — the App's entire job is posting the assay's verdicts. A
  narrower blast radius is the point of using a named App over a broad token.
- **Webhooks:** not needed — uncheck "Active".
- After creating it, note the **App ID** and generate a **private key** (a
  `.pem` download). Both go into the environment secrets below.

## 2. Install the App on the repo

From the App's page → Install App → install it on the repo (or the specific
repos) that will run the anchored check.

## 3. Store the credentials on a branch-restricted environment

In the repo (Settings → Environments → New environment):

- Name it — say, `lockfile-assay`.
- Under **Deployment branches and tags**, choose **Selected branches and
  tags** and add the protected branch (e.g. `main`). Do **not** add required
  reviewers — the branch policy is the gate, and it needs no per-run approval.
- Add two **environment secrets**: `ASSAY_APP_ID` (the App ID) and
  `ASSAY_APP_PRIVATE_KEY` (the full `.pem` contents).

Why this gates: environment access is evaluated against the ref a run executes
on. A `pull_request_target` run executes in base context (`main`) and is
admitted; any `pull_request` run — including one from a workflow the PR itself
adds — executes on the PR's merge ref and is refused the secrets server-side.

## 4. Add the anchored workflow

**Option A — copy the reference workflow.** Copy
[`examples/assay.yml`](../examples/assay.yml) into
`.github/workflows/assay.yml`.

**Option B — use the packaged action.** Reference the composite action
([`action.yml`](../action.yml)) instead of copying the CLI invocation. You
still check out, fetch the head, and mint the token first:

```yaml
name: lockfile-assay
on:
  pull_request_target:
jobs:
  assay:
    runs-on: ubuntu-latest
    environment: lockfile-assay
    steps:
      - uses: actions/checkout@v4        # base branch — never the PR head
        with:
          fetch-depth: 0
      - run: git fetch origin "pull/${{ github.event.pull_request.number }}/head"
      - uses: actions/create-github-app-token@v1
        id: app-token
        with:
          app-id: ${{ secrets.ASSAY_APP_ID }}
          private-key: ${{ secrets.ASSAY_APP_PRIVATE_KEY }}
      - uses: jsalvata/lockfile-assay@v1
        with:
          base: origin/${{ github.base_ref }}
          head: ${{ github.event.pull_request.head.sha }}
          app-token: ${{ steps.app-token.outputs.token }}
```

**Security discipline — read before editing this workflow.**
`pull_request_target` runs with secrets while the PR controls the repository
content under test. The assay treats that content as **inert data** (spec §3:
`--ignore-scripts`, no `.pnpmfile.cjs`, nothing executes), and the workflow
must preserve that property:

- check out the **base** (the `pull_request_target` default) — never the head;
- fetch head commits as **git data** only (the CLI reads them as objects);
- run the **published, pinned** assay — never a binary built from the PR;
- no `pnpm install` of the repo under test, no `uses: ./`, no execution of
  anything from the head tree.

One careless edit here reopens arbitrary-code-execution-with-secrets. Treat
this file as security-critical and keep it minimal.

## 5. Require the App's check on the protected branch

Branch protection / ruleset → required status checks → add the assay's check
and select **this App** as its source. The pin is load-bearing: without it, any
workflow can post a same-named green check via its own `GITHUB_TOKEN`.

## 6. Verify the chain

1. **A PR-added workflow must be refused the secrets.** Open a scratch PR that
   adds a workflow referencing the environment — the job should fail at the
   environment gate, before any secret is readable.
2. **A `GITHUB_TOKEN` check must not satisfy the requirement.** Post a
   same-named check from an ordinary workflow — branch protection should still
   report the required check as missing.
3. **The memo round-trips.** Open a PR that changes a resolution input (a
   `package.json` bump plus the matching lockfile update). On a passing run,
   the App's check run carries the memo record; a re-run on identical inputs
   reports `memo: { hit: true, … }` in the `--json` output, with no registry
   round-trip.

## What can go wrong (and why it's safe)

- **App token missing / minting fails:** no verdict check is posted; the
  required check stays pending and merges block. Fail-closed availability,
  never a silent pass.
- **Memo read errors (GitHub outage, 5xx, bad record):** treated as a miss →
  live re-derive. No failure.
- **A stale record** (inputs unchanged but head's lockfile honestly
  re-authored): falls through to a live resolve and a fresh record. The memo
  can never *create* a failure — only short-circuit to a pass.
- **Concurrent re-runs on the same key:** each posts its own record;
  duplicates are equivalent.
- **Fork PRs:** `pull_request_target` grants base secrets to fork PRs too —
  safe under the same inertness discipline — so forks get the anchored check
  and the memo (a plain `pull_request` check would run fork PRs without
  secrets).

See spec §8 ("The store — writes are the trust boundary") for the full
rationale and the alternatives that were rejected.
