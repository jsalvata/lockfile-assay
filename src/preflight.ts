import type { StagedFile } from './staging.js';

const NPMRC_KEYS = /^\s*(global-pnpmfile|pnpmfile|ignore-pnpmfile)\s*=/m;
// Value must be lowercase `false` — pnpm's ini reader coerces only that spelling;
// `FALSE` is a truthy string. Optional matched quotes, trailing whitespace and
// inline `#`/`;` comments allowed (no bare `$` anchor so trailing content can't
// defeat the match).
const NPMRC_SPLIT = /^\s*shared-workspace-lockfile\s*=\s*(["']?)false\1\s*(?:[#;]|$)/m;
const WS_KEYS = /^\s*(pnpmfile|ignorePnpmfile)\s*:/m;
// YAML booleans are case-insensitive on the value (false/False/FALSE), keys are
// not. No quote tolerance: the yaml parser reads a *quoted* value as the truthy
// string "false", so pnpm keeps the shared lockfile — such a repo is valid and
// must not be flagged. Trailing whitespace and `#` comments allowed.
const WS_SPLIT = /^\s*sharedWorkspaceLockfile\s*:\s*(?:false|False|FALSE)\s*(?:#|$)/m;

// The pnpmfile itself is never staged (its bytes are executable resolution
// code), so presence is detected from the head tree's path list alone.
function isPnpmfilePath(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.toLowerCase().startsWith('.pnpmfile.');
}

// pnpm reads package.yaml/package.json5 as workspace-package manifests, but v1
// staging only materializes package.json. Detected from the head tree's path
// list (presence-based, case-insensitive basename — like the lockfile-alias guard).
function isAltManifest(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return base === 'package.yaml' || base === 'package.json5';
}

export function unsupportedInputs(files: StagedFile[], headPaths: string[]): string[] {
  const reasons: string[] = [];
  for (const path of headPaths) {
    if (isPnpmfilePath(path)) {
      reasons.push(`${path}: pnpmfile is executable resolution code — unsupported in v1 (spec §3)`);
    }
    if (isAltManifest(path)) {
      reasons.push(
        `${path}: pnpm reads package.yaml/package.json5 as a manifest, but v1 stages only package.json — unsupported (spec §3)`,
      );
    }
  }
  for (const { path, bytes } of files) {
    const base = path.split('/').pop() ?? path;
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
