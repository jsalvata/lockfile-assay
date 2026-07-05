import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Registry } from './registry.js';
import { commitAll, makeRepo, sh } from './scratch-repo.js';

export const PNPM_VERSION = process.env.PNPM_FIXTURE_VERSION ?? '10.34.1';

export type Fixture = { dir: string; registry: Registry; base: string };

/** author path: re-derive the lockfile exactly as an honest author would */
export function relock(dir: string): void {
  // strip npm_config_* vars: the pnpm run-script driving vitest injects
  // npm_config_registry etc., which outrank the fixture's .npmrc
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
  );
  execFileSync('corepack', ['pnpm', 'install', '--lockfile-only', '--ignore-scripts'], {
    cwd: dir,
    env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
  });
}

export function readLock(dir: string): string {
  return readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8');
}

/** point origin at a clone of itself so origin/HEAD exists */
export function addSelfOrigin(dir: string): void {
  sh(dir, 'git', ['clone', '-q', '--bare', '.', join(dir, '.self.git')]);
  sh(dir, 'git', ['remote', 'add', 'origin', join(dir, '.self.git')]);
  sh(dir, 'git', ['fetch', '-q', 'origin']);
  sh(dir, 'git', ['remote', 'set-head', 'origin', '-a']);
}

/**
 * git repo wired to the hermetic registry: pnpm-pinned package.json, .npmrc → registry,
 * .lockfile-assay.json enforce, and an author-path lockfile committed as `base`.
 */
export async function makeFixtureRepo(
  registry: Registry,
  deps: Record<string, string> = {},
): Promise<Fixture> {
  const dir = makeRepo({
    'package.json': JSON.stringify(
      {
        name: 'fixture',
        version: '1.0.0',
        packageManager: `pnpm@${PNPM_VERSION}`,
        dependencies: deps,
      },
      null,
      2,
    ),
    '.npmrc': `registry=${registry.url}\n`,
    '.lockfile-assay.json': '{ "mode": "enforce" }',
  });
  relock(dir);
  const base = commitAll(dir, 'base with lockfile');
  return { dir, registry, base };
}
