#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { runCheck, runStagedCheck } from './check.js';
import { CannotEvaluate, StagingError, UsageError } from './errors.js';
import { buildMemoDriver } from './memo/store.js';
import { exitForError } from './outcome.js';
import { runPrepush } from './prepush.js';
import { renderHuman, renderJson } from './report/render.js';

/**
 * Build the commander program fresh (not commander's shared singleton) so a test
 * can drive it in-process — `buildProgram().parseAsync(['check', …], { from:
 * 'user' })` — without spawning the binary. The entry-point guard at the foot
 * of the file runs it; importing this module does not.
 *
 * The derivation memo (spec §8) is wired via `buildMemoDriver`: the CI form
 * (`check --base/--head`) builds a write-capable driver, passes it to
 * `runCheck` for consult, and posts the verdict check run afterwards; the
 * local `--staged` form builds a read-only driver (consult only, never
 * posts). The `--staged`+`--memo-write` guard stays: local hook forms never
 * write the memo regardless of the flag.
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
    .option('--pr <number>', 'PR number (enables memo consult in the CI form)', (v) => Number(v))
    .option('--json', 'emit the machine report')
    .action(
      async (o: {
        base?: string;
        head: string;
        staged?: boolean;
        memoWrite?: boolean;
        pr?: number;
        json?: boolean;
      }) => {
        // Local hook forms never write the memo (spec §8), so --memo-write with
        // --staged can't be honored. Reject the combo instead of silently ignoring
        // the flag, which would leave a hook author believing records are written.
        if (o.staged && o.memoWrite) {
          throw new UsageError(
            '--memo-write cannot be combined with --staged (local hook forms never write the memo)',
          );
        }
        // commander's `(v) => Number(v)` parser coerces a non-integer/malformed
        // --pr to NaN rather than rejecting it, which would otherwise silently
        // degrade to a safe miss (no PR context → no consult). Reject it loudly
        // instead, mirroring appId()'s validation of LOCKFILE_ASSAY_APP_ID.
        if (o.pr !== undefined && (!Number.isInteger(o.pr) || o.pr <= 0)) {
          throw new UsageError('--pr must be a positive integer');
        }
        if (o.staged) {
          // local hook form: read-only memo (consult only when --pr given), never posts
          const memo = buildMemoDriver({ write: false, pr: o.pr });
          const r = await runStagedCheck({ memo });
          console.log(o.json ? renderJson(r.report) : renderHuman(r.report));
          process.exitCode = r.exit;
          return;
        }
        if (!o.base) throw new UsageError('--base <ref> is required');
        const memo = buildMemoDriver({ write: !!o.memoWrite, pr: o.pr });
        const r = await runCheck({ base: o.base, head: o.head, memo });
        const warnings = await memo.postVerdict({
          outcome: r.outcome,
          exit: r.exit,
          headSha: r.report.head,
        });
        const report = warnings.length ? { ...r.report, warnings } : r.report;
        console.log(o.json ? renderJson(report) : renderHuman(report));
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
      const { tips, exit } = await runPrepush({ stdin, baseOverride: o.base });
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
