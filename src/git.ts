import { spawnSync } from 'node:child_process';
import { CannotEvaluate, UsageError } from './errors.js';

type GitResult = { status: number; stdout: Buffer; stderr: Buffer };

function git(args: string[], opts: { cwd?: string; stdin?: string | Buffer } = {}): GitResult {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    input: opts.stdin,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export function revParse(ref: string, cwd?: string, opts: { allowTree?: boolean } = {}): string {
  // with allowTree the ref resolves to its TREE oid (a commit is peeled), so
  // any tree-ish — commit sha, index tree from write-tree — becomes readable
  // via catFile/lsTreePaths under one identifier
  const suffix = opts.allowTree ? '^{tree}' : '^{commit}';
  const r = git(['rev-parse', '--verify', `${ref}${suffix}`], { cwd });
  if (r.status !== 0) throw new UsageError(`unresolvable ref: ${ref}`);
  return r.stdout.toString().trim();
}

export function catFile(ref: string, path: string, cwd?: string): Buffer | null {
  const r = git(['cat-file', 'blob', `${ref}:${path}`], { cwd });
  return r.status === 0 ? r.stdout : null;
}

export function lsTreePaths(ref: string, cwd?: string): string[] {
  const r = git(['ls-tree', '-r', '--name-only', '-z', ref], { cwd });
  if (r.status !== 0) throw new UsageError(`cannot list tree: ${ref}`);
  return r.stdout.toString().split('\0').filter(Boolean);
}

export function diffNames(base: string, head: string, cwd?: string): string[] {
  const r = git(['diff', '--name-only', '-z', base, head], { cwd });
  if (r.status !== 0) throw new UsageError(`cannot diff ${base}..${head}`);
  return r.stdout.toString().split('\0').filter(Boolean);
}

export function mergeBase(a: string, b: string, cwd?: string): string | null {
  const r = git(['merge-base', a, b], { cwd });
  return r.status === 0 ? r.stdout.toString().trim() : null;
}

export function writeIndexTree(cwd?: string): string {
  const r = git(['write-tree'], { cwd });
  if (r.status !== 0) {
    throw new CannotEvaluate(
      `cannot snapshot the index (unmerged entries?): ${r.stderr.toString().trim()}`,
    );
  }
  return r.stdout.toString().trim();
}

export function diffNamesIndex(cwd?: string): string[] {
  const r = git(['diff', '--name-only', '-z', '--cached'], { cwd });
  if (r.status !== 0) throw new CannotEvaluate('cannot diff the index');
  return r.stdout.toString().split('\0').filter(Boolean);
}

export function remoteDefaultBranch(cwd?: string): string | null {
  const r = git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd });
  if (r.status === 0) return r.stdout.toString().trim().replace('refs/remotes/', '');
  const probe = git(['rev-parse', '--verify', '--quiet', 'origin/main'], { cwd });
  return probe.status === 0 ? 'origin/main' : null;
}
