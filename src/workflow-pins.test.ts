import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Every third-party action a workflow invokes runs with whatever that job holds:
// the assay gate hands `create-github-app-token` the App private key (it MINTS
// the token whose identity the anchor rests on — spec §6), and the release job
// holds `contents: write` plus an npm OIDC identity. A git TAG is mutable, so
// `uses: foo@v4` says "run whatever v4 points at when this fires" — a range, not
// a pin, and exactly the trust this tool refuses to grant a lockfile. A commit
// SHA is a content hash and cannot be moved.
//
// This is the workflow-level twin of the action.yml pin guard: same failure mode
// (a pin that does not pin), same grep-level defence. It fails the build if any
// third-party `uses:` reverts to a tag.
const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);
const EXAMPLES = new URL('../examples/', import.meta.url);

/** The first-party action is exempt: its tag is rewritten on every release
 * before the release commit exists, so it CANNOT be SHA-pinned by construction
 * (docs/RELEASING.md). It is held immutable by a `v*` tag ruleset instead, and
 * the code it executes is pinned again inside action.yml. */
const FIRST_PARTY = 'jsalvata/lockfile-assay';

const SHA = /^[0-9a-f]{40}$/;

function ymlFiles(dir: URL): { name: string; body: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((f) => ({ name: f, body: readFileSync(new URL(f, dir), 'utf8') }));
}

/** Every `uses:` ref in a workflow, as `{ action, ref }`. Ignores local (`./…`)
 * and docker (`docker://…`) forms, which have no git ref to pin. */
function usesRefs(body: string): { action: string; ref: string }[] {
  const out: { action: string; ref: string }[] = [];
  for (const m of body.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
    const spec = m[1] as string;
    if (spec.startsWith('./') || spec.startsWith('docker://')) continue;
    const at = spec.lastIndexOf('@');
    if (at === -1) continue;
    out.push({ action: spec.slice(0, at), ref: spec.slice(at + 1) });
  }
  return out;
}

const files = [...ymlFiles(WORKFLOWS), ...ymlFiles(EXAMPLES)];

describe('workflows pin third-party actions by commit SHA', () => {
  it('finds the workflows to check (a bad glob must not vacuously pass)', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((f) => usesRefs(f.body)).length).toBeGreaterThan(0);
  });

  for (const { name, body } of files) {
    const thirdParty = usesRefs(body).filter((u) => u.action !== FIRST_PARTY);
    if (thirdParty.length === 0) continue;

    it(`${name}: every third-party uses: is a 40-hex SHA, never a tag`, () => {
      const tagPinned = thirdParty
        .filter((u) => !SHA.test(u.ref))
        .map((u) => `${u.action}@${u.ref}`);
      expect(tagPinned).toEqual([]);
    });
  }

  it('the first-party action stays a tag (it cannot self-pin — see RELEASING.md)', () => {
    const firstParty = files
      .flatMap((f) => usesRefs(f.body))
      .filter((u) => u.action === FIRST_PARTY);
    expect(firstParty.length).toBeGreaterThan(0);
    for (const u of firstParty) expect(u.ref).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});
