import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepository } from '../support/fixtures.mjs';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'worktree-stamp-package-'));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run test:package.');
const run = (args, expected = 0) => execute(process.execPath, args, { cwd: source, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }).then(output => { assert.equal(expected, 0, 'CLI must exit with the expected code'); return output; }, error => { assert.equal(error.code, expected, error.stderr); return { stdout: error.stdout, stderr: error.stderr }; });
try {
  const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  const archive = JSON.parse((await run([npm, 'pack', '--json', '--pack-destination', temporary])).stdout)[0];
  assert.equal(archive.name, manifest.name); assert.equal(archive.version, manifest.version);
  for (const file of archive.files) assert.ok(!/^(node_modules|test|support|scripts|\.git|\.agent-lanes)\//.test(file.path), file.path);
  const prefix = path.join(temporary, 'install'); await mkdir(prefix);
  await run([npm, 'install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, archive.filename)]);
  const installed = path.join(prefix, 'node_modules', ...manifest.name.split('/'));
  const command = path.join(installed, 'bin/worktree-stamp.mjs');
  assert.equal((await run([command, '--version'])).stdout.trim(), manifest.version);
  const repository = await createRepository(temporary);
  await writeFile(path.join(repository, 'src/app.txt'), 'dirty before\n');
  const capture = JSON.parse((await run([command, 'capture', '--repo', repository])).stdout);
  const artifact = path.join(temporary, 'stamp.json'); await writeFile(artifact, JSON.stringify(capture));
  assert.equal(JSON.parse((await run([command, 'check', artifact, '--repo', repository, '--json'])).stdout).status, 'fresh');
  await writeFile(path.join(repository, 'src/app.txt'), 'dirty after\n');
  const changed = JSON.parse((await run([command, 'check', artifact, '--repo', repository, '--json'], 1)).stdout);
  assert.equal(changed.status, 'stale'); assert.equal(changed.tests, 'not evaluated');
  console.log('Fresh production archive installation and real dirty-to-dirty CLI freshness passed.');
} finally {
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith('worktree-stamp-package-'));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
