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
// match means the assay must evaluate; the set over-approximates on purpose, so
// an inert extra match is harmless while a miss is not. The lockfile, pnpmfile
// and alt-manifest patterns are case-insensitive — pnpm resolves those basenames
// case-insensitively on case-preserving filesystems, so an alias like
// `PNPM-LOCK.YAML` is still the lockfile (matching src/staging.ts and preflight's
// presence scan). package.json/.npmrc stay case-sensitive, matching what staging
// actually materializes.
const RESOLUTION_INPUT_PATTERNS: RegExp[] = [
  /(?:^|\/)pnpm-lock\.yaml$/i, // the lockfile itself, in any case
  /^pnpm-workspace\.yaml$/, // root workspace manifest
  /(?:^|\/)package\.json$/, // every package manifest, any depth
  /(?:^|\/)\.npmrc$/, // every npmrc, any depth
  /^patches\//, // conventional patch directory
  /\.(?:patch|diff)$/, // patch files anywhere
  /(?:^|\/)\.pnpmfile\./i, // executable resolution hook, in any case
  /(?:^|\/)package\.(?:yaml|json5)$/i, // alt manifest formats pnpm also reads
];

export function isResolutionInput(path: string, declared: string[]): boolean {
  return RESOLUTION_INPUT_PATTERNS.some((re) => re.test(path)) || declared.includes(path);
}

export function isTriggered(changed: string[], declared: string[]): boolean {
  return changed.some((p) => isResolutionInput(p, declared));
}
