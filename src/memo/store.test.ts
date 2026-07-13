import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { contentsApiStore, type MemoRecord } from './store.js';

const HASH = `ab${'0'.repeat(62)}`;
const REPO = 'octo/assay-memo';
const RECORD: MemoRecord = {
  derivedLockfileSha256: 'f'.repeat(64),
  toolVersion: '1.2.3',
  pnpmVersion: '10.34.1',
  derivedAt: '2026-07-05T00:00:00.000Z',
};

type SeenRequest = {
  method: string;
  path: string;
  ref: string | null;
  headers: IncomingHttpHeaders;
  body: string;
};

// Fake GitHub Contents API: a Map of pathname → raw JSON blob. GET serves the
// blob (404 when absent); PUT decodes {content: base64} and stores; a second
// PUT to the same path returns 422 like the real API does when `sha` is
// missing for an existing file. Forced status codes simulate outages.
const blobs = new Map<string, string>();
const seen: SeenRequest[] = [];
let forcedGetStatus: number | null = null;
let forcedPutStatus: number | null = null;
let server: Server;
let apiBase: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        path: url.pathname,
        ref: url.searchParams.get('ref'),
        headers: req.headers,
        body,
      });
      if (req.method === 'GET') {
        if (forcedGetStatus !== null) {
          res.statusCode = forcedGetStatus;
          res.end('{"message":"upstream sadness"}');
          return;
        }
        const blob = blobs.get(url.pathname);
        if (blob === undefined) {
          res.statusCode = 404;
          res.end('{"message":"Not Found"}');
          return;
        }
        res.setHeader('content-type', 'application/vnd.github.raw+json');
        res.end(blob);
        return;
      }
      if (req.method === 'PUT') {
        if (forcedPutStatus !== null) {
          res.statusCode = forcedPutStatus;
          res.end('{"message":"upstream sadness"}');
          return;
        }
        if (blobs.has(url.pathname)) {
          res.statusCode = 422; // real API: existing path, no `sha` → 422
          res.end('{"message":"Invalid request. \\"sha\\" wasn\'t supplied."}');
          return;
        }
        const parsed = JSON.parse(body) as { content: string };
        blobs.set(url.pathname, Buffer.from(parsed.content, 'base64').toString('utf8'));
        res.statusCode = 201;
        res.end('{}');
        return;
      }
      res.statusCode = 405;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  blobs.clear();
  seen.length = 0;
  forcedGetStatus = null;
  forcedPutStatus = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const store = () => contentsApiStore({ repo: REPO, token: 'ghs_test', apiBase });

describe('contentsApiStore', () => {
  it('round-trips: miss → null, put stores, get returns the record', async () => {
    const s = store();
    expect(await s.get(1, HASH)).toBeNull();
    await s.put(1, HASH, RECORD);
    expect(await s.get(1, HASH)).toEqual(RECORD);
  });

  it('isolates records by epoch — a record under one epoch is a miss under the next', async () => {
    const s = store();
    await s.put(1, HASH, RECORD);
    expect(await s.get(1, HASH)).toEqual(RECORD); // same epoch → hit
    expect(await s.get(2, HASH)).toBeNull(); // an EPOCH bump lands on a different path ⇒ miss
  });

  it('addresses records at memo/<epoch>/<hh>/<hash>.json with the branch as ref', async () => {
    const s = store();
    await s.get(1, HASH);
    await s.put(1, HASH, RECORD);
    const expectedPath = `/repos/${REPO}/contents/memo/1/ab/${HASH}.json`;
    const get = seen.find((r) => r.method === 'GET');
    const put = seen.find((r) => r.method === 'PUT');
    expect(get?.path).toBe(expectedPath);
    expect(get?.ref).toBe('lockfile-assay/memo'); // default branch
    expect(put?.path).toBe(expectedPath);
    const putBody = JSON.parse(put?.body ?? '{}') as {
      message?: string;
      content?: string;
      branch?: string;
    };
    expect(putBody.branch).toBe('lockfile-assay/memo');
    expect(typeof putBody.message).toBe('string');
    expect(JSON.parse(Buffer.from(putBody.content ?? '', 'base64').toString('utf8'))).toEqual(
      RECORD,
    );
  });

  it('honors a custom branch and sends auth + api-version + raw-accept headers', async () => {
    const s = contentsApiStore({ repo: REPO, token: 'ghs_test', branch: 'other/branch', apiBase });
    await s.get(1, HASH);
    const get = seen[0];
    expect(get?.ref).toBe('other/branch');
    expect(get?.headers.authorization).toBe('Bearer ghs_test');
    expect(get?.headers['x-github-api-version']).toBe('2022-11-28');
    expect(get?.headers['user-agent']).toBeTruthy();
    expect(get?.headers.accept).toBe('application/vnd.github.raw+json');
  });

  it('get: a 500 yields null, never a throw — reads must not fail the check', async () => {
    forcedGetStatus = 500;
    await expect(store().get(1, HASH)).resolves.toBeNull();
  });

  it('get: malformed JSON in a 200 yields null, never a throw', async () => {
    blobs.set(`/repos/${REPO}/contents/memo/1/ab/${HASH}.json`, 'not json {{{');
    await expect(store().get(1, HASH)).resolves.toBeNull();
  });

  it('get: a network failure yields null, never a throw', async () => {
    const s = contentsApiStore({ repo: REPO, token: 'ghs_test', apiBase: 'http://127.0.0.1:1' });
    await expect(s.get(1, HASH)).resolves.toBeNull();
  });

  it('put: a lost race (422 on the second write) is swallowed silently', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store();
    await s.put(1, HASH, RECORD);
    await expect(s.put(1, HASH, RECORD)).resolves.toBeUndefined();
    expect(err).not.toHaveBeenCalled();
    expect(await s.get(1, HASH)).toEqual(RECORD); // first writer's record survives
  });

  it('put: a 409 conflict is swallowed silently', async () => {
    forcedPutStatus = 409;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(store().put(1, HASH, RECORD)).resolves.toBeUndefined();
    expect(err).not.toHaveBeenCalled();
  });

  it('put: any other HTTP failure warns on stderr but never throws', async () => {
    forcedPutStatus = 500;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(store().put(1, HASH, RECORD)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledOnce();
  });

  it('put: a network failure warns on stderr but never throws', async () => {
    const s = contentsApiStore({ repo: REPO, token: 'ghs_test', apiBase: 'http://127.0.0.1:1' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(s.put(1, HASH, RECORD)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledOnce();
  });
});
