# Anchoring the check — threat model and the serverless anchor

Working notes from the design discussion that produced the anchored form now in
spec §6/§8 and `setup-github-app.md` (those are normative; this records *why*).
Also tracks the migration of this repo's own dogfood deployment.

## The threat model

The memo can only short-circuit to a **pass** — never a failure (spec §8) — so
the only thing that must be trustworthy is **who can write records**. A poisoned
record asserts *"input-set H derives lockfile L"*; a later clean-looking PR that
presents the same inputs H rides the remembered pass, shipping a lockfile no live
derivation ever vetted.

The subtlety that makes this real: a `pull_request` workflow runs **when the PR
is opened or updated, before merge**, and — for a same-repo PR — that run gets
secrets and executes the workflow file **as modified on the PR head**. So the
attack needs no merge:

1. **PR #1** modifies the workflow to write a poisoned record. Its run mints the
   writer credential and writes the poison at open time — a side effect that
   persists independently of the PR. The attacker **closes PR #1 unmerged** — no
   reviewer ever evaluates it for merge.
2. **PR #2** is clean (no workflow changes) and presents the same inputs. It
   rides the poisoned record → false pass → merges, the reviewer seeing a
   spotless diff.

"A human reviewer would spot the workflow tampering" does **not** save you: the
tampering PR is never offered for merge. The write happens at *run* time, a
moment with no merge-review checkpoint.

Nor is this memo-specific. Spec §6's anchor caveat says *any* required check "is
only as strong as what prevents the PR from editing its wiring" — a same-repo PR
that can rewrite the gate workflow can force the base check green too, memo or
no memo. The memo just adds a second, write-capable surface.

## The adopted design — the serverless anchor

Two server-enforced GitHub facts close both surfaces at once, with **no service
to host** (spec §6/§8, setup in `setup-github-app.md`):

- **`pull_request_target`** executes the *base branch's* workflow definition —
  a PR can neither edit the definition that runs nor smuggle in a replacement
  (a `pull_request_target` workflow added by a PR does not trigger). The App's
  secrets sit on a deployment-branch-restricted Environment that refuses any
  PR-context run, including newly added `pull_request` workflows.
- **The verdict is a check run posted by a dedicated App**, and branch
  protection requires that check *from that App's identity*. Check-run
  authorship is set server-side from the token and only the creating App can
  update its runs — a self-granted `GITHUB_TOKEN` check cannot satisfy the
  requirement, and no collaborator can edit a posted verdict.
- **The memo record rides inside the check run itself** — the write ACL for the
  memo *is* the write ACL for the verdict. No second store, no second
  permission, nothing to misconfigure.

Why identity-as-signature works here when it failed elsewhere (see the comment
scheme below): both preconditions hold — the credential is unreachable from
PR-controlled context, *and* the artifact's authorship and immutability are
server-enforced rather than policed by the reader.

The safety case for running privileged evaluation over PR content is the spec's
inertness argument (§3: `--ignore-scripts`, no `.pnpmfile.cjs`, nothing
executes) — which is why the anchored workflow must execute nothing
head-controlled. That discipline is load-bearing; §11 already notes that ever
honoring `.pnpmfile.cjs` would force this argument to be rebuilt.

## Migration status (this repo)

The design above is adopted in the docs; the implementation does not exist yet,
so **dogfooding is removed until it does** — the interim branch-store deployment
would have shipped a design we've already superseded, and running the assay on
itself with no anchored backend is worse than not running it. Removed: the local
hooks' assay invocation, `.github/workflows/assay.yml`, the `ci.yml` dogfood
step, and `.lockfile-assay.json`; the GitHub-side App / environment / secrets /
memo branch / ruleset are torn down too. The reference artifacts consumers use
(`examples/assay.yml`, `action.yml`, the setup doc) stay — they describe the
anchored form, not this repo's deployment.

Re-adoption, once the backend lands, runs the **published**
`setup-github-app.md` from a clean slate (which also validates those
instructions end to end):

- **CLI first:** `memo/store.ts` targets the Contents API; it needs the Checks
  API backend (post the verdict check run, embed/consult records). The §13
  backend interface was built for this swap.
- **Then dogfood** the anchored form: a fresh Checks-R/W App, a
  deployment-branch-restricted environment, a `pull_request_target` gate running
  the *pinned published* assay, and head's CLI exercised separately in a
  token-less `pull_request` job.

## Rejected alternatives

**Required-reviewer environment (the interim dogfood posture).** Gates the
credential behind a human approval per run. Works, but the approval is
vigilance-dependent — it only helps if the approver notices the run came from a
workflow-editing PR, which the approval UI does not surface — and the per-run
friction is unacceptable beyond a solo repo.

**Post-merge-only writes (`push: main` workflow + branch-restricted secrets).**
Sound and zero-infra: PR runs are token-less (memo silently disabled, live
re-derive), the only writer runs the reviewed definition on `main`. Superseded
by the serverless anchor, which achieves the same credential unreachability
*pre-merge* — keeping within-PR memo hits — and anchors the verdict itself, not
just the memo.

**Per-PR memo comments (identity as signature).** Store the record as an
App-authored comment on the PR; scope reads to the PR. Three independent breaks:

1. *Scoping the reader does not scope the writer.* The token can comment on
   **any** PR — the tampered PR simply posts the forged record onto the clean
   one; no server-enforced binding ties a run to the comments it creates.
2. *Same-PR laundering.* Push 1 carries the tampering and posts the poison;
   push 2 reverts the workflow file (no force-push needed — the tampering nets
   out of the final diff). Reviewers review the diff, not every intermediate
   commit. Binding records to the head SHA would block this — and gut the memo
   (surviving source-only pushes is its headline use case).
3. *Comments are mutable.* Write-access collaborators can edit or delete
   others' comments — content forgery with no token at all; authorship still
   reads as the App. Policing edit history puts fragile verification in the
   reader's trust path.

**Orphan-branch memo store (the original spec §8 choice).** An orphan branch
written via the Contents API, a repository ruleset making the App the sole
allowed pusher. Sound — but it guards the record with a *second* ACL (Contents:
write + a ruleset) that a human must provision and target correctly, and its
misconfiguration **fails silent-insecure**: a missing or mistargeted ruleset
leaves the branch writable by anyone, with nothing visibly wrong. Check runs
carry the same record under the verdict channel's server-inherent ACL —
unforgeable authorship, no edit surface, nothing to provision. What the branch
did better — a grep-able append-only audit ledger, content-keyed cross-PR
hits — is not worth a second trust surface; incident queries ("every pass
minted by ≤ vX") remain possible as an API scan over the App's check runs.

**An external verification service as a security requirement.** A
webhook-backed App re-deriving outside the repo's CI would also dissolve the
anchor caveat — at the cost of real infrastructure: a receiver, a queue, and a
per-request sandbox running untrusted, network-touching derivations (egress
filtering, per-tenant isolation), plus operator trust (one private key for all
tenants) and custody of private-registry credentials the consumer's CI already
holds natively. The serverless anchor delivers the same integrity with none of
that. A hosted service remains on the roadmap (spec §11) purely as
productization — multi-tenant hosting for repos that would rather install an
App than own a workflow — where signed / independently reproducible verdicts
(artifact attestations, §8) would soften the operator-trust requirement.

## References

- Spec §6 (anchoring), §7 (drift), §8 (durable verdicts — the store), §11
  (roadmap), §13 (implementation).
- [`setup-github-app.md`](setup-github-app.md) — the anchored-form setup.
