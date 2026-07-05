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

export function isResolutionInput(path: string, declared: string[]): boolean {
  if (path === 'pnpm-lock.yaml' || path === 'pnpm-workspace.yaml') return true;
  if (path === 'package.json' || path.endsWith('/package.json')) return true;
  if (path === '.npmrc' || path.endsWith('/.npmrc')) return true;
  if (path.startsWith('patches/')) return true;
  if (path.endsWith('.patch') || path.endsWith('.diff')) return true;
  // A pnpmfile is executable resolution code — the PR that introduces one must
  // trigger so preflight can refuse it (spec §3: over-triggering is safe,
  // under-triggering never is). Same basename predicate as preflight's
  // presence scan: lowercased for case-insensitive filesystems.
  if (
    path
      .slice(path.lastIndexOf('/') + 1)
      .toLowerCase()
      .startsWith('.pnpmfile.')
  ) {
    return true;
  }
  // pnpm reads package.yaml/package.json5 as manifests, but v1 stages only
  // package.json — a PR introducing one must trigger so preflight can refuse it
  // (spec §3). Same case-insensitive basename predicate as the pnpmfile entry.
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'package.yaml' || base === 'package.json5') return true;
  return declared.includes(path);
}

export function isTriggered(changed: string[], declared: string[]): boolean {
  return changed.some((p) => isResolutionInput(p, declared));
}
