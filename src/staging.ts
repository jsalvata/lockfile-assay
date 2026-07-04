import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { StagingError } from './errors.js';
import { catFile, lsTreePaths } from './git.js';

export type StagedFile = { path: string; bytes: Buffer };

const LOCKFILE_BASENAME = 'pnpm-lock.yaml';

// A path's final segment lowercased matching the lockfile name. On
// case-insensitive filesystems pnpm resolves `PNPM-LOCK.YAML` to the lockfile,
// so an alias in any case must be treated as the lockfile, not a plain input.
function isLockfileAlias(path: string): boolean {
  const segment = path.slice(path.lastIndexOf('/') + 1);
  return segment.toLowerCase() === LOCKFILE_BASENAME;
}

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
    throw new StagingError(path);
  }
  // A lockfile alias in any case would let head's tampered bytes re-enter as the
  // resolution cache on case-insensitive filesystems. Base's legitimate root
  // lockfile is appended under exactly `pnpm-lock.yaml`, so allow only that.
  // pnpm reads only the root lockfile during install; nested lockfile paths are
  // never that root entry, so they are rejected by the same basename guard.
  if (isLockfileAlias(path) && path !== LOCKFILE_BASENAME) {
    throw new StagingError(path);
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
    if (isLockfileAlias(path)) continue; // head's lockfile is the thing under test, never an input
    if (!isStagedInput(path, opts.declared)) continue;
    assertSafe(path);
    const bytes = catFile(opts.headRef, path, opts.cwd);
    if (bytes !== null) files.push({ path, bytes });
  }
  if (opts.baseRef !== null) {
    const baseLock = catFile(opts.baseRef, LOCKFILE_BASENAME, opts.cwd);
    if (baseLock !== null) files.push({ path: LOCKFILE_BASENAME, bytes: baseLock });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function materialize(files: StagedFile[], dir: string): void {
  for (const f of files) {
    assertSafe(f.path);
    const target = join(dir, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, f.bytes);
  }
}
