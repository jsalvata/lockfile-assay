import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appId, discoverToken, originRepo } from './auth.js';

// The token chain and origin parsing (spec §13) are consumed by the memo backend;
// they are exercised directly here so they stay covered independently of any one
// caller.

describe('originRepo — owner/name from the origin remote', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'assay-originrepo-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const withOrigin = (url: string) =>
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir });

  it('parses the ssh form', () => {
    withOrigin('git@github.com:octo/assay.git');
    expect(originRepo(dir)).toBe('octo/assay');
  });

  it('parses the https form', () => {
    withOrigin('https://github.com/octo/assay.git');
    expect(originRepo(dir)).toBe('octo/assay');
  });

  it('is null when there is no origin remote', () => {
    expect(originRepo(dir)).toBeNull();
  });

  it('is null for a non-github host', () => {
    withOrigin('git@gitlab.com:octo/assay.git');
    expect(originRepo(dir)).toBeNull();
  });

  // The host must be github.com itself, not a suffix of some other host — else a
  // memo write could target an unintended repo. Anchor guard, both transports.
  it('is null for a look-alike host that only ends in github.com', () => {
    withOrigin('git@evilgithub.com:octo/assay.git');
    expect(originRepo(dir)).toBeNull();
    execFileSync('git', ['remote', 'set-url', 'origin', 'https://notgithub.com/octo/assay.git'], {
      cwd: dir,
    });
    expect(originRepo(dir)).toBeNull();
  });
});

describe('discoverToken — first hit in the credential chain', () => {
  it('prefers the explicit LOCKFILE_ASSAY_TOKEN', () => {
    expect(
      discoverToken({ LOCKFILE_ASSAY_TOKEN: 'ghs_explicit', GITHUB_TOKEN: 'ghs_ambient' }),
    ).toBe('ghs_explicit');
  });

  it('falls back to the ambient GITHUB_TOKEN', () => {
    expect(discoverToken({ GITHUB_TOKEN: 'ghs_ambient' })).toBe('ghs_ambient');
  });

  it('is null with no env token and no discoverable gh', () => {
    // empty PATH so `gh` is unfindable and no env token is set → no token
    const noPath = mkdtempSync(join(tmpdir(), 'assay-nogh-'));
    try {
      expect(discoverToken({ PATH: noPath })).toBeNull();
    } finally {
      rmSync(noPath, { recursive: true, force: true });
    }
  });
});

describe('appId — the App identity for the consult filter', () => {
  it('reads a positive integer from LOCKFILE_ASSAY_APP_ID', () => {
    expect(appId({ LOCKFILE_ASSAY_APP_ID: '12345' })).toBe(12345);
  });
  it('is null when unset', () => {
    expect(appId({})).toBeNull();
  });
  it('is null for a non-integer or non-positive value', () => {
    expect(appId({ LOCKFILE_ASSAY_APP_ID: 'abc' })).toBeNull();
    expect(appId({ LOCKFILE_ASSAY_APP_ID: '0' })).toBeNull();
    expect(appId({ LOCKFILE_ASSAY_APP_ID: '1.5' })).toBeNull();
  });
});
