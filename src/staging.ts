import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { catFile, lsTreePaths } from './git.js';

export type StagedFile = { path: string; bytes: Buffer };

function isStagedInput(path: string, declared: string[]): boolean {
  if (path === 'pnpm-workspace.yaml') return true;
  if (path === 'package.json' || path.endsWith('/package.json')) return true;
  if (path === '.npmrc' || path.endsWith('/.npmrc')) return true;
  if (path.startsWith('patches/')) return true;
  if (path.endsWith('.patch') || path.endsWith('.diff')) return true;
  return declared.includes(path);
}

function assertSafe(path: string): void {
  // Backslash rejection guards Windows, where `join` treats `..\` as a traversal
  // that the `/`-split check below would miss. Git separators are always `/`.
  if (path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw new Error(`unsafe staged path: ${path}`);
  }
}

export function collectStagedFiles(opts: {
  baseRef: string | null;
  headRef: string;
  declared: string[];
  cwd?: string;
}): StagedFile[] {
  const files: StagedFile[] = [];
  for (const path of lsTreePaths(opts.headRef, opts.cwd)) {
    if (path === 'pnpm-lock.yaml') continue; // head's lockfile is the thing under test, never an input
    if (!isStagedInput(path, opts.declared)) continue;
    assertSafe(path);
    const bytes = catFile(opts.headRef, path, opts.cwd);
    if (bytes !== null) files.push({ path, bytes });
  }
  if (opts.baseRef !== null) {
    const baseLock = catFile(opts.baseRef, 'pnpm-lock.yaml', opts.cwd);
    if (baseLock !== null) files.push({ path: 'pnpm-lock.yaml', bytes: baseLock });
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function materialize(files: StagedFile[], dir: string): void {
  for (const f of files) {
    assertSafe(f.path);
    const target = join(dir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.bytes);
  }
}
