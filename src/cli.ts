#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import type { MemoHook } from './check.js';
import { runCheck, runStagedCheck } from './check.js';
import { CannotEvaluate, StagingError, UsageError } from './errors.js';
import { discoverToken, originRepo } from './memo/auth.js';
import { lazyMemoClient, makeMemoClient } from './memo/client.js';
import { contentsApiStore } from './memo/store.js';
import { exitForError } from './outcome.js';
import { runPrepush } from './prepush.js';
import { renderHuman, renderJson } from './report/render.js';

/**
 * Resolve the memo's credentials, or the reason they are missing (spec §8). The
 * memo needs BOTH a github.com `origin` and a discoverable token; origin is
 * checked first so the common non-GitHub case never spawns `gh auth token`.
 * Exported so buildMemo and the `--memo-write` warning share one source of truth
 * (and so it is unit-testable with an injected cwd / env).
 */
export function resolveMemo(
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): { repo: string; token: string } | { unavailable: string } {
  const repo = originRepo(opts.cwd);
  if (!repo) return { unavailable: 'origin is not a github.com remote' };
  const token = discoverToken(opts.env);
  if (!token) {
    return {
      unavailable: 'no token (set LOCKFILE_ASSAY_TOKEN or GITHUB_TOKEN, or run `gh auth login`)',
    };
  }
  return { repo, token };
}

/**
 * Assemble the derivation-memo hook (spec §8). Discovery is LAZY (via
 * lazyMemoClient): a check touches the memo only inside evaluate()'s
 * consult/record, past the trigger + mode + preflight gates, so the common
 * source-only run (a vacuous pass) never spends the credential subprocesses.
 * If the credentials are absent the memo is disabled (null) — on the READ paths
 * that is a silent offline degrade (a check never fails or blocks for lack of
 * memo credentials). The WRITING form warns instead (see the `--memo-write`
 * guard below): there a disabled memo means passing runs are never recorded, so
 * later runs re-derive and an unchanged lockfile can spuriously mismatch on
 * registry drift.
 *
 * `write` is true only for the anchored CI form (`check --memo-write`); the
 * local forms (`check --staged`, `prepush`) hard-code false — they may READ
 * the memo but never write (spec §8: local runs hold no writer credential;
 * the branch ruleset refuses non-App pushes anyway, but belt-and-braces).
 */
function buildMemo(write: boolean): MemoHook {
  return lazyMemoClient(() => {
    const m = resolveMemo();
    return 'unavailable' in m ? null : makeMemoClient(contentsApiStore(m), { write });
  });
}

/**
 * Build the commander program fresh (not commander's shared singleton) so a test
 * can drive it in-process — `buildProgram().parseAsync(['check', …], { from:
 * 'user' })` — without spawning the binary. The entry-point guard at the foot
 * of the file runs it; importing this module does not.
 */
export function buildProgram(): Command {
  const program = new Command();
  program.name('lockfile-assay').description('Prove your lockfile is untampered.');
  program
    .command('check')
    .description('verify the committed lockfile derives honestly from reviewable inputs')
    .option('--base <ref>', 'base ref (e.g. the PR merge-base)')
    .option('--head <ref>', 'head ref', 'HEAD')
    .option('--staged', 'check the index instead of a commit (git hook form)')
    .option('--memo-write', 'record passing derivations to the memo (anchored CI form only)')
    .option('--json', 'emit the machine report')
    .action(
      async (o: {
        base?: string;
        head: string;
        staged?: boolean;
        memoWrite?: boolean;
        json?: boolean;
      }) => {
        // Local hook forms never write the memo (spec §8), so --memo-write with
        // --staged can't be honored — the staged path builds a read-only memo
        // below. Reject the combo instead of silently ignoring the flag, which
        // would leave a hook author believing records are being written.
        if (o.staged && o.memoWrite) {
          throw new UsageError(
            '--memo-write cannot be combined with --staged (local hook forms never write the memo)',
          );
        }
        if (o.staged) {
          const r = await runStagedCheck({ memo: buildMemo(false) });
          console.log(o.json ? renderJson(r.report) : renderHuman(r.report));
          process.exitCode = r.exit;
          return;
        }
        if (!o.base) throw new UsageError('--base <ref> is required');
        if (o.memoWrite) {
          // The writing form intends to record. If the memo can't initialize, say
          // so: without records, later runs re-derive and an honest, unchanged
          // lockfile can spuriously mismatch on registry drift — a setup problem,
          // never a check failure. (resolveMemo re-runs on consult, but the writing
          // form is CI-only and not latency-sensitive.)
          const m = resolveMemo();
          if ('unavailable' in m) {
            console.error(
              `warning: --memo-write is set but the memo is unavailable (${m.unavailable}); ` +
                'passing derivations will not be recorded, so later runs re-derive and an ' +
                'unchanged lockfile may mismatch on registry drift. See docs/setup-github-app.md.',
            );
          }
        }
        const r = await runCheck({ base: o.base, head: o.head, memo: buildMemo(!!o.memoWrite) });
        console.log(o.json ? renderJson(r.report) : renderHuman(r.report));
        process.exitCode = r.exit;
      },
    );
  program
    .command('prepush')
    .description('git pre-push hook form: check every pushed tip against its PR base')
    .option('--base <ref>', 'override the per-tip merge-base')
    .option('--json', 'emit the machine report')
    .action(async (o: { base?: string; json?: boolean }) => {
      const stdin = process.stdin.isTTY
        ? ''
        : await new Promise<string>((resolve) => {
            let data = '';
            process.stdin.on('data', (c) => {
              data += c;
            });
            process.stdin.on('end', () => resolve(data));
          });
      const { tips, exit } = await runPrepush({
        stdin,
        baseOverride: o.base,
        memo: buildMemo(false),
      });
      if (o.json) {
        console.log(
          JSON.stringify(
            { schemaVersion: 1, tips: tips.map((t) => JSON.parse(renderJson(t.report))) },
            null,
            2,
          ),
        );
      } else {
        for (const t of tips) console.log(renderHuman(t.report));
      }
      process.exitCode = exit;
    });
  return program;
}

/**
 * True only when this module is the process entry point — not when a test (or
 * any other module) imports it. argv[1] is resolved through symlinks so an
 * installed `.bin/lockfile-assay` shim still counts as the entry point.
 */
function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  buildProgram()
    .parseAsync()
    .catch((e: unknown) => {
      if (e instanceof UsageError) {
        console.error(`usage error: ${e.message}`);
      } else if (e instanceof CannotEvaluate) {
        console.error(`cannot evaluate: ${e.message}`);
      } else if (e instanceof StagingError) {
        // hostile staged content — fail hard (exit 3), but surface the offending
        // path the structured error carries, which e.message alone drops
        console.error(`${e.message}: ${e.path}`);
      } else {
        console.error(e instanceof Error ? e : String(e));
      }
      process.exitCode = exitForError(e);
    });
}
