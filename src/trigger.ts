import { parse } from 'yaml';

function values(obj: unknown): string[] {
  if (obj === null || typeof obj !== 'object') return [];
  return Object.values(obj as Record<string, unknown>).filter(
    (v): v is string => typeof v === 'string',
  );
}

export function declaredPatchPaths(
  workspaceYaml: Buffer | null,
  rootManifest: Buffer | null,
): string[] {
  const out: string[] = [];
  if (workspaceYaml) {
    try {
      const ws = parse(workspaceYaml.toString('utf8')) as { patchedDependencies?: unknown } | null;
      out.push(...values(ws?.patchedDependencies));
    } catch {
      /* unparseable workspace file: pnpm itself will fail loudly later; the trigger over-approximates elsewhere */
    }
  }
  if (rootManifest) {
    try {
      const pkg = JSON.parse(rootManifest.toString('utf8')) as {
        pnpm?: { patchedDependencies?: unknown };
      };
      out.push(...values(pkg?.pnpm?.patchedDependencies));
    } catch {
      /* same posture */
    }
  }
  return out;
}

// Whole-path patterns for the resolution inputs a change can move (spec §3). Any
// match means the assay must evaluate. The trigger only ever over-approximates:
// firing spuriously costs one derivation, missing a real input is a hole — so
// every pattern is case-insensitive. On a case-preserving filesystem pnpm
// resolves these basenames case-insensitively, and matching more paths here is
// always safe. The exact-case rules that decide what actually feeds the derive
// (src/staging.ts) or blocks it (src/preflight.ts) live there, not here.
const RESOLUTION_INPUT_PATTERNS: RegExp[] = [
  /(?:^|\/)pnpm-lock\.yaml$/i, // the lockfile itself
  /^pnpm-workspace\.yaml$/i, // root workspace manifest
  /(?:^|\/)package\.json$/i, // every package manifest, any depth
  /(?:^|\/)\.npmrc$/i, // every npmrc, any depth
  /^patches\//i, // conventional patch directory
  /\.(?:patch|diff)$/i, // patch files anywhere
  /(?:^|\/)\.pnpmfile\./i, // executable resolution hook
  /(?:^|\/)package\.(?:yaml|json5)$/i, // alt manifest formats pnpm also reads
];

export function isResolutionInput(path: string, declared: string[]): boolean {
  return RESOLUTION_INPUT_PATTERNS.some((re) => re.test(path)) || declared.includes(path);
}

export function isTriggered(changed: string[], declared: string[]): boolean {
  return changed.some((p) => isResolutionInput(p, declared));
}
