import { describe, expect, it } from 'vitest';
import { makeRepo, sh, writeFiles } from '../test/helpers/scratch-repo.js';
import { CannotEvaluate } from './errors.js';
import { diffNamesIndex, remoteDefaultBranch, writeIndexTree } from './git.js';

describe('local-form plumbing', () => {
  it('writeIndexTree captures staged content and rejects unmerged indexes', () => {
    const dir = makeRepo({ 'a.txt': 'a' });
    writeFiles(dir, { 'b.txt': 'b' });
    sh(dir, 'git', ['add', 'b.txt']);
    expect(writeIndexTree(dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(diffNamesIndex(dir)).toEqual(['b.txt']);

    // conflicted merge → unmerged index → CannotEvaluate
    sh(dir, 'git', ['stash', '-u']);
    sh(dir, 'git', ['switch', '-qc', 'side']);
    writeFiles(dir, { 'a.txt': 'side' });
    sh(dir, 'git', ['commit', '-qam', 'side']);
    sh(dir, 'git', ['switch', '-q', 'main']);
    writeFiles(dir, { 'a.txt': 'main' });
    sh(dir, 'git', ['commit', '-qam', 'main']);
    try {
      sh(dir, 'git', ['merge', 'side']);
    } catch {
      /* conflict expected */
    }
    expect(() => writeIndexTree(dir)).toThrow(CannotEvaluate);
  });

  it('remoteDefaultBranch is null without a remote', () => {
    const dir = makeRepo({ 'a.txt': 'a' });
    expect(remoteDefaultBranch(dir)).toBeNull();
  });

  it('remoteDefaultBranch falls back to origin/master when there is no main', () => {
    const dir = makeRepo({ 'a.txt': 'a' });
    const sha = sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
    // a fetched remote whose default is master, with no origin/HEAD symref
    sh(dir, 'git', ['update-ref', 'refs/remotes/origin/master', sha]);
    expect(remoteDefaultBranch(dir)).toBe('origin/master');
  });
});
