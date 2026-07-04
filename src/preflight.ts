import type { StagedFile } from './staging.js';

const NPMRC_KEYS = /^\s*(pnpmfile|ignore-pnpmfile)\s*=/m;
const NPMRC_SPLIT = /^\s*shared-workspace-lockfile\s*=\s*false\s*$/m;
const WS_KEYS = /^\s*(pnpmfile|ignorePnpmfile)\s*:/m;
const WS_SPLIT = /^\s*sharedWorkspaceLockfile\s*:\s*false\s*$/m;

export function unsupportedInputs(files: StagedFile[]): string[] {
  const reasons: string[] = [];
  for (const { path, bytes } of files) {
    const base = path.split('/').pop() ?? path;
    if (base.startsWith('.pnpmfile.')) {
      reasons.push(`${path}: pnpmfile is executable resolution code — unsupported in v1 (spec §3)`);
      continue;
    }
    const text = () => bytes.toString('utf8');
    if (base === '.npmrc') {
      if (NPMRC_KEYS.test(text()))
        reasons.push(`${path}: pnpmfile/ignore-pnpmfile config — unsupported in v1`);
      if (NPMRC_SPLIT.test(text()))
        reasons.push(
          `${path}: shared-workspace-lockfile=false splits the root lockfile — unsupported in v1`,
        );
    }
    if (path === 'pnpm-workspace.yaml') {
      if (WS_KEYS.test(text())) reasons.push(`${path}: pnpmfile config — unsupported in v1`);
      if (WS_SPLIT.test(text()))
        reasons.push(`${path}: sharedWorkspaceLockfile: false — unsupported in v1`);
    }
  }
  return reasons;
}
