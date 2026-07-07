import { describe, expect, it } from 'vitest';
import { diffExcerpt, refreshRecipe, renderJson } from './report/render.js';

describe('render', () => {
  it('refresh recipe restores base, or deletes when base had none', () => {
    expect(refreshRecipe('abc123')).toContain('git show abc123:pnpm-lock.yaml > pnpm-lock.yaml');
    expect(refreshRecipe(null)).toContain('rm pnpm-lock.yaml');
    expect(refreshRecipe('abc123')).toContain(
      '--lockfile-only --ignore-scripts --prefer-frozen-lockfile',
    );
  });

  it('diff excerpt bounds output to 100 lines with middle elision', () => {
    const committed = Buffer.from(
      Array.from({ length: 300 }, (_, i) => `line-${i}-old`).join('\n'),
    );
    const derived = Buffer.from(Array.from({ length: 300 }, (_, i) => `line-${i}-new`).join('\n'));
    const excerpt = diffExcerpt(committed, derived);
    expect(excerpt.split('\n').length).toBeLessThanOrEqual(101);
    expect(excerpt).toContain('… elided …');
  });

  it('json report carries schemaVersion 1 and the outcome', () => {
    const j = JSON.parse(
      renderJson({
        outcome: { kind: 'mismatch', committed: null, derived: Buffer.from('x') },
        mode: 'enforce',
        base: 'b',
        head: 'h',
      }),
    );
    expect(j.schemaVersion).toBe(1);
    expect(j.outcome).toBe('mismatch');
    expect(j.tool.name).toBe('lockfile-assay');
  });

  it('json report surfaces the cannot-evaluate reason so consumers can tell degrade causes apart', () => {
    const j = JSON.parse(
      renderJson({
        outcome: { kind: 'cannot-evaluate', reason: 'registry down: connection refused' },
        mode: 'unknown',
        base: null,
        head: 'INDEX',
      }),
    );
    expect(j.outcome).toBe('cannot-evaluate');
    expect(j.reason).toBe('registry down: connection refused');
    expect(j.mode).toBe('unknown');
  });
});
