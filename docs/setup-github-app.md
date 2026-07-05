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

> **This document describes the design-intended setup.** A pre-implementation
> validation spike (`docs/spike-memo-store.md`) proves the chain on a scratch
> repo before the memo ships — the ruleset naming the App as the memo branch's
> sole pusher, in-workflow token minting, and Contents API `GET`/`PUT`
> including the write race. Points below tagged **(TBD — spike)** are asserted
> from the design and will be pinned to observed behavior by that spike; do not
> treat them as measured yet.

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
- **Rules:** enable **Restrict creations**, **Restrict updates**, and
  **Restrict deletions** — this makes the branch writable only by actors on the
  ruleset's **bypass list**.
- **Bypass list:** add **only the GitHub App** (the one from step 1). It becomes
  the sole identity that may push to (create/update/delete) this branch;
  everyone else — including repo admins pushing directly — is refused
  server-side.

> **(TBD — spike):** the exact ruleset rule set that yields "App-only writer"
> (Restrict creations/updates/deletions with the App on the bypass list, vs. a
> push ruleset, vs. a classic branch-protection restriction) will be confirmed
> by the validation spike. The store's write path already tolerates either
> Contents-API conflict status GitHub returns on a losing race (see step 7), so
> the ruleset choice does not change CLI behavior.

## 6. Wire the reference workflow

Copy [`examples/assay.yml`](../examples/assay.yml) into
`.github/workflows/assay.yml`. It:

1. checks out with `fetch-depth: 0` (the check needs base history),
2. sets up Node 22,
3. mints the App installation token with
   `actions/create-github-app-token@v1` (id `memo-token`), and
4. runs `npx --yes lockfile-assay check --base "origin/${{ github.base_ref }}"
   --head HEAD --memo-write --json` with `LOCKFILE_ASSAY_TOKEN` set to that
   token.

`--memo-write` is what makes this the *writing* form — the local hook forms
(`--staged`, `prepush`) never write, so this workflow is the only place a record
is minted. Add the workflow as a **required status check** on your protected
branch, and protect the workflow file itself per spec §6's anchor caveat (org
rulesets / required workflows) so a PR can't edit its own gate.

The repo the store writes to is discovered from the checkout's `origin` remote,
and the memo branch defaults to `lockfile-assay/memo` — matching steps 4–5. If
either the token or `origin` is absent the memo is silently disabled and the
check re-derives live; it never fails for lack of memo credentials.

> **Follow-up (this repo's own CI):** lockfile-assay dogfoods the check in
> `.github/workflows/ci.yml`, but without `--memo-write` — the App and memo
> branch are not yet set up on the lockfile-assay repo itself. Once they are
> (steps 1–5 above, plus minting the token in that workflow), the dogfood step
> can gain `--memo-write`.

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
   will both try to `PUT`; the loser gets a Contents-API conflict and swallows
   it silently, because same-key records are equivalent.

   > **(TBD — spike):** the exact conflict status GitHub's Contents API returns
   > on a losing concurrent `PUT` (409 vs 422) will be confirmed by the
   > validation spike. The store already treats **both** as "lost the race,
   > equivalent record exists" and retries nothing, so the verdict is
   > unaffected either way — this doc does not assert which status is observed.

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
