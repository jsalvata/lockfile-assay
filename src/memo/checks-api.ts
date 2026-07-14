import type { Backend, CheckRunView, VerdictPost } from './store.js';

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

  /** Raw check-run views for the PR's candidate head SHAs — no filtering, no
   * parsing. The adapter (store.ts) owns the success/app-id trust filter and
   * the record parse; this transport only moves opaque `summary` strings. */
  async listRuns(): Promise<CheckRunView[]> {
    if (this.o.pr === undefined) return []; // no PR context → nothing to consult
    const shas = await this.candidateShas(this.o.pr);
    const runs: CheckRunView[] = [];
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
        runs.push({
          appId: run.app?.id,
          conclusion: run.conclusion ?? '',
          summary: run.output?.summary ?? '',
        });
      }
    }
    return runs;
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

  async postVerdict(v: VerdictPost): Promise<void> {
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
