import { spawnSync } from 'node:child_process';
import { remoteOriginUrl } from '../git.js';

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
  const url = remoteOriginUrl(cwd);
  if (url === null) return null;
  // Anchor `github.com` to the actual HOST: it must be immediately preceded by
  // `@` (ssh: `git@github.com:`) or `://` (https, with an optional `user@`
  // before the host). Without this anchor `github\.com` matches anywhere, so
  // `notgithub.com`/`evilgithub.com` would wrongly parse as an owner/name and a
  // memo write could target an unintended github.com repo.
  const m = /(?:@|:\/\/(?:[^/@]*@)?)github\.com[/:]([^/]+\/[^/]+?)(\.git)?$/.exec(url);
  return m?.[1] ?? null;
}

/**
 * The dedicated App's numeric id, from `LOCKFILE_ASSAY_APP_ID` (spec §8). Consult
 * filters check runs to this id — the security anchor that stops a same-named
 * `GITHUB_TOKEN`-authored check from being read as a record. Null (no id) simply
 * disables consult; a check never fails for lack of one.
 */
export function appId(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.LOCKFILE_ASSAY_APP_ID;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}
