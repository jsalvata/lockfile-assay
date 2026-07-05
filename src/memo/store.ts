export type MemoRecord = {
  derivedLockfileSha256: string;
  toolVersion: string;
  pnpmVersion: string;
  derivedAt: string;
};

export interface MemoStore {
  get(epoch: number, hash: string): Promise<MemoRecord | null>;
  put(epoch: number, hash: string, record: MemoRecord): Promise<void>;
}

/**
 * Memo store backed by the GitHub Contents API on a dedicated branch
 * (spec §8). Records live at `memo/<epoch>/<hash[0:2]>/<hash>.json` — the
 * two-hex fanout keeps directory listings sane.
 *
 * Failure semantics are the load-bearing part:
 * - `get` NEVER fails the check. A memo read is an optimization: 404 is a
 *   miss, and any other failure (5xx, network error, malformed JSON) also
 *   degrades to `null` so a GitHub outage means a live re-derive, not a
 *   bricked PR. Nothing escapes as an exception.
 * - `put` is best-effort. 409/422 means another writer won the race —
 *   records for the same key are equivalent, so swallow silently. Any other
 *   failure gets a stderr warning and is swallowed: the verdict already
 *   happened, and a failed memo write must not fail the check.
 */
export function contentsApiStore(opts: {
  repo: string; // 'owner/name'
  token: string;
  branch?: string;
  apiBase?: string; // tests point this at a local fake
}): MemoStore {
  const branch = opts.branch ?? 'lockfile-assay/memo';
  const apiBase = opts.apiBase ?? 'https://api.github.com';
  const headers = {
    authorization: `Bearer ${opts.token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'lockfile-assay',
  };
  const urlFor = (epoch: number, hash: string) =>
    `${apiBase}/repos/${opts.repo}/contents/memo/${epoch}/${hash.slice(0, 2)}/${hash}.json`;

  return {
    async get(epoch, hash) {
      try {
        const res = await fetch(`${urlFor(epoch, hash)}?ref=${encodeURIComponent(branch)}`, {
          headers: { ...headers, accept: 'application/vnd.github.raw+json' },
        });
        if (!res.ok) return null; // 404 = miss; anything else must not fail the check
        return (await res.json()) as MemoRecord;
      } catch {
        return null;
      }
    },
    async put(epoch, hash, record) {
      try {
        const res = await fetch(urlFor(epoch, hash), {
          method: 'PUT',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: `memo: ${hash.slice(0, 12)} (epoch ${epoch})`,
            content: Buffer.from(JSON.stringify(record, null, 2)).toString('base64'),
            branch,
          }),
        });
        if (res.status === 409 || res.status === 422) return; // lost the race: an equivalent record already exists
        if (!res.ok) {
          console.error(`lockfile-assay: memo write failed (${res.status}) — continuing`);
        }
      } catch (e) {
        console.error(
          `lockfile-assay: memo write failed (${e instanceof Error ? e.message : e}) — continuing`,
        );
      }
    },
  };
}
