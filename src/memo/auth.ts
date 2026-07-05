import { spawnSync } from 'node:child_process';
import { git } from '../git.js';

/**
 * Discover a GitHub token for memo reads/writes (spec §8). Chain, first hit
 * wins: explicit `LOCKFILE_ASSAY_TOKEN` → ambient `GITHUB_TOKEN` → `gh auth
 * token` (whatever the developer is already logged in as) → null. A null token
 * simply disables the memo — a check never fails for lack of one.
 */
export function discoverToken(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.LOCKFILE_ASSAY_TOKEN) return env.LOCKFILE_ASSAY_TOKEN;
  if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
  const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', env });
  const token = r.status === 0 ? r.stdout.trim() : '';
  return token || null;
}

/**
 * Resolve the `owner/name` of the `origin` remote from its URL (spec §8),
 * handling both the ssh (`git@github.com:owner/name.git`) and https
 * (`https://github.com/owner/name.git`) forms and stripping a trailing `.git`.
 * Returns null when there is no origin or it is not a github remote.
 */
export function originRepo(cwd?: string): string | null {
  const r = git(['remote', 'get-url', 'origin'], { cwd });
  if (r.status !== 0) return null;
  const url = r.stdout.toString().trim();
  const m = /github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/.exec(url);
  return m?.[1] ?? null;
}
