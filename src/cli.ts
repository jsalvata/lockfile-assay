#!/usr/bin/env node
import { program } from 'commander';
import { runCheck, runStagedCheck } from './check.js';
import { CannotEvaluate, StagingError, UsageError } from './errors.js';
import { exitForError } from './outcome.js';
import { renderHuman, renderJson } from './report/render.js';

async function main(): Promise<void> {
  program.name('lockfile-assay').description('Prove your lockfile is untampered.');
  program
    .command('check')
    .description('verify the committed lockfile derives honestly from reviewable inputs')
    .option('--base <ref>', 'base ref (e.g. the PR merge-base)')
    .option('--head <ref>', 'head ref', 'HEAD')
    .option('--staged', 'check the index instead of a commit (git hook form)')
    .option('--json', 'emit the machine report')
    .action(async (o: { base?: string; head: string; staged?: boolean; json?: boolean }) => {
      if (o.staged) {
        const r = await runStagedCheck({});
        console.log(o.json ? renderJson(r.report) : renderHuman(r.report));
        process.exitCode = r.exit;
        return;
      }
      if (!o.base) throw new UsageError('--base <ref> is required');
      const r = await runCheck({ base: o.base, head: o.head });
      console.log(o.json ? renderJson(r.report) : renderHuman(r.report));
      process.exitCode = r.exit;
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
