import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INVOCATION } from '../../src/derive.js';
import { embedRecord } from '../../src/memo/checks-api.js';
import { EPOCH, inputsHash } from '../../src/memo/key.js';
import { buildMemoDriver, CHECK_NAME, type StoredRecord, sha256 } from '../../src/memo/store.js';
import type { StagedFile } from '../../src/staging.js';

// A faked GitHub Checks API. Tests seed check runs keyed by commit SHA and
// register which commits belong to the PR's current chain vs its force-pushed
// history, then assert what the driver reads / writes.
//
// `app_id` drives the server-side `?app_id=` query filter (a run is returned
// at all only when it matches); `reportedAppId` (defaulting to `app_id`) is
// what the response body's `app.id` carries. Keeping them separate lets a test
// seed a run that *passes* the server-side filter yet reports a *different*
// app.id in its body — the only way to exercise the client-side
// re-verification belt-and-suspenders independently of the server-side one.
type Run = {
  conclusion: string;
  summary: string;
  app_id: number;
  name: string;
  reportedAppId?: number;
};
class FakeGitHub {
  server!: Server;
  base = '';
  chain: string[] = []; // current PR commits
  forced: string[] = []; // force-pushed-away head SHAs (timeline beforeCommit)
  runs = new Map<string, Run[]>(); // sha -> check runs
  posted: { head_sha: string; conclusion: string; summary: string }[] = [];

  seedRun(sha: string, run: Run) {
    const list = this.runs.get(sha) ?? [];
    list.push(run);
    this.runs.set(sha, list);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://x');
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      // list PR commits
      let m = /\/pulls\/\d+\/commits$/.exec(url.pathname);
      if (m && req.method === 'GET') {
        const page = Number(url.searchParams.get('page') ?? '1');
        return send(200, page === 1 ? this.chain.map((sha) => ({ sha })) : []);
      }
      // list check runs for a sha (test fixtures use readable names like
      // `sha_old` rather than real hex SHAs, so match any non-slash segment)
      m = /\/commits\/([^/]+)\/check-runs$/.exec(url.pathname);
      if (m && req.method === 'GET') {
        const appId = Number(url.searchParams.get('app_id'));
        const name = url.searchParams.get('check_name');
        const all = this.runs.get(m[1] as string) ?? [];
        const check_runs = all
          .filter((r) => r.app_id === appId && r.name === name)
          .map((r) => ({
            conclusion: r.conclusion,
            output: { summary: r.summary },
            app: { id: r.reportedAppId ?? r.app_id },
          }));
        return send(200, { check_runs });
      }
      // graphql force-push timeline
      if (url.pathname === '/graphql' && req.method === 'POST') {
        return send(200, {
          data: {
            repository: {
              pullRequest: {
                timelineItems: {
                  nodes: this.forced.map((oid) => ({ beforeCommit: { oid }, afterCommit: null })),
                },
              },
            },
          },
        });
      }
      // create check run
      if (/\/check-runs$/.test(url.pathname) && req.method === 'POST') {
        let raw = '';
        req.on('data', (c) => {
          raw += c;
        });
        req.on('end', () => {
          const body = JSON.parse(raw);
          this.posted.push({
            head_sha: body.head_sha,
            conclusion: body.conclusion,
            summary: body.output.summary,
          });
          // reflect it into the store so a later consult can read it
          this.seedRun(body.head_sha, {
            conclusion: body.conclusion,
            summary: body.output.summary,
            app_id: 999,
            name: CHECK_NAME,
          });
          send(201, { id: 1, app: { id: 999 } });
        });
        return;
      }
      send(404, {});
    });
    await new Promise<void>((r) => this.server.listen(0, () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop() {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const APP_ID = 999;
const files: StagedFile[] = [{ path: 'pnpm-lock.yaml', bytes: Buffer.from('lock') }];
const committed = Buffer.from('committed-lock');

function record(over: Partial<StoredRecord> = {}): StoredRecord {
  return {
    epoch: EPOCH,
    inputsHash: inputsHash(files, INVOCATION),
    derivedHash: sha256(committed),
    toolVersion: '1.0.0',
    pnpmVersion: '10.34.1',
    timestamp: '2026-07-13T00:00:00.000Z',
    ...over,
  };
}
const successRun = (rec: StoredRecord): Run => ({
  conclusion: 'success',
  summary: `ok\n${embedRecord(rec)}`,
  app_id: APP_ID,
  name: CHECK_NAME,
});

// A repo with a github origin so originRepo() resolves; env carries the token
// and app id. cwd points at it so buildMemoDriver has a repo.
let repoDir: string;
let gh: FakeGitHub;
function driver(pr: number | undefined, write: boolean) {
  return buildMemoDriver({
    write,
    pr,
    cwd: repoDir,
    apiBase: gh.base,
    fetchImpl: fetch,
    env: { LOCKFILE_ASSAY_TOKEN: 'ghs_x', LOCKFILE_ASSAY_APP_ID: String(APP_ID) },
  });
}

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), 'assay-memo-int-'));
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:octo/assay.git'], {
    cwd: repoDir,
  });
  gh = new FakeGitHub();
  await gh.start();
});
afterEach(async () => {
  await gh.stop();
  rmSync(repoDir, { recursive: true, force: true });
});

describe('memo, against a faked Checks API', () => {
  it('append survival: a record on an earlier commit in the chain hits', async () => {
    gh.chain = ['sha_old', 'sha_head'];
    gh.seedRun('sha_old', successRun(record()));
    expect(await driver(7, false).consult(files, committed)).toMatchObject({ hit: true });
  });

  it('force-push survival: a record only on a force-pushed-away head hits', async () => {
    gh.chain = ['sha_squashed']; // current chain has no record
    gh.forced = ['sha_orphan'];
    gh.seedRun('sha_orphan', successRun(record()));
    expect(await driver(7, false).consult(files, committed)).toMatchObject({ hit: true });
  });

  it('hit short-circuits with no further lookups needed (no live re-roll)', async () => {
    gh.chain = ['sha_head'];
    gh.seedRun('sha_head', successRun(record()));
    const prov = await driver(7, false).consult(files, committed);
    expect(prov).toEqual({
      hit: true,
      derivedAt: '2026-07-13T00:00:00.000Z',
      toolVersion: '1.0.0',
    });
  });

  it('stale memo (derivedHash mismatch) falls through to a miss', async () => {
    gh.chain = ['sha_head'];
    gh.seedRun('sha_head', successRun(record({ derivedHash: sha256(Buffer.from('other')) })));
    expect(await driver(7, false).consult(files, committed)).toBeNull();
  });

  it('a mismatch verdict is never memoised (failure run carries no record)', async () => {
    const d = driver(7, true);
    await d.postVerdict({
      outcome: { kind: 'mismatch', committed, derived: Buffer.from('d') } as never,
      exit: 1,
      headSha: 'sha_head',
    });
    expect(gh.posted[0].conclusion).toBe('failure');
    // reflected into the store as a failure run; a later consult must not hit
    gh.chain = ['sha_head'];
    expect(await driver(7, false).consult(files, committed)).toBeNull();
  });

  it('epoch isolation: a record under a bumped epoch misses', async () => {
    gh.chain = ['sha_head'];
    gh.seedRun('sha_head', successRun(record({ epoch: EPOCH + 1 })));
    expect(await driver(7, false).consult(files, committed)).toBeNull();
  });

  it('duplicate records from concurrent runs read as equivalent (still one hit)', async () => {
    gh.chain = ['sha_head'];
    gh.seedRun('sha_head', successRun(record()));
    gh.seedRun('sha_head', successRun(record())); // a second concurrent run posted the same
    expect(await driver(7, false).consult(files, committed)).toMatchObject({ hit: true });
  });

  it('belt-and-suspenders: a run that passes the server-side app_id filter but reports a mismatched app.id in its body is not read as a record (miss)', async () => {
    gh.chain = ['sha_head'];
    // app_id: APP_ID passes the server's `?app_id=` query filter and the run is
    // otherwise a valid success record; only its body's app.id (111) disagrees
    // with the driver's configured appId (999). The client-side re-check (belt
    // and suspenders — checks-api.ts listRecords) must still reject it.
    gh.seedRun('sha_head', { ...successRun(record()), reportedAppId: 111 });
    expect(await driver(7, false).consult(files, committed)).toBeNull();
  });
});
