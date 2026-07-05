import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export function sh(cwd: string, cmd: string, args: string[]): string {
  // strip npm_config_* vars (mirrors relock/derivationEnv): the pnpm run-script
  // driving vitest injects npm_config_registry etc., which outrank a fixture's
  // .npmrc and would let pnpm resolve from real npmjs instead of the hermetic
  // registry. Harmless for git; hermetic for pnpm.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
  );
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env });
}

/** git repo in a temp dir; returns its path. files = { 'relative/path': 'content' } */
export function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'assay-repo-'));
  sh(dir, 'git', ['init', '-q', '-b', 'main']);
  sh(dir, 'git', ['config', 'user.email', 'test@test']);
  sh(dir, 'git', ['config', 'user.name', 'test']);
  writeFiles(dir, files);
  commitAll(dir, 'initial');
  return dir;
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

export function commitAll(dir: string, msg: string): string {
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-qm', msg]);
  return sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
}
