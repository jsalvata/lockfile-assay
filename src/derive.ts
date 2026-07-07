import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './toolchain.js';

export const INVOCATION =
  'pnpm install --lockfile-only --ignore-scripts --prefer-frozen-lockfile --ignore-pnpmfile';

export type DeriveResult =
  | { ok: true; lockfile: Buffer }
  | { ok: false; status: number; stderr: string };

export function derive(dir: string): DeriveResult {
  const args = INVOCATION.split(' ').slice(1); // drop leading 'pnpm' — the launcher supplies it
  const r = run(args, dir);
  if (r.status !== 0) return { ok: false, status: r.status, stderr: r.stderr.toString() };
  return { ok: true, lockfile: readFileSync(join(dir, 'pnpm-lock.yaml')) };
}
