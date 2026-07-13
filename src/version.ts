import { readFileSync } from 'node:fs';

/**
 * The tool's own version, read from package.json at runtime. `npm_package_version`
 * is UNSET when a git hook invokes node directly (spec §12 Q7), so reading the env
 * var alone stamps every memo record's `toolVersion` as 'unknown' and defeats its
 * diagnostic purpose. Read package.json (relative to this module) instead, in a
 * try/catch so it never throws — a missing/garbled package.json degrades to
 * 'unknown', never a crash.
 */
export function toolVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return (pkg.version as string) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
