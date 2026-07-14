import type { Backend, StoredRecord } from './store.js';

export const MARKER = 'lockfile-assay-memo:v1';

/** Embed a record inside a check-run summary, behind an HTML-comment marker so
 * it is invisible in rendered markdown and unambiguous to parse. */
export function embedRecord(record: StoredRecord): string {
  return `<!--${MARKER} ${JSON.stringify(record)} -->`;
}

/** Extract a record from a check-run summary. Any deviation — no marker, broken
 * JSON, a missing/mistyped field — yields null (a miss, never a false record). */
export function parseRecord(summary: string | null | undefined): StoredRecord | null {
  if (!summary) return null;
  const m = new RegExp(`<!--${MARKER} (\\{.*?\\}) -->`).exec(summary);
  if (!m) return null;
  let o: unknown;
  try {
    o = JSON.parse(m[1] as string);
  } catch {
    return null;
  }
  const r = o as Record<string, unknown>;
  if (
    typeof r.epoch === 'number' &&
    typeof r.inputsHash === 'string' &&
    typeof r.derivedHash === 'string' &&
    typeof r.toolVersion === 'string' &&
    typeof r.pnpmVersion === 'string' &&
    typeof r.timestamp === 'string'
  ) {
    return {
      epoch: r.epoch,
      inputsHash: r.inputsHash,
      derivedHash: r.derivedHash,
      toolVersion: r.toolVersion,
      pnpmVersion: r.pnpmVersion,
      timestamp: r.timestamp,
    };
  }
  return null;
}

const DEFAULT_API = 'https://api.github.com';

type Ctor = {
  token: string;
  owner: string;
  repo: string;
  appId: number;
  checkName: string;
  pr?: number;
  apiBase?: string;
  fetchImpl?: typeof fetch;
};

export class ChecksApiBackend implements Backend {
  private readonly api: string;
  private readonly fetch: typeof fetch;
  constructor(private readonly o: Ctor) {
    this.api = o.apiBase ?? DEFAULT_API;
    this.fetch = o.fetchImpl ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.o.token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'lockfile-assay',
      ...extra,
    };
  }

  async listRecords(): Promise<StoredRecord[]> {
    if (this.o.pr === undefined) return []; // no PR context → nothing to consult
    const shas = await this.candidateShas(this.o.pr);
    const records: StoredRecord[] = [];
    for (const sha of shas) {
      // No page loop here (unlike candidateShas below): a single SHA/app/check-name
      // combination realistically has far fewer than 100 runs, so per_page=100 is
      // ample; any overflow just drops the oldest runs from this SHA, which is a
      // safe miss (the memo re-derives), never a false record.
      const url =
        `${this.api}/repos/${this.o.owner}/${this.o.repo}/commits/${sha}/check-runs` +
        `?app_id=${this.o.appId}&check_name=${encodeURIComponent(this.o.checkName)}&per_page=100`;
      const res = await this.fetch(url, { headers: this.headers() });
      if (!res.ok) continue; // a GC'd / unreadable SHA → skip (safe miss)
      const body = (await res.json()) as { check_runs?: CheckRun[] };
      for (const run of body.check_runs ?? []) {
        if (run.conclusion !== 'success') continue; // records live only in success runs
        // Belt-and-suspenders: re-verify the App identity client-side even though
        // the request already filtered by `app_id`. This is the single trust
        // anchor of the whole security model (design §4, "why the app_id filter
        // is load-bearing") — a GITHUB_TOKEN/github-actions check named
        // `lockfile-assay` must never be read as a record, so never trust a run
        // whose own body disagrees with the query filter.
        if (run.app?.id !== this.o.appId) continue;
        const rec = parseRecord(run.output?.summary);
        if (rec) records.push(rec);
      }
    }
    return records;
  }

  /** Head SHAs this PR has ever run against: the current commit chain (REST)
   * plus force-pushed-away heads recovered from the timeline (GraphQL). */
  private async candidateShas(pr: number): Promise<string[]> {
    const shas = new Set<string>();
    for (let page = 1; page < 50; page++) {
      const url = `${this.api}/repos/${this.o.owner}/${this.o.repo}/pulls/${pr}/commits?per_page=100&page=${page}`;
      const res = await this.fetch(url, { headers: this.headers() });
      if (!res.ok) break;
      const arr = (await res.json()) as { sha: string }[];
      for (const c of arr) shas.add(c.sha);
      if (arr.length < 100) break;
    }
    for (const sha of await this.forcePushedHeads(pr)) shas.add(sha);
    return [...shas];
  }

  private async forcePushedHeads(pr: number): Promise<string[]> {
    const query =
      'query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo)' +
      '{pullRequest(number:$pr){timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT],first:100)' +
      '{nodes{... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid}}}}}}}';
    const res = await this.fetch(`${this.api}/graphql`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ query, variables: { owner: this.o.owner, repo: this.o.repo, pr } }),
    });
    if (!res.ok) return []; // GraphQL unavailable → fall back to the current chain only
    const body = (await res.json()) as ForcePushResponse;
    const nodes = body?.data?.repository?.pullRequest?.timelineItems?.nodes ?? [];
    const out: string[] = [];
    for (const n of nodes) {
      if (n?.beforeCommit?.oid) out.push(n.beforeCommit.oid);
      if (n?.afterCommit?.oid) out.push(n.afterCommit.oid);
    }
    return out;
  }

  async postVerdict(v: {
    headSha: string;
    conclusion: 'success' | 'failure' | 'neutral';
    title: string;
    summary: string;
  }): Promise<void> {
    const url = `${this.api}/repos/${this.o.owner}/${this.o.repo}/check-runs`;
    const res = await this.fetch(url, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        name: this.o.checkName,
        head_sha: v.headSha,
        status: 'completed',
        conclusion: v.conclusion,
        output: { title: v.title, summary: v.summary },
      }),
    });
    if (!res.ok) throw new Error(`check-run create failed: ${res.status} ${await res.text()}`);
  }
}

type CheckRun = {
  conclusion: string | null;
  output?: { summary?: string | null };
  app?: { id?: number };
};
type ForcePushResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        timelineItems?: {
          nodes?: { beforeCommit?: { oid?: string }; afterCommit?: { oid?: string } }[];
        };
      };
    };
  };
};
