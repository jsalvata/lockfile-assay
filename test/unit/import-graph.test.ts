import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const TRUST_PATH = [
  'git.ts',
  'staging.ts',
  'preflight.ts',
  'toolchain.ts',
  'derive.ts',
  'verdict.ts',
];
const SRC = join(import.meta.dirname, '../../src');

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

describe('spec §13 trust-path discipline', () => {
  it('trust-path modules import only node builtins and each other', () => {
    for (const file of TRUST_PATH) {
      for (const imp of importsOf(file)) {
        const ok = imp.startsWith('node:') || TRUST_SAFE.has(imp);
        expect(ok, `${file} imports ${imp}`).toBe(true);
      }
    }
  });

  it('yaml is imported only by trigger and report/', () => {
    const all = [
      'trigger.ts',
      'config.ts',
      'check.ts',
      'cli.ts',
      'outcome.ts',
      'errors.ts',
      ...TRUST_PATH,
    ];
    const reportFiles = readdirSync(join(SRC, 'report')).map((f) => `report/${f}`);
    for (const file of [...all, ...reportFiles]) {
      const usesYaml = importsOf(file).some((i) => i === 'yaml');
      const allowed = file === 'trigger.ts' || file.startsWith('report/');
      if (usesYaml) expect(allowed, `${file} must not import yaml`).toBe(true);
    }
  });
});
