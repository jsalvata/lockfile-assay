import type { CheckResult, MemoHook } from './check.js';
import { runCheck } from './check.js';
import { CannotEvaluate } from './errors.js';
import { mergeBase, remoteDefaultBranch } from './git.js';

export type PushedTip = { localRef: string; localSha: string };
const ZERO = /^0{40,64}$/;

/**
 * githooks(5) pre-push ref lines: `<local-ref> <local-sha> <remote-ref>
 * <remote-sha>`. Ref deletions (all-zero local sha) push nothing and are
 * skipped; no lines at all means a standalone invocation, checking HEAD.
 */
export function parsePushLines(stdin: string): PushedTip[] {
  const lines = stdin
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [{ localRef: 'HEAD', localSha: 'HEAD' }];
  const tips: PushedTip[] = [];
  for (const line of lines) {
    const [localRef, localSha] = line.split(/\s+/);
    if (!localRef || !localSha || ZERO.test(localSha)) continue; // deletion pushes nothing
    tips.push({ localRef, localSha });
  }
  return tips;
}

/**
 * push-time form (spec §8): each pushed tip is checked against the base its
 * PR's required check will use — `--base` override, else the merge-base with
 * the remote default branch. `runCheck` supplies the fast path (an untriggered
 * net diff is a vacuous pass with no config read and no network) and, with
 * `failClosed: false`, the fail-open posture: a broken env degrades that tip to
 * `cannot-evaluate` (exit 0) rather than bricking the push — whether the break
 * is base derivation (no origin default, no merge-base) or a triggered tip's
 * derivation (unreachable registry, offline corepack, resolver failure). One
 * bad tip degrades to a notice and the loop moves on to the next; the anchored
 * CI check still gates the merge. Exit is the max over tips.
 */
export async function runPrepush(opts: {
  stdin: string;
  baseOverride?: string;
  cwd?: string;
  memo?: MemoHook | null;
}): Promise<{ tips: CheckResult[]; exit: 0 | 1 }> {
  const results: CheckResult[] = [];
  for (const tip of parsePushLines(opts.stdin)) {
    try {
      const base = opts.baseOverride ?? deriveBase(tip.localSha, opts.cwd);
      results.push(
        await runCheck({
          base,
          head: tip.localSha,
          cwd: opts.cwd,
          memo: opts.memo,
          failClosed: false,
        }),
      );
    } catch (e) {
      if (e instanceof CannotEvaluate) {
        const outcome = { kind: 'cannot-evaluate', reason: e.message } as const;
        results.push({
          outcome,
          mode: 'off',
          exit: 0,
          report: { outcome, mode: 'off', base: null, head: tip.localSha },
        });
      } else throw e;
    }
  }
  return { tips: results, exit: results.some((r) => r.exit === 1) ? 1 : 0 };
}

function deriveBase(tip: string, cwd?: string): string {
  const remoteDefault = remoteDefaultBranch(cwd);
  if (!remoteDefault) {
    throw new CannotEvaluate('no origin default branch — the required check still gates the merge');
  }
  const base = mergeBase(remoteDefault, tip, cwd);
  if (!base) throw new CannotEvaluate(`no merge-base between ${tip} and ${remoteDefault}`);
  return base;
}
