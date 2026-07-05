import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFixtureRepo, readLock } from '../helpers/fixture.js';
import { type Registry, startRegistry } from '../helpers/registry.js';

let registry: Registry;
beforeAll(async () => {
  registry = await startRegistry();
  await registry.publish({ name: 'left-pad', version: '1.0.0' });
});
afterAll(() => registry.stop());

describe('harness', () => {
  it('publishes to verdaccio and pnpm locks against it', async () => {
    const { dir } = await makeFixtureRepo(registry, { 'left-pad': '^1.0.0' });
    expect(readLock(dir)).toContain('left-pad@1.0.0');
  });
});
