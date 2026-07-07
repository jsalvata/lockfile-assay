import { describe, expect, it } from 'vitest';
import { parsePushLines } from './prepush.js';

const Z = '0'.repeat(40);
describe('parsePushLines', () => {
  it('parses tips and skips deletions', () => {
    const stdin = [
      `refs/heads/f abc123${'0'.repeat(34)} refs/heads/f def456${'0'.repeat(34)}`,
      `refs/heads/gone ${Z} refs/heads/gone abc123${'0'.repeat(34)}`,
    ].join('\n');
    expect(parsePushLines(stdin)).toEqual([
      { localRef: 'refs/heads/f', localSha: `abc123${'0'.repeat(34)}` },
    ]);
  });
  it('empty stdin means standalone: HEAD', () => {
    expect(parsePushLines('')).toEqual([{ localRef: 'HEAD', localSha: 'HEAD' }]);
  });
});
