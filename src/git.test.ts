import { describe, expect, it } from 'vitest';
import { commitAll, makeRepo, writeFiles } from '../test/helpers/scratch-repo.js';
import { UsageError } from './errors.js';
import { catFile, diffNames, lsTreePaths, mergeBase, revParse } from './git.js';

describe('git plumbing', () => {
  it('revParse resolves and rejects', () => {
    const dir = makeRepo({ 'a.txt': 'a' });
    expect(revParse('HEAD', dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(() => revParse('nope-ref', dir)).toThrow(UsageError);
  });

  it('catFile returns bytes or null', () => {
    const dir = makeRepo({ 'a.txt': 'hello' });
    expect(catFile('HEAD', 'a.txt', dir)?.toString()).toBe('hello');
    expect(catFile('HEAD', 'missing.txt', dir)).toBeNull();
  });

  it('lsTreePaths and diffNames see the tree and the delta', () => {
    const dir = makeRepo({ 'a.txt': 'a', 'pkg/package.json': '{}' });
    const base = revParse('HEAD', dir);
    writeFiles(dir, { 'b.txt': 'b' });
    const head = commitAll(dir, 'add b');
    expect(lsTreePaths(head, dir).sort()).toEqual(['a.txt', 'b.txt', 'pkg/package.json']);
    expect(diffNames(base, head, dir)).toEqual(['b.txt']);
    expect(mergeBase(base, head, dir)).toBe(base);
  });
});
