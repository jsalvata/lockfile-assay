# Anchoring the memo writer — gated workflow now, external App later

Working notes on the memo's trust boundary and how we close it. Extends spec §6
(anchor caveat), §8 (the store — writes are the trust boundary), and §11 (the
external App service). Captured out of a dogfooding session so it isn't lost; the
hosting question at the end is still open.

## The gap

The memo can only short-circuit to a **pass** — never a failure (spec §8). So the
only thing that must be trustworthy is **who may write records**. A poisoned record
asserts *"input-set H derives lockfile L"*; a later clean-looking PR that presents
the same inputs H then rides the remembered pass, shipping a lockfile no live
derivation ever vetted.

The subtlety that makes this real: a `pull_request` workflow runs **when the PR is
opened/updated, before merge**, and — for a **same-repo** PR — that run gets secrets
and executes the workflow file **as modified on the PR head**. So the attack needs no
merge:

1. **PR #1** modifies `assay.yml` to `PUT` a poisoned record. Its run mints the token
   and writes the poison to `lockfile-assay/memo` at open time (a direct Contents-API
   commit that persists independently of the PR). The attacker **closes PR #1
   unmerged** — no reviewer ever evaluates it for merge.
2. **PR #2** is clean (no workflow changes) and presents the same inputs. It rides the
   poisoned record → false pass → merges, reviewer seeing a spotless diff.

"A human reviewer would spot the workflow tampering" does **not** save you: the
tampering PR is never offered for merge. The write happens at *run* time, a moment
with no merge-review checkpoint.

## Why the base check shares this

This is not memo-specific. Spec §6's anchor caveat says *any* required check "is only
as strong as what prevents the PR from editing its wiring" — a same-repo PR that can
rewrite `assay.yml` can force the base check green too, memo or no memo. The memo just
"raises the stakes by one notch" (§8): it adds a second, *write-capable* surface. So
the fix is really about the general anchor, and the memo rides along.

## Two ways to close it (both blessed by the spec)

Spec §8 names them directly: the store credential "must be reachable **only** from the
anchored check — an external app, or a workflow gated so PR-editable definitions can
never see it." Running the check privileged is safe here because §3 keeps PR content
inert (`--ignore-scripts`, no `.pnpmfile.cjs`, no tarballs — nothing executes).

| | Gated workflow (near-term) | External App (end-state) |
|---|---|---|
| **Mechanism** | Write the memo only from a `main`-only path; PR context can't reach the credential | The check runs as a webhook-backed GitHub App *outside* the repo's CI definition |
| **What it fixes** | The memo-write vector | Dissolves the anchor caveat **entirely** — base check *and* memo (§11) |
| **Infra** | None beyond GitHub settings | A hosted service (receiver + isolated worker) |
| **Memo timing** | Records written **post-merge** only → lower hit rate; PR runs re-derive live | Pre-merge writes restored safely |
| **Approval friction** | None (vs the required-reviewer environment) | None |
| **Status** | Valid v1 posture | Roadmap; **the v1 App identity is the seed** (§11) |

The required-reviewer environment (`setup-github-app.md` §6.3) is a *third*, weaker
option: it inserts a human at the run-time write, but only works if the approver
notices the run came from a workflow-editing PR, and it costs an approval **per run**.
Fine for solo dogfooding; unacceptable at scale.

## Near-term fix — the `main`-only gated write

- Move `--memo-write` to a workflow triggered on `push: [main]` (post-merge). Leave the
  PR check running **token-less** — spec §8 guarantees "if the token is absent the memo
  is silently disabled and the check re-derives live," so PRs keep a full honest gate.
- Restrict the `memo-write` environment's **Deployment branches** to `main` (drop the
  reviewer). Any job referencing the environment from a non-`main` ref — including a
  workflow a malicious PR *adds* — is refused the secrets server-side.
- The only workflow that can write then runs the file **as merged into `main`**
  (reviewed). Now "reviewer catches the workflow change → it can't land → safe" holds.

Cost: within-PR re-runs and merge-queue re-validations of the same pre-merge inputs
re-derive live instead of hitting the memo. Lower hit rate, zero friction, *stronger*
integrity than the reviewer gate.

## End-state — the external verification App

An evolution of the App we already installed (§11: "the v1 App identity is the seed"),
not a greenfield build.

- **Permissions:** add **Checks: write** (post the verdict) + **Pull requests: read**;
  keep **Contents: read** (fetch inputs) and **Contents: write** (memo). Note App
  permissions are repo-wide, not path-scoped — the memo-branch **ruleset** (not the
  token) is what confines writes to that branch.
- **Webhook:** `pull_request` (opened/synchronize/reopened) + `check_suite`
  (rerequested).
- **Service:** *receiver* (verify signature, ack fast, enqueue) → *queue* → *worker*
  (mint per-installation token, read `mode` from base, fetch inputs at base+head,
  re-derive, compare, consult/write memo, post the check run with the §4 report).
- **The distinguishing component:** the worker runs an **untrusted, network- and
  filesystem-touching derivation per request** (consumer-named registries, tarballs,
  `pnpm`). Unlike a typical API-only App, it needs a real sandbox — ephemeral FS per
  job, egress filtering (SSRF), resource/time quotas. The "nothing executes" safety
  argument is load-bearing: §11 flags that honoring `.pnpmfile.cjs` later would force
  it to be rebuilt.

### Multi-tenant safety (assuming the App code is trusted)

Standard GitHub App multi-tenancy (per-installation tokens, per-org memo rulesets,
server-side ACLs) — the pattern CodeQL/Dependabot/Snyk use. GitHub gives token
isolation for free. What's specific to *this* App:

- **The sandbox is now cross-tenant** — derivations must not share FS/store/process,
  and egress must be filtered. Same work either way, but a shared instance is a juicier
  target.
- **Two trust requirements survive "trust the code":**
  - **The operator** — a shared instance holds the *one private key* (compromise = all
    tenants) and computes every verdict. Shared SaaS ⇒ trust the operator; self-hosting
    collapses operator == consumer and shrinks the blast radius. → offer a self-host path.
  - **Private registries** — an external App re-deriving a private-registry lockfile
    must hold each tenant's registry credentials (big liability). Clean multi-tenant case
    is **public-registry** repos; private-registry orgs likely **self-host**.
- **Availability is shared fate** — fail-closed means an outage blocks merges for all
  tenants at once. Safe, but an SLA concern a self-hoster doesn't impose on others.

The lever that would make a *shared* instance trustworthy without trusting the
operator: **signed / independently-reproducible verdicts** (Sigstore/OIDC or GitHub
artifact attestations — the §8 store-table growth path). Until then: self-host = trust
yourself; shared SaaS = trust code + operator.

## Rejected — per-PR memo comments (identity as signature)

Proposal: since the 2-PR attack rides a memo *transferring* between PRs, store the
memo as a **comment on the PR itself**, authored by the memo App; the check reads
only its own PR's comments, and the App's authorship serves as the signature.
Rejected — three independent breaks:

1. **Scoping the reader does not scope the writer.** The App token isn't scoped to
   the PR whose run minted it — no such scoping exists; a token that can comment can
   comment on **any PR in the repo**. The tampered PR #1's run simply posts the
   forged record **onto clean PR #2**. The 2-PR attack survives verbatim, with a
   different `PUT` target. And no server-enforced binding exists between a workflow
   run and the comments its token creates — a "this record belongs to PR #N" field
   is comment *content*, i.e. exactly what the attacker forges.
2. **Same-PR laundering revives it even under (hypothetical) per-PR write scoping.**
   Push 1 carries the workflow tampering + dishonest lockfile and posts the poisoned
   comment on its own PR; push 2 reverts the workflow file to main's version (no
   force-push needed — the tampering nets out of the final diff). Reviewers review
   the diff, not every intermediate commit; the final run executes the now-trusted
   workflow, hits the poisoned comment, passes. Binding records to the head SHA
   would block this — and gut the memo (surviving source-only pushes is its
   headline use case, spec §8).
3. **Authorship is not a signature, because comments are mutable.** Anyone with
   write access can edit or delete others' comments — a same-repo insider can
   rewrite an App-authored comment's content **with no token at all**; the
   authorship line still reads as the App. Policing `edited` badges / edit history
   puts fragile verification in the reader's trust path. The ruleset-protected
   branch has no edit surface: the server refuses non-App writes outright, admins
   included.

The invariant this confirms: **a memo's trustworthiness is fixed at write time, by
who could reach the credential — not by where the record is stored or how reads are
scoped.** Relocating the store relocates nothing. (Spec §8's rejected-alternatives
table encodes the same lesson for `GITHUB_TOKEN` check runs: a same-repo author can
self-grant `checks: write`.) And once the credential *is* properly gated, comments
buy nothing over the branch while costing an edit surface, local-form reads (no PR
exists at `prepush` time), and legitimate cross-PR/merge-queue hits.

## Open — hosting the worker

Where and how to run the isolated derivation worker (ephemeral container vs function,
egress controls, per-tenant quotas, cold-start vs always-warm, cost) is unsettled and
is the next thing to work through. To be filled in.

## References

- Spec §6 (anchor caveat), §7 (drift), §8 (durable verdicts / the store), §11 (roadmap:
  the external App service).
- `setup-github-app.md` §6.3 (the required-reviewer environment — the weaker third option).
