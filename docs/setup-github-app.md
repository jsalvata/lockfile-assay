# Setting up the derivation memo store

The derivation memo (spec §8) lets a trusted CI run record that *these exact
staged inputs derive this lockfile*, so later runs on the identical inputs
short-circuit to a pass instead of re-rolling the registry-drift dice (§7). A
memo can **only** turn a live re-derive into a remembered pass — it never
produces a failure — so the only thing that must be trustworthy is **who is
allowed to write records**.

The store is an orphan branch in your own repo, and the writer is a **dedicated
GitHub App** whose installation token is the only identity a branch ruleset lets
push to it. GitHub enforces that ACL server-side; the branch's append-only
history is the audit ledger; revocation is `git rm` (itself history). The PR
author controls the workflow and the runner, but not the App's private key — so
even though the check runs with a real writer token in a PR-triggered job, a
malicious PR cannot forge a record.

This whole chain — an App-only-writable branch, in-workflow token minting, and
the Contents API `GET`/`PUT`/conflict behavior the store relies on — was
validated end to end on this repo; see the [spike findings](spike-memo-store.md)
for the measured results.

## Prerequisites

- Admin on the repo (to create the App-install, secrets, and a ruleset).
- The check already wired as described in the [README](../README.md) /
  spec §6 (registry reachability and the pnpm version pinned by
  `packageManager`).
- **Private registries:** the derivation strips `npm_config_*` environment
  variables so ambient env can't silently override the staged `.npmrc`
  (spec §3 / §6). If your lockfile resolves from a private registry, supply
  those credentials via the **runner's `~/.npmrc` FILE**, not `npm_config_*`
  env vars — add a step to your workflow that writes `~/.npmrc` before the
  check runs. This is unchanged by the memo; it is called out here so
  private-registry adopters aren't surprised.

## 1. Create a dedicated GitHub App

Create a new GitHub App (org or personal account — Settings → Developer
settings → GitHub Apps → New GitHub App).

- **Permissions:** Repository permissions → **Contents: Read and write**. Grant
  **nothing else** — the App's entire job is committing memo records to one
  branch. A narrower blast radius is the point of using a named App over a
  broad token.
- **Webhooks:** not needed — uncheck "Active".
- After creating it, note the **App ID** and generate a **private key** (a
  `.pem` download). Both go into repo secrets below.

## 2. Install the App on the repo

From the App's page → Install App → install it on the repo (or the specific
repos) that will use the memo. The install grants the App its Contents
read/write on those repos; the ruleset in step 5 narrows *where* it may write.

## 3. Store the credentials as repo secrets

In the repo (Settings → Secrets and variables → Actions), add:

- `ASSAY_APP_ID` — the App ID from step 1.
- `ASSAY_APP_PRIVATE_KEY` — the full contents of the `.pem` private key.

The reference workflow (`examples/assay.yml`) reads exactly these two names via
`actions/create-github-app-token@v1`, which exchanges them for a short-lived
installation token per run. The CLI never sees the private key — only the
minted token, in env as `LOCKFILE_ASSAY_TOKEN`.

Step 6 hardens these two secrets behind a GitHub Environment; if you do that,
add them at the Environment scope rather than (or in addition to) the repo scope.

## 4. Create the orphan memo branch

The store lives on a dedicated branch — default `lockfile-assay/memo` — that is
never checked out; the CLI reads and writes it entirely through the Contents
API. Create it empty:

```sh
git switch --orphan lockfile-assay/memo
git commit --allow-empty -m "lockfile-assay memo store"
git push origin lockfile-assay/memo
git switch -   # back to your working branch
```

Records land at `memo/<epoch>/<hash[0:2]>/<hash>.json` — one ~1 KB JSON per key
under a two-hex fanout. Even a bump-heavy repo writes single-digit megabytes a
year (spec §8), so no pruning is needed for v1.

## 5. Protect the branch with a ruleset (App = sole writer)

Create a **repository ruleset** (Settings → Rules → Rulesets → New branch
ruleset) so the memo branch can be changed by the App and no one else:

- **Target:** the branch `lockfile-assay/memo` (an exact-name / fnmatch include
  targeting just that ref, so the rest of the repo is untouched).
- **Rules:** enable **Restrict creations**, **Restrict updates**, **Restrict
  deletions**, and **Block force pushes** — this makes the branch writable only
  by actors on the ruleset's **bypass list**.
- **Bypass list:** add **only the GitHub App** (the one from step 1). It becomes
  the sole identity that may push to (create/update/delete) this branch;
  everyone else — including repo admins pushing directly — is refused
  server-side.

Prefer the API to the UI? Create the same ruleset with
`POST /repos/{owner}/{repo}/rulesets`, listing the App as the sole
`bypass_actor`. (The spike verified this yields an App-only writer — a normal
`git push` and even a `contents: write` `GITHUB_TOKEN` were both refused; see the
[findings](spike-memo-store.md).)

## 6. Wire the check into CI

Run the *writing* form (`--memo-write`) from a required-check workflow. The local
hook forms (`--staged`, `prepush`) never write, so this workflow is the only
place a record is minted. Pick one of two ways to invoke it:

**Option A — copy the reference workflow.** Copy
[`examples/assay.yml`](../examples/assay.yml) into `.github/workflows/assay.yml`.
It checks out with `fetch-depth: 0` (the check needs base history), sets up
Node 22, mints the App installation token with `actions/create-github-app-token@v1`,
and runs `lockfile-assay check --base "origin/${{ github.base_ref }}" --head HEAD
--memo-write --json`.

**Option B — use the packaged action.** Reference the composite action
([`action.yml`](../action.yml)) instead of copying the YAML — it wraps the same
`--memo-write` invocation. You still check out and mint the token first:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: actions/create-github-app-token@v1
  id: memo-token
  with:
    app-id: ${{ secrets.ASSAY_APP_ID }}
    private-key: ${{ secrets.ASSAY_APP_PRIVATE_KEY }}
- uses: jsalvata/lockfile-assay@v1
  with:
    base: origin/${{ github.base_ref }}
    head: HEAD
    memo-token: ${{ steps.memo-token.outputs.token }}
```

Then, whichever option you chose:

1. **Add the workflow as a required status check** on your protected branch.
2. **Protect the workflow file itself** (spec §6's anchor caveat — org rulesets /
   required workflows) so a PR can't edit its own gate.
3. **Gate the App secret behind a GitHub Environment.** A required status check
   gates *merging*, not *running* — it does nothing to stop a same-repo PR from
   minting the token in its own job by editing this workflow or adding a second
   one. Since the memo's integrity rests on the App being the only writer, a
   same-repo insider (or a compromised contributor or agent) who can mint the
   token could `PUT` a poisoned record that a later clean PR then rides to a false
   pass. To close this: put `ASSAY_APP_ID` / `ASSAY_APP_PRIVATE_KEY` on a **GitHub
   Environment gated by required reviewers** (Settings → Environments → New
   environment → Required reviewers) instead of plain repo secrets, and add
   `environment: <name>` to the token-minting job — the token is then minted only
   after a human approves the run. (Forks are already safe: a `pull_request` from
   a fork gets no secrets, so the memo is simply disabled and the check re-derives
   live.) Spec §8 accepts this residual "raises the stakes by one notch" exposure
   for v1; the roadmap's external verification App removes it.

The repo the store writes to is discovered from the checkout's `origin` remote,
and the memo branch is `lockfile-assay/memo` — matching steps 4–5. If either the
token or `origin` is absent the memo is silently disabled and the check re-derives
live; it never fails for lack of memo credentials.

> A private-registry consumer must add the `~/.npmrc` file step (see
> Prerequisites) to this workflow before the `lockfile-assay` step.

## 7. Verify the chain

After the branch and ruleset exist:

1. **A non-App push must be REJECTED.** As a normal user (even a repo admin),
   try to push to the memo branch directly:

   ```sh
   git switch lockfile-assay/memo
   git commit --allow-empty -m "should be rejected"
   git push origin lockfile-assay/memo   # expect: rejected by ruleset
   git switch -
   ```

   The push should be refused server-side because the pusher is not on the
   ruleset bypass list. If it succeeds, the ruleset is not restricting the
   branch to the App — revisit step 5.

2. **The App-token push must SUCCEED.** Open a PR that changes a resolution
   input (a `package.json` dependency bump plus the matching lockfile update).
   On a passing (byte-match) run, the workflow's `--memo-write` step commits a
   record — you should see a new `memo/<epoch>/…json` commit on
   `lockfile-assay/memo` authored by the App. A second run on the identical
   inputs should report `memo: { hit: true, … }` in the `--json` output
   (served from the record rather than re-resolved).

3. **The write race is harmless.** Two concurrent passing runs on the same key
   will both try to `PUT`; the loser gets a Contents-API conflict (HTTP 422) and
   swallows it silently, because same-key records are equivalent. (The spike
   measured this — see the [findings](spike-memo-store.md).)

## What can go wrong (and why it's safe)

- **Token missing / `origin` not GitHub:** memo disabled, check re-derives live.
  No failure.
- **Memo read errors (GitHub outage, 5xx, bad JSON):** treated as a miss →
  live re-derive. No failure.
- **Memo write errors (other than the race):** logged to stderr and swallowed —
  the verdict already happened; a failed write never fails the check.
- **A stale record (inputs unchanged but head's lockfile honestly
  re-authored):** falls through to a live resolve and refreshes itself. The
  memo can never *create* a failure — only short-circuit to a pass.

See spec §8 ("The store — writes are the trust boundary") for the full rationale
and the alternatives that were rejected (Actions cache, `GITHUB_TOKEN`-scoped
statuses, signed records).
