import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { derive } from '../../src/derive.js';
import { UsageError } from '../../src/errors.js';
import { derivationEnv, effectivePnpmVersion, parsePin } from '../../src/toolchain.js';

const PNPM = process.env.PNPM_FIXTURE_VERSION ?? '10.34.1';

function stagedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'assay-derive-'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 't', version: '1.0.0', packageManager: `pnpm@${PNPM}` }),
  );
  return dir;
}

describe('toolchain', () => {
  it('parsePin demands a pnpm pin', () => {
    expect(parsePin(Buffer.from(JSON.stringify({ packageManager: 'pnpm@10.34.1' })))).toEqual({
      version: '10.34.1',
    });
    expect(() => parsePin(null)).toThrow(UsageError);
    expect(() => parsePin(Buffer.from('{}'))).toThrow(UsageError);
    expect(() => parsePin(Buffer.from(JSON.stringify({ packageManager: 'yarn@4.0.0' })))).toThrow(
      UsageError,
    );
  });

  it('derivationEnv strips npm_config_* so env cannot outrank the staged .npmrc', () => {
    const env = derivationEnv({
      npm_config_registry: 'http://evil/',
      npm_config_foo: 'x',
      PATH: '/usr/bin',
      HOME: '/h',
    });
    expect(Object.keys(env).some((k) => /^npm_config_/i.test(k))).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/h');
    expect(env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe('0');
  });

  it('derivationEnv strips npm_config_* case-insensitively', () => {
    const env = derivationEnv({ NPM_CONFIG_REGISTRY: 'http://evil/', PATH: '/usr/bin' });
    expect(Object.keys(env).some((k) => /^npm_config_/i.test(k))).toBe(false);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe('0');
  });

  it('effective version honors the staged pin', () => {
    expect(effectivePnpmVersion(stagedDir())).toBe(PNPM);
  });

  it('derive writes a lockfile for a zero-dep project and is idempotent', () => {
    const dir = stagedDir();
    const first = derive(dir);
    if (!first.ok) throw new Error(first.stderr);
    expect(existsSync(join(dir, 'node_modules'))).toBe(false); // --lockfile-only
    const second = derive(dir);
    if (!second.ok) throw new Error(second.stderr);
    expect(second.lockfile.equals(first.lockfile)).toBe(true);
  });
});
