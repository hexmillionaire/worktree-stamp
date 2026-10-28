import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function git(root, args, options = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, '../empty.gitconfig'), GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Fictional Stamp Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Fictional Stamp Test', GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z' });
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=' + path.join(root, '../empty-hooks'), '-c', 'commit.gpgSign=false', '-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 15000, env, ...options });
}
export async function createRepository(parent) {
  const root = path.join(parent, 'repo');
  await mkdir(root); await mkdir(path.join(parent, 'empty-hooks')); await writeFile(path.join(parent, 'empty.gitconfig'), '');
  git(root, ['init', '-q', '--initial-branch=main', '--object-format=sha1']);
  git(root, ['config', 'core.autocrlf', 'false']);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/app.txt'), 'baseline\n');
  await writeFile(path.join(root, 'delete.txt'), 'deletable\n');
  await writeFile(path.join(root, '.gitignore'), 'ignored/\n');
  git(root, ['add', '--all']); git(root, ['commit', '-qm', 'Fictional baseline']);
  return root;
}
export async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'worktree-stamp-test-'));
  t.after(async () => {
    assert.equal(path.dirname(parent), path.resolve(os.tmpdir()));
    assert.ok(path.basename(parent).startsWith('worktree-stamp-test-'));
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { parent, root: await createRepository(parent) };
}
