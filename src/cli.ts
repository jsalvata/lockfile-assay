#!/usr/bin/env node
import { program } from 'commander';
import type { MemoHook } from './check.js';
import { runCheck, runStagedCheck } from './check.js';
import { CannotEvaluate, StagingError, UsageError } from './errors.js';
import { discoverToken, originRepo } from './memo/auth.js';
import { makeMemoClient } from './memo/client.js';
import { contentsApiStore } from './memo/store.js';
import { exitForError } from './outcome.js';
import { runPrepush } from './prepush.js';
import { renderHuman, renderJson } from './report/render.js';

/**
 * Assemble the derivation-memo hook (spec §8). Needs BOTH a github.com
 * `origin` and a discoverable token — if either is absent the memo is silently
 * disabled (null): a check never fails, warns, or blocks for lack of memo
 * credentials (the credential-less/offline degrade). Origin is resolved first
 * so the common non-GitHub case never spawns `gh auth token`.
 *
 * `write` is true only for the anchored CI form (`check --memo-write`); the
 * local forms (`check --staged`, `prepush`) hard-code false — they may READ
 * the memo but never write (spec §8: local runs hold no writer credential;
 * the branch ruleset refuses non-App pushes anyway, but belt-and-braces).
 */
function buildMemo(write: boolean): MemoHook | null {
  const repo = originRepo();
  if (!repo) return null;
  const token = discoverToken();
  if (!token) return null;
  return makeMemoClient(contentsApiStore({ repo, token }), { write });
}

async function main(): Promise<void> {
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
        if (o.staged) {
          const r = await runStagedCheck({ memo: buildMemo(false) });
          console.log(o.json ? renderJson(r.report) : renderHuman(r.report));
          process.exitCode = r.exit;
          return;
        }
        if (!o.base) throw new UsageError('--base <ref> is required');
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
  await program.parseAsync();
}

main().catch((e: unknown) => {
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
