#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { VERSION, StampError, captureStamp, readStamp, checkStamp } from '../src/index.mjs';

const help = `Worktree Stamp ${VERSION}\n\nUsage:\n  worktree-stamp capture [--repo PATH]\n  worktree-stamp check STAMP.json [--repo PATH] [--json]\n\nSave captured stdout outside the repository. Only Git metadata reads are run;\nno checks, tests or agents are executed. Includes HEAD, index and tracked/\nnonignored regular-file bytes. Ignored files, external state and test results\nare not covered. Links, conflicts and submodules are unsupported. Two matching\nreads are an observation, not an atomic snapshot.\nExit codes: 0 fresh/captured; 1 stale; 2 invalid/unsupported/indeterminate.\n`;
let json = false;
const printJSON = value => JSON.stringify(value, null, 2).replace(/[\u007f-\u009f]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')) + '\n';
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: { repo: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' } } });
  json = Boolean(values.json);
  if (values.help || !positionals.length && !values.version) process.stdout.write(help);
  else if (values.version) process.stdout.write(VERSION + '\n');
  else {
    const [command, artifact] = positionals;
    if (!['capture', 'check'].includes(command) || positionals.length !== (command === 'capture' ? 1 : 2)) throw new StampError('USAGE', 'Use capture or check STAMP.json. See --help.');
    if (command === 'capture') process.stdout.write(printJSON(await captureStamp(values.repo)));
    else {
      const report = await checkStamp(values.repo, await readStamp(artifact));
      process.stdout.write(json ? printJSON(report) : `${report.status.toUpperCase()}: included Git state ${report.status === 'fresh' ? 'matches' : 'differs from'} the saved stamp. Tests were not evaluated.\n`);
      if (report.status === 'stale') process.exitCode = 1;
    }
  }
} catch (error) {
  const code = error instanceof StampError ? error.code : 'INVALID_INPUT';
  const message = error instanceof StampError ? error.message : 'Invalid input or unavailable observation. See --help.';
  if (json) process.stdout.write(printJSON({ version: 1, status: 'indeterminate', error: { code, message }, tests: 'not evaluated' }));
  else process.stderr.write(`Worktree Stamp: ${message}\n`);
  process.exitCode = 2;
}
