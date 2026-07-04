import { spawnSync } from 'node:child_process';
import { UsageError } from './errors.js';

export type Pin = { version: string };

export function parsePin(rootManifest: Buffer | null): Pin {
  if (rootManifest === null) throw new UsageError('head has no root package.json');
  let pm: unknown;
  try {
    pm = (JSON.parse(rootManifest.toString('utf8')) as { packageManager?: unknown }).packageManager;
  } catch {
    throw new UsageError('head root package.json is not valid JSON');
  }
  const m = typeof pm === 'string' ? /^pnpm@(\S+)$/.exec(pm) : null;
  if (!m?.[1]) throw new UsageError('packageManager must pin pnpm (e.g. "pnpm@10.34.1") — spec §3');
  return { version: m[1] };
}

let launcher: string[] | null = null;
export function pnpmLauncher(): string[] {
  if (launcher) return launcher;
  const probe = spawnSync('corepack', ['--version']);
  launcher = probe.error || probe.status !== 0 ? ['pnpm'] : ['corepack', 'pnpm'];
  return launcher;
}

export function run(
  args: string[],
  dir: string,
): { status: number; stdout: Buffer; stderr: Buffer } {
  const [cmd, ...pre] = pnpmLauncher();
  const r = spawnSync(cmd as string, [...pre, ...args], {
    cwd: dir,
    env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

export function effectivePnpmVersion(dir: string): string {
  const r = run(['--version'], dir);
  if (r.status !== 0) throw new Error(`cannot determine pnpm version: ${r.stderr.toString()}`);
  return r.stdout.toString().trim().split('\n').pop() as string;
}
