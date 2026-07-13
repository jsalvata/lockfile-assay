import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const TRUST_PATH = [
  'git.ts',
  'staging.ts',
  'preflight.ts',
  'toolchain.ts',
  'derive.ts',
  'verdict.ts',
];
const SRC = import.meta.dirname;

function importsOf(file: string): string[] {
  const text = readFileSync(join(SRC, file), 'utf8');
  return [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1] as string);
}

// Allowlist of trust-safe relative imports (spec §13): a trust-path module may
// import node builtins and these modules only. An allowlist, not a denylist — a
// denylist silently admits any new sibling (memo/, a future parser) a trust-path
// module must never reach; enumerate what is permitted instead.
const TRUST_SAFE = new Set([
  './errors.js',
  './outcome.js',
  './git.js',
  './staging.js',
  './preflight.js',
  './toolchain.js',
  './derive.js',
  './verdict.js',
]);

/** Every `.ts` file under src/, RECURSIVELY, as paths relative to SRC (posix `/`). */
function allSrcFiles(): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const child = join(abs, ent.name);
      if (ent.isDirectory()) walk(child);
      else if (ent.name.endsWith('.ts')) out.push(relative(SRC, child).split('\\').join('/'));
    }
  };
  walk(SRC);
  return out;
}

describe('spec §13 trust-path discipline', () => {
  it('trust-path modules import only node builtins and each other', () => {
    for (const file of TRUST_PATH) {
      for (const imp of importsOf(file)) {
        const ok = imp.startsWith('node:') || TRUST_SAFE.has(imp);
        expect(ok, `${file} imports ${imp}`).toBe(true);
      }
    }
  });

  // Walk ALL of src/ recursively (not a hand-maintained file list) so a yaml
  // import in any module — including subdirs like memo/ and report/, or a future
  // new module — is caught. An explicit enumeration had a blind spot: memo/* was
  // never scanned, so a yaml import there would give false "no violations".
  it('yaml is imported only by trigger and report/', () => {
    for (const file of allSrcFiles()) {
      const usesYaml = importsOf(file).some((i) => i === 'yaml');
      const allowed = file === 'trigger.ts' || file.startsWith('report/');
      if (usesYaml) expect(allowed, `${file} must not import yaml`).toBe(true);
    }
  });
});
