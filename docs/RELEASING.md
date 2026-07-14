# Releasing

Releases are automated. **semantic-release** runs on `main`, derives the next
version from the Conventional Commits since the last tag, updates the changelog,
tags, and publishes to npm. There is nothing to do by hand for a normal release
— merge to `main` and the pipeline ships it.

The `release` job lives in `.github/workflows/ci.yml` and is gated on
`needs: [test, integration]`, so a release can never publish while tests are
failing (the two used to race as separate `push: main` workflows).

## The version pins semantic-release rewrites (and the one it can't)

`scripts/set-release-version.sh` runs in the release's `prepare` step and pins
the new version into the two artifacts that must name it exactly:

- **`action.yml`** — the CLI version the composite action installs. This is what
  makes `uses: jsalvata/lockfile-assay@vX.Y.Z` pin the *code that runs*.
  `src/action-yml.test.ts` fails the build if it is ever unpinned.
- **`examples/lockfile-assay.yml`** — the action tag the reference workflow pins,
  so the copy-paste example never goes stale.

**The one it cannot touch: `.github/workflows/lockfile-assay.yml`** — this repo's
own dogfood gate, which also pins the action. A GitHub Actions `GITHUB_TOKEN` is
forbidden from pushing changes to files under `.github/workflows/`, so the
release cannot bump it. **Bump that pin by hand (a normal PR) after a release**
that you want the gate to run on. Forgetting is harmless-but-stale: the gate
simply keeps running the previous release.

## The `v*` tag ruleset is load-bearing — do not weaken it

The `action.yml` pin above is only worth as much as the **tag** that resolves it,
and that line is rewritten *during* the release that creates it, so it can never
be a SHA. Its integrity comes instead from the tag being immutable: the
**`immutable release tags`** ruleset — `refs/tags/v*`, `active`, restricting
**update**, **deletion** and **non-fast-forward**, **empty bypass list**. The
argument for why is spec §6, *"The workflow's own supply chain"*; what follows is
only what an operator must not break.

Three properties fail **quietly** when changed:

- **Creation stays UNrestricted.** semantic-release cuts a new `v*` tag every
  release; restricting creation breaks the pipeline outright. Tags are write-once:
  freely created, never moved.
- **The bypass list stays empty.** An admin bypass hands back the exact capability
  the ruleset removes — and the threat model includes a compromised maintainer.
- **Enforcement stays `active`.** `evaluate` looks identical in the UI and enforces
  nothing.

The accepted consequence: releases are **append-only**. A bad `v1.0.3` is
superseded by `v1.0.4`, never retagged.

## npm publishing — OIDC trusted publishing (no `NPM_TOKEN`)

Publishing is **tokenless**: the `release` job has `id-token: write` and npm's
[trusted publishing](https://docs.npmjs.com/trusted-publishers) exchanges the
workflow's OIDC identity for a short-lived publish credential — there is no
`NPM_TOKEN` secret to store or rotate. `@semantic-release/npm` (≥ 13) uses it
automatically when it is configured; otherwise it fails with `ENONPMTOKEN`.

**Setup on npmjs.com** (repo admin, one-time): on the `lockfile-assay` package →
*Settings → Trusted Publishing* → add a GitHub Actions publisher:

- Repository: `jsalvata/lockfile-assay`
- Workflow filename: `ci.yml`
- Environment: leave blank (the release job uses none)

## The one manual gate: the memo epoch

There is exactly one decision a release author must make that automation cannot:

> **If this release fixes a case where earlier releases could WRONGLY PASS, bump
> `EPOCH` in `src/memo/key.ts` in the same PR.**
>
> **When in doubt, bump** — the cost is one round of live re-derivation across
> open PRs (spec §8), and it fails closed.

### Why

A memo record says "these staged inputs derived this lockfile, and that was a
pass." If a release *tightens* the check (catches something it used to miss),
every memo minted by an older, laxer version may now be asserting a pass the new
version would reject. Those records are keyed under `EPOCH`; bumping the integer
invalidates all of them at once, forcing a fresh live derivation under the new
semantics. A record can only short-circuit to a pass, so a stale-but-not-bumped
memo is precisely how a fix could silently fail to take effect.

Keying on the epoch rather than the tool version is deliberate: the tool version
changes every release and would needlessly flush every open PR's memos each
time; the epoch changes only when the check's *pass semantics* changed in a way
that could have wrongly passed before. It lives as a source constant (not
config) so a binary can never write under an epoch it does not know about
(spec §8, "Epoch — revocation shipped with the validator").

### The rule of thumb

- **Bug fix / behavior change that could make a previously-passing input now
  fail** (a hole closed, a tightening) → **bump `EPOCH`**.
- Pure additive feature, docs, refactor, or a fix that only ever makes the check
  *more lenient* → no bump.
- **Not sure which?** → bump. Forgetting is silent (old memos keep short-
  circuiting); an unnecessary bump just costs one live re-derivation round.

Records always carry the writing tool version and a timestamp, so after an
incident "every pass minted by ≤ vX" is one query over the store — which is also
why old-epoch records are never pruned.
