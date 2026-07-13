# Memo store validation spike — findings

**Ran:** 2026-07-06, on the real `jsalvata/lockfile-assay` repository (not a throwaway).
**Purpose (spec §8, plan task C1):** prove the derivation-memo deployment chain end to
end before adopters rely on the setup docs — an App-only-writable memo branch,
in-workflow installation-token minting, and the Contents API GET/PUT/conflict behavior
the store (`src/memo/store.ts`) assumes.

Every design assumption held. Two "(TBD — spike)" markers in
[setup-github-app.md](setup-github-app.md) are resolved by the observations below.

## Setup as tested

- **GitHub App** `lockfile-assay-memo` (App ID **4225880**), permission **Contents:
  Read and write** only, installed on `jsalvata/lockfile-assay`. Private key stored as
  the repo secret `ASSAY_APP_PRIVATE_KEY`; App ID as `ASSAY_APP_ID`.
- **Orphan branch** `lockfile-assay/memo` — a single empty-tree root commit.
- **Repository ruleset** (id 18548646), target `refs/heads/lockfile-assay/memo`,
  enforcement `active`, rules `creation` + `update` + `deletion` + `non_fast_forward`,
  **bypass actors: only the App** (`actor_type: Integration`, `actor_id: 4225880`,
  `bypass_mode: always`). Created via `POST /repos/{repo}/rulesets` (no UI needed).

## Observations

### Writes are the trust boundary — confirmed (spec §8)

| Actor | Operation | Result | Interpretation |
|---|---|---|---|
| `jsalvata` (a user, via `git push`) | push a commit to `lockfile-assay/memo` | **rejected** — `GH013: Cannot update this protected ref` | a PR author's own identity cannot write memo records |
| `GITHUB_TOKEN` **with `contents: write`** (a workflow) | `PUT /contents/...` to the memo branch | **HTTP 409**, not 201 | even a write-**permitted** default `github-actions` token is refused — it's the **ruleset**, not the permission, that blocks it. This is the "bring-your-own-verdict" defense (§8): every `GITHUB_TOKEN` writer is the same non-App identity, and the ruleset admits only the App. |
| The App (minted installation token) | `PUT /contents/...` (create) | **HTTP 201** | the App — the sole bypass actor — writes successfully |

### Contents API behavior the store relies on

| Operation | Result | Store expectation (`src/memo/store.ts`) |
|---|---|---|
| App `PUT` new key (create) | **201** | `put` success |
| App `GET` existing key (raw accept) | **200** + the JSON | `get` returns the record |
| App `GET` missing key | **404** | `get` → `null` (a memo **miss**) ✓ |
| App `PUT` **same key again without `sha`** (the race/duplicate case) | **422** | `put` swallows the conflict silently ✓ |

**The conflict status is 422, not 409.** `store.ts` swallows **both** 409 and 422 as
"lost the race" — vindicated: the App's own duplicate write returns **422**, while a
blocked non-App write surfaces as **409**. Swallowing both is exactly right (the store
only ever writes with the App token, so in practice it sees 422 on a genuine race;
409 is what a non-App identity would see, which never happens for the store's own
writes but is harmless to swallow).

### Token minting

`actions/create-github-app-token@v1` with `app-id` + `private-key` from the two secrets
mints a scoped installation token in-workflow; the private key never reaches the CLI
(only the short-lived token is passed as `LOCKFILE_ASSAY_TOKEN`). Matches
[examples/assay.yml](../examples/assay.yml).

## Cleanup

The spike wrote one throwaway record (`memo/1/sp/spike…ab.json`, keyed on a
deliberately non-hex hash no real derivation can produce — inert even if left) and
removed it via a Contents API `DELETE` (HTTP 200) using the App token, so the ledger
starts clean; the delete commit is preserved as history per the append-only design.
The verification workflow ran on a `spike/memo-verify` branch that was deleted
afterward. The App, its installation, the two secrets, the `lockfile-assay/memo`
branch, and ruleset 18548646 remain in place — the memo is **deployed**, awaiting the
workflow that PR C adds (which does not add `--memo-write` to this repo's own dogfood
until PR C lands).

## Net

No design change required. The store's failure handling, the ruleset-as-ACL model, and
the token-minting flow all behave as spec §8 designed. The only concrete refinement is
documentary: the conflict status is **422**, now recorded in the setup doc.
