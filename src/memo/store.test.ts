import { describe, expect, it } from 'vitest';
import type { Outcome } from '../outcome.js';
import type { StagedFile } from '../staging.js';
import { toolVersion } from '../version.js';
import { EPOCH } from './key.js';
import type { Backend } from './store.js';
import { buildMemoDriver, CHECK_NAME, conclusion, MemoDriver } from './store.js';

const O = {
  pass: { kind: 'pass' } as Outcome,
  vacuous: { kind: 'vacuous-pass' } as Outcome,
  off: { kind: 'not-evaluated' } as Outcome,
  mismatch: { kind: 'mismatch', committed: null, derived: Buffer.alloc(0) } as Outcome,
  skew: { kind: 'toolchain-skew', pinned: '10.0.0', effective: '9.0.0' } as Outcome,
  unsupported: { kind: 'unsupported-input', reasons: ['pnpmfile'] } as Outcome,
};

describe('conclusion — (outcome, exit) → check-run conclusion', () => {
  it('maps passes to success', () => {
    expect(conclusion(O.pass, 0)).toBe('success');
    expect(conclusion(O.vacuous, 0)).toBe('success');
  });
  it('maps off to neutral', () => {
    expect(conclusion(O.off, 0)).toBe('neutral');
  });
  it('maps enforce failures (exit 1) to failure', () => {
    expect(conclusion(O.mismatch, 1)).toBe('failure');
    expect(conclusion(O.skew, 1)).toBe('failure');
    expect(conclusion(O.unsupported, 1)).toBe('failure');
  });
  it('maps warn-mode failing kinds (exit 0) to neutral', () => {
    expect(conclusion(O.mismatch, 0)).toBe('neutral');
    expect(conclusion(O.skew, 0)).toBe('neutral');
    expect(conclusion(O.unsupported, 0)).toBe('neutral');
  });
});

// The App id the adapter is configured with in these tests — the security
// anchor consult filters runs against (design §4).
const APP_ID = 424242;
// The wire format store.ts's (private) embedRecord writes. parseRecord/
// embedRecord are private to store.ts (spec: never exported), so tests that
// need a genuinely embedded record drive it through the public record() +
// postVerdict() API (see `embeddedSummary` below); tests that need a
// malformed/incompatible record hand-craft raw text in this documented
// format instead, since no encoder can produce invalid output by
// construction.
const MARKER = 'lockfile-assay-memo:v1';

const files: StagedFile[] = [{ path: 'pnpm-lock.yaml', bytes: Buffer.from('lock') }];
const committed = Buffer.from('committed-lock');

function fakeBackend(
  runs: Array<{ appId?: number; conclusion: string; summary: string }>,
): Backend {
  return {
    listRuns: async () => runs,
    postVerdict: async () => {},
  };
}

function successRun(summary: string, appId: number = APP_ID) {
  return { appId, conclusion: 'success', summary };
}

function capturingBackend() {
  const posted: Parameters<Backend['postVerdict']>[0][] = [];
  const backend: Backend = {
    listRuns: async () => [],
    postVerdict: async (v) => {
      posted.push(v);
    },
  };
  return { backend, posted };
}

/** Drives record() + postVerdict() through a real MemoDriver to obtain a
 * genuinely embedded summary string — exercises store.ts's private
 * embedRecord without reaching into it directly (spec: it must stay
 * unexported). */
async function embeddedSummary(
  recordFiles: StagedFile[],
  derived: Buffer,
  pnpmVersion = '10.34.1',
): Promise<string> {
  const { backend, posted } = capturingBackend();
  const d = new MemoDriver(backend, true, APP_ID);
  await d.record(recordFiles, derived, pnpmVersion);
  await d.postVerdict({ outcome: { kind: 'pass' } as Outcome, exit: 0, headSha: 'x' });
  return posted[0]?.summary ?? '';
}

describe('MemoDriver.consult — pass or miss, never a failure', () => {
  it('hits when epoch + inputsHash + derivedHash all match', async () => {
    const summary = await embeddedSummary(files, committed);
    const d = new MemoDriver(fakeBackend([successRun(summary)]), false, APP_ID);
    const prov = await d.consult(files, committed);
    expect(prov?.hit).toBe(true);
    expect(prov?.toolVersion).toBe(toolVersion());
    expect(typeof prov?.derivedAt).toBe('string');
  });

  it('misses (stale record) when derivedHash != sha256(committed)', async () => {
    const summary = await embeddedSummary(files, Buffer.from('other'));
    const d = new MemoDriver(fakeBackend([successRun(summary)]), false, APP_ID);
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('misses under a different epoch (isolation)', async () => {
    const summary = await embeddedSummary(files, committed);
    const tampered = summary.replace(`"epoch":${EPOCH}`, `"epoch":${EPOCH + 1}`);
    expect(tampered).not.toBe(summary); // guard: the replace must actually have hit
    const d = new MemoDriver(fakeBackend([successRun(tampered)]), false, APP_ID);
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('misses when there is no committed lockfile', async () => {
    const summary = await embeddedSummary(files, committed);
    const d = new MemoDriver(fakeBackend([successRun(summary)]), false, APP_ID);
    expect(await d.consult(files, null)).toBeNull();
  });

  it('misses when a matching record sits on a non-success run', async () => {
    const summary = await embeddedSummary(files, committed);
    const d = new MemoDriver(
      fakeBackend([{ appId: APP_ID, conclusion: 'neutral', summary }]),
      false,
      APP_ID,
    );
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('misses when a run reports an appId other than the configured App (trust anchor)', async () => {
    const summary = await embeddedSummary(files, committed);
    const d = new MemoDriver(fakeBackend([successRun(summary, APP_ID + 1)]), false, APP_ID);
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('degrades a transport error to a miss (never throws)', async () => {
    const throwing: Backend = {
      listRuns: async () => {
        throw new Error('502 from GitHub');
      },
      postVerdict: async () => {},
    };
    const d = new MemoDriver(throwing, false, APP_ID);
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('is a no-op (miss) with a null backend', async () => {
    const d = new MemoDriver(null, false, APP_ID);
    expect(await d.consult(files, committed)).toBeNull();
  });
});

describe('MemoDriver.consult — malformed records never produce a false hit', () => {
  it('misses when the marker is absent', async () => {
    const d = new MemoDriver(
      fakeBackend([successRun('just a human summary, no marker')]),
      false,
      APP_ID,
    );
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('misses on broken JSON after the marker', async () => {
    const d = new MemoDriver(
      fakeBackend([successRun(`<!--${MARKER} {not json} -->`)]),
      false,
      APP_ID,
    );
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('misses when a required field is missing/mistyped', async () => {
    const d = new MemoDriver(
      fakeBackend([successRun(`<!--${MARKER} {"epoch":"1","inputsHash":"x"} -->`)]),
      false,
      APP_ID,
    );
    expect(await d.consult(files, committed)).toBeNull();
  });

  it('non-greedy capture stops at the first close even with trailing "} -->" text', async () => {
    const good = await embeddedSummary(files, committed);
    const summary = `${good} trailing note like {"forged":true} -->`;
    const d = new MemoDriver(fakeBackend([successRun(summary)]), false, APP_ID);
    expect(await d.consult(files, committed)).toMatchObject({ hit: true });
  });
});

const derived = Buffer.from('derived-lock');

describe('MemoDriver.record + postVerdict — the write path', () => {
  it('embeds the record in a success verdict on a live pass', async () => {
    const { backend, posted } = capturingBackend();
    const d = new MemoDriver(backend, true, APP_ID);
    await d.record(files, derived, '10.34.1'); // evaluate() calls this on a byte-match pass
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'deadbeef',
    });
    expect(warnings).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.conclusion).toBe('success');
    expect(posted[0]?.headSha).toBe('deadbeef');
    expect(posted[0]?.summary).toContain(`"pnpmVersion":"10.34.1"`);
    expect(posted[0]?.summary).toContain(`"epoch":${EPOCH}`);
    // The embedded record round-trips through the public API: feeding the
    // posted summary back as a matching success run must hit.
    const reader = new MemoDriver(
      fakeBackend([successRun(posted[0]?.summary ?? '')]),
      false,
      APP_ID,
    );
    const prov = await reader.consult(files, derived);
    expect(prov).toEqual({ hit: true, derivedAt: expect.any(String), toolVersion: toolVersion() });
  });

  it('a memo hit re-embeds the matched record in the pass verdict (GC mitigation, design §4)', async () => {
    // consult() finds a matching record on an earlier run's summary. The
    // driver stashes that MATCHED record as `pending` so postVerdict's
    // existing `if (isPass && this.pending)` embed re-writes it onto the
    // current head's own success verdict — safe because the matched
    // record's derivedHash already equals sha256(committed), and this
    // protects against GitHub GC'ing the earlier head it still lived on.
    const seedSummary = await embeddedSummary(files, committed);
    const posted: Parameters<Backend['postVerdict']>[0][] = [];
    const backend: Backend = {
      listRuns: async () => [successRun(seedSummary)],
      postVerdict: async (v) => {
        posted.push(v);
      },
    };
    const d = new MemoDriver(backend, true, APP_ID);
    const prov = await d.consult(files, committed);
    expect(prov).toMatchObject({ hit: true });
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'deadbeef',
    });
    expect(warnings).toEqual([]);
    expect(posted).toHaveLength(1);
    expect(posted[0]?.conclusion).toBe('success');
    // The re-embedded record is the SAME one that was consulted: feed the
    // posted summary back through a fresh driver and confirm it reports
    // identical provenance.
    const reader = new MemoDriver(
      fakeBackend([successRun(posted[0]?.summary ?? '')]),
      false,
      APP_ID,
    );
    expect(await reader.consult(files, committed)).toEqual(prov);
  });

  it('posts a failure verdict with no record on a mismatch (never memoised)', async () => {
    const { backend, posted } = capturingBackend();
    const d = new MemoDriver(backend, true, APP_ID);
    // record() is NOT called on a mismatch — evaluate() only calls it on a pass
    const warnings = await d.postVerdict({
      outcome: { kind: 'mismatch', committed, derived } as Outcome,
      exit: 1,
      headSha: 'deadbeef',
    });
    expect(warnings).toEqual([]);
    expect(posted[0]?.conclusion).toBe('failure');
    expect(posted[0]?.summary).not.toContain(MARKER);
  });

  it('warns (drift wording) but never throws when a pass write fails', async () => {
    const backend: Backend = {
      listRuns: async () => [],
      postVerdict: async () => {
        throw new Error('403 Forbidden');
      },
    };
    const d = new MemoDriver(backend, true, APP_ID);
    await d.record(files, derived, '10.34.1');
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'deadbeef',
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not durable/);
    expect(warnings[0]).toMatch(/drift/);
  });

  it('is a no-op when write is false (local read-only forms never post)', async () => {
    const { backend, posted } = capturingBackend();
    const d = new MemoDriver(backend, false, APP_ID);
    await d.record(files, derived, '10.34.1');
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'deadbeef',
    });
    expect(warnings).toEqual([]);
    expect(posted).toHaveLength(0);
  });
});

describe('buildMemoDriver — null-object when context is absent', () => {
  it('CHECK_NAME is the stable required-check name', () => {
    expect(CHECK_NAME).toBe('lockfile-assay');
  });

  it('returns a driver that misses/no-ops when there is no token', async () => {
    // env with no token and an empty PATH so `gh auth token` finds nothing
    const d = buildMemoDriver({ write: true, pr: 1, env: { PATH: '/nonexistent' }, cwd: '.' });
    expect(await d.consult(files, committed)).toBeNull();
    const warnings = await d.postVerdict({
      outcome: { kind: 'pass' } as Outcome,
      exit: 0,
      headSha: 'x',
    });
    expect(warnings).toEqual([]);
  });
});
