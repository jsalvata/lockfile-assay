import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StagingError } from '../../src/errors.js';
import { revParse } from '../../src/git.js';
import { collectStagedFiles, materialize } from '../../src/staging.js';
import { commitAll, makeRepo, writeFiles } from '../helpers/scratch-repo.js';

describe('staging', () => {
  it('stages head resolution inputs and the BASE lockfile', () => {
    const dir = makeRepo({
      'package.json': '{"name":"r"}',
      'pnpm-lock.yaml': 'BASE-LOCK',
      'packages/a/package.json': '{"name":"a"}',
      '.npmrc': 'registry=http://x/',
      'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
      'patches/p.patch': 'P',
      'src/index.ts': 'code',
    });
    const base = revParse('HEAD', dir);
    writeFiles(dir, { 'pnpm-lock.yaml': 'HEAD-LOCK', 'src/index.ts': 'changed' });
    const head = commitAll(dir, 'change');

    const files = collectStagedFiles({ baseRef: base, headRef: head, declared: [], cwd: dir });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.bytes.toString()]));
    expect(byPath['pnpm-lock.yaml']).toBe('BASE-LOCK'); // from base, not head
    expect(Object.keys(byPath).sort()).toEqual([
      '.npmrc',
      'package.json',
      'packages/a/package.json',
      'patches/p.patch',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
    ]); // no src/index.ts
    expect(files.map((f) => f.path)).toEqual([...files.map((f) => f.path)].sort()); // sorted

    const out = mkdtempSync(join(tmpdir(), 'assay-stage-'));
    materialize(files, out);
    expect(readFileSync(join(out, 'pnpm-lock.yaml'), 'utf8')).toBe('BASE-LOCK');
    expect(readFileSync(join(out, 'packages/a/package.json'), 'utf8')).toBe('{"name":"a"}');
  });

  it('omits the lockfile when base has none; includes declared patch paths', () => {
    const dir = makeRepo({ 'package.json': '{}', 'vendor/x.fix': 'F' });
    const head = revParse('HEAD', dir);
    const files = collectStagedFiles({
      baseRef: null,
      headRef: head,
      declared: ['vendor/x.fix'],
      cwd: dir,
    });
    const paths = files.map((f) => f.path);
    expect(paths).toContain('vendor/x.fix');
    expect(paths).not.toContain('pnpm-lock.yaml');
  });

  it('rejects path traversal', () => {
    expect(() =>
      materialize(
        [{ path: '../evil', bytes: Buffer.from('x') }],
        mkdtempSync(join(tmpdir(), 'a-')),
      ),
    ).toThrow();
  });

  it('rejects backslash path traversal', () => {
    expect(() =>
      materialize(
        [{ path: '..\\evil', bytes: Buffer.from('x') }],
        mkdtempSync(join(tmpdir(), 'a-')),
      ),
    ).toThrow();
  });

  it('never stages a head lockfile alias even when declared', () => {
    const dir = makeRepo({
      'package.json': '{"name":"r"}',
      'PNPM-LOCK.YAML': 'TAMPERED',
    });
    const head = revParse('HEAD', dir);
    const files = collectStagedFiles({
      baseRef: null,
      headRef: head,
      declared: ['PNPM-LOCK.YAML'],
      cwd: dir,
    });
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain('PNPM-LOCK.YAML');
    expect(paths.some((p) => p.toLowerCase() === 'pnpm-lock.yaml')).toBe(false);
  });

  it('materialize rejects lockfile aliases in any case or nesting', () => {
    const out = mkdtempSync(join(tmpdir(), 'a-'));
    expect(() => materialize([{ path: 'PNPM-LOCK.YAML', bytes: Buffer.from('x') }], out)).toThrow(
      StagingError,
    );
    expect(() =>
      materialize([{ path: 'nested/PNPM-lock.yaml', bytes: Buffer.from('x') }], out),
    ).toThrow(StagingError);
  });

  it('materialize writes the base root lockfile normally', () => {
    const out = mkdtempSync(join(tmpdir(), 'a-'));
    materialize([{ path: 'pnpm-lock.yaml', bytes: Buffer.from('BASE-LOCK') }], out);
    expect(readFileSync(join(out, 'pnpm-lock.yaml'), 'utf8')).toBe('BASE-LOCK');
  });
});
