#!/usr/bin/env node
import { program } from 'commander';

program.name('lockfile-assay').description('Prove your lockfile is untampered.').version('0.0.0');
program
  .command('check')
  .description('verify the committed lockfile derives honestly')
  .action(() => {
    process.exitCode = 3;
    console.error('not implemented yet');
  });
program.parse();
