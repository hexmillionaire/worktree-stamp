import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, unlink, rename, symlink, rm, open, access, chmod } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureStamp, checkStamp, readStamp, validateStamp, LIMITS } from '../src/index.mjs';
import { fixture, git } from '../support/fixtures.mjs';

test('repeat captures identify the same included bytes without changing Git or source files', async t => {
  const { root } = await fixture(t);
  const before = await readFile(path.join(root, '.git/index'));
  const metadata = (await readdir(path.join(root, '.git'), { recursive: true })).sort();
  const first = await captureStamp(root);
  const second = await captureStamp(path.join(root, 'src'));
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal((await checkStamp(root, first)).status, 'fresh');
  assert.equal(first.state.files.length, 3);
  assert.equal(first.coverage.tests, 'not evaluated');
  assert.deepEqual(await readFile(path.join(root, '.git/index')), before);
  assert.deepEqual((await readdir(path.join(root, '.git'), { recursive: true })).sort(), metadata);
  assert.equal(await readFile(path.join(root, 'src/app.txt'), 'utf8'), 'baseline\n');
  assert.equal(JSON.stringify(first).includes(root), false);
});

test('dirty-to-dirty edits change freshness even with identical HEAD and porcelain status', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'src/app.txt'), 'dirty one\n');
  const stamp = await captureStamp(root);
  const status = git(root, ['status', '--porcelain=v1']);
  await writeFile(path.join(root, 'src/app.txt'), 'dirty two\n');
  assert.equal(git(root, ['status', '--porcelain=v1']), status);
  const report = await checkStamp(root, stamp);
  assert.equal(report.status, 'stale'); assert.equal(report.headChanged, false); assert.equal(report.indexChanged, false);
  assert.deepEqual(report.changedPaths, ['src/app.txt']);
});

test('index-only changes invalidate a stamp while final disk bytes stay identical', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'src/app.txt'), 'staged later\n');
  const stamp = await captureStamp(root);
  git(root, ['add', '--', 'src/app.txt']);
  const current = await captureStamp(root);
  assert.deepEqual(current.state.files, stamp.state.files);
  const report = await checkStamp(root, stamp);
  assert.equal(report.status, 'stale'); assert.equal(report.indexChanged, true); assert.equal(report.changedPathCount, 0);
});

test('empty intent-to-add cannot be confused with an actually staged empty file', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'empty.txt'), '');
  git(root, ['add', '--intent-to-add', '--', 'empty.txt']);
  const itaEntries = git(root, ['ls-files', '--stage', '-z']);
  await assert.rejects(captureStamp(root), { code: 'INTENT_TO_ADD_UNSUPPORTED' });
  git(root, ['add', '--', 'empty.txt']);
  assert.equal(git(root, ['ls-files', '--stage', '-z']), itaEntries, 'Mode/OID alone conceal the transition');
  const staged = await captureStamp(root);
  assert.equal((await checkStamp(root, staged)).status, 'fresh');
});

test('untracked same-path bytes, additions, deletions and renames are included', async t => {
  const { root } = await fixture(t);
  const name = 'untracked café 文件.txt';
  await writeFile(path.join(root, name), 'one');
  const stamp = await captureStamp(root);
  await writeFile(path.join(root, name), 'two');
  await unlink(path.join(root, 'delete.txt'));
  await rename(path.join(root, 'src/app.txt'), path.join(root, 'src/renamed file.txt'));
  const report = await checkStamp(root, stamp);
  assert.equal(report.status, 'stale');
  assert.deepEqual(report.changedPaths, ['delete.txt', 'src/app.txt', 'src/renamed file.txt', name].sort());
  assert.equal((await captureStamp(root)).state.files.find(entry => entry.path === 'delete.txt').kind, 'missing');
});

test('ignored files are explicitly uncovered and raw bytes do not run Git filters', async t => {
  const { root, parent } = await fixture(t);
  const stamp = await captureStamp(root);
  await mkdir(path.join(root, 'ignored')); await writeFile(path.join(root, 'ignored/cache.txt'), 'ignored content');
  assert.equal((await checkStamp(root, stamp)).status, 'fresh');
  await writeFile(path.join(root, '.gitattributes'), '*.txt filter=never-run\n');
  const sentinel = path.join(parent, 'MUST_NOT_EXIST');
  git(root, ['config', 'filter.never-run.clean', 'touch ' + sentinel]);
  const withAttributes = await captureStamp(root);
  assert.equal(withAttributes.state.files.find(entry => entry.path === 'src/app.txt').bytes, 9);
  await assert.rejects(access(sentinel), { code: 'ENOENT' });
});

test('assume-unchanged and skip-worktree flags do not hide tracked byte changes', async t => {
  const { root } = await fixture(t);
  for (const flag of ['assume-unchanged', 'skip-worktree']) {
    await writeFile(path.join(root, 'src/app.txt'), 'baseline\n');
    git(root, ['update-index', '--' + flag, '--', 'src/app.txt']);
    const stamp = await captureStamp(root);
    await writeFile(path.join(root, 'src/app.txt'), 'hidden edit\n');
    assert.equal(git(root, ['status', '--porcelain=v1']), '');
    assert.equal((await checkStamp(root, stamp)).status, 'stale');
    git(root, ['update-index', '--no-' + flag, '--', 'src/app.txt']);
  }
});

test('linked worktrees use their own HEAD, index and filesystem', async t => {
  const { root, parent } = await fixture(t);
  const linked = path.join(parent, 'linked tree');
  git(root, ['worktree', 'add', '-q', '--detach', linked, 'HEAD']);
  const original = await captureStamp(root);
  const stamp = await captureStamp(linked);
  assert.equal(stamp.fingerprint, original.fingerprint);
  await writeFile(path.join(linked, 'src/app.txt'), 'linked only\n');
  assert.equal((await checkStamp(linked, stamp)).status, 'stale');
  assert.equal((await checkStamp(root, original)).status, 'fresh');
});

test('gitlinks and real unresolved conflicts remain indeterminate', async t => {
  const { root } = await fixture(t);
  const head = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['update-index', '--add', '--cacheinfo', `160000,${head},child`]);
  await assert.rejects(captureStamp(root), { code: 'SUBMODULE_UNSUPPORTED' });
  git(root, ['update-index', '--force-remove', '--', 'child']);
  git(root, ['switch', '-qc', 'other']);
  await writeFile(path.join(root, 'src/app.txt'), 'theirs\n'); git(root, ['commit', '-qam', 'Theirs']);
  git(root, ['switch', '-q', 'main']);
  await writeFile(path.join(root, 'src/app.txt'), 'ours\n'); git(root, ['commit', '-qam', 'Ours']);
  assert.throws(() => git(root, ['merge', '--no-edit', 'other'], { stdio: 'pipe' }));
  await assert.rejects(captureStamp(root), { code: 'UNMERGED_INDEX' });
});

test('missing promisor objects remain unavailable instead of being lazily fetched', async t => {
  const { root, parent } = await fixture(t);
  const upstream = path.join(parent, 'local-upstream.git');
  git(root, ['clone', '-q', '--bare', '--no-hardlinks', root, upstream]);
  git(root, ['config', 'remote.origin.url', upstream]);
  git(root, ['config', 'remote.origin.promisor', 'true']);
  git(root, ['config', 'extensions.partialClone', 'origin']);
  git(root, ['config', 'core.repositoryformatversion', '1']);
  git(root, ['config', 'protocol.file.allow', 'always']);
  const tree = git(root, ['rev-parse', 'HEAD^{tree}']).trim();
  const ownedObject = path.join(root, '.git/objects', tree.slice(0, 2), tree.slice(2));
  assert.ok(path.relative(path.join(root, '.git/objects'), ownedObject).split(path.sep).every(segment => segment !== '..'));
  await unlink(ownedObject);
  assert.throws(() => git(root, ['--no-lazy-fetch', 'cat-file', '-e', tree], { stdio: 'pipe' }));
  await assert.rejects(captureStamp(root), { code: 'GIT_UNAVAILABLE' });
  assert.throws(() => git(root, ['--no-lazy-fetch', 'cat-file', '-e', tree], { stdio: 'pipe' }), 'Capture must not materialize the missing object');
  // A local-only control proves this fixture would fetch without the safeguard.
  git(root, ['diff', '--cached', '--raw', 'HEAD'], { stdio: 'pipe' });
  assert.doesNotThrow(() => git(root, ['--no-lazy-fetch', 'cat-file', '-e', tree], { stdio: 'pipe' }));
});

test('included leaf symlinks are refused without reading their targets', async t => {
  const { root, parent } = await fixture(t);
  const outside = path.join(parent, 'outside.txt'); await writeFile(outside, 'outside private data');
  try { await symlink(outside, path.join(root, 'leaf-link')); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows file symlink privilege unavailable'); throw error; }
  await assert.rejects(captureStamp(root), { code: 'LINK_UNSUPPORTED' });
  assert.equal(await readFile(outside, 'utf8'), 'outside private data');
});

test('a tracked directory replaced by a junction or symlink is refused', async t => {
  const { root, parent } = await fixture(t);
  const outside = path.join(parent, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'app.txt'), 'outside');
  const owned = path.join(root, 'src'); assert.equal(path.dirname(owned), root);
  await rm(owned, { recursive: true });
  await symlink(outside, owned, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(captureStamp(root), { code: 'LINK_UNSUPPORTED' });
  assert.equal(await readFile(path.join(outside, 'app.txt'), 'utf8'), 'outside');
});

test('capacity failures cannot produce a fresh stamp', async t => {
  const { root } = await fixture(t);
  const oversized = await open(path.join(root, 'large.bin'), 'wx');
  await oversized.truncate(LIMITS.fileBytes + 1); await oversized.close();
  await assert.rejects(captureStamp(root), { code: 'CAPACITY' });
  await unlink(path.join(root, 'large.bin'));
  const oid = git(root, ['rev-parse', 'HEAD:src/app.txt']).trim();
  const entries = Array.from({ length: LIMITS.files + 1 }, (_, i) => `100644 ${oid}\tmany/file-${i.toString().padStart(5, '0')}\n`).join('');
  git(root, ['update-index', '--index-info'], { input: entries });
  await assert.rejects(captureStamp(root), { code: 'CAPACITY' });
});

test('artifact reader enforces shape, digest, duplicate keys, UTF-8 and byte bounds', async t => {
  const { root, parent } = await fixture(t);
  const stamp = await captureStamp(root);
  const artifact = path.join(parent, 'stamp.json');
  await writeFile(artifact, JSON.stringify(stamp));
  assert.deepEqual(await readStamp(artifact), stamp);
  const reordered = JSON.parse(JSON.stringify(stamp)); reordered.state = { files: reordered.state.files, index: reordered.state.index, head: reordered.state.head };
  assert.equal(validateStamp(reordered).fingerprint, stamp.fingerprint);
  for (const invalid of [{ ...stamp, command: 'must not execute' }, { ...stamp, version: 2 }, { ...stamp, fingerprint: '0'.repeat(64) }, { ...stamp, fingerprint: [stamp.fingerprint] }]) assert.throws(() => validateStamp(invalid));
  await writeFile(artifact, JSON.stringify(stamp).replace('"version":1', '"version":1,"v\\u0065rsion":1'));
  await assert.rejects(readStamp(artifact), { code: 'INVALID_JSON' });
  for (const raw of [
    JSON.stringify(stamp).replace('"version":1', '"version":1.0000000000000001'),
    JSON.stringify(stamp).replace('"bytes":9', '"bytes":9.0000000000000001'),
    JSON.stringify(stamp).replace('"executableBits":0', '"executableBits":1e-400'),
  ]) { await writeFile(artifact, raw); await assert.rejects(readStamp(artifact), { code: 'INVALID_JSON' }); }
  for (const exact of ['1.0', '1e0', '10e-1']) {
    await writeFile(artifact, JSON.stringify(stamp).replace('"version":1', '"version":' + exact));
    assert.equal((await readStamp(artifact)).fingerprint, stamp.fingerprint);
  }
  await writeFile(artifact, '['.repeat(9) + '0' + ']'.repeat(9));
  await assert.rejects(readStamp(artifact), { code: 'INVALID_JSON' });
  await writeFile(artifact, Buffer.from([0xff])); await assert.rejects(readStamp(artifact), { code: 'INVALID_UTF8' });
  await writeFile(artifact, 'not-json-private-fragment'); await assert.rejects(readStamp(artifact), error => error.code === 'INVALID_JSON' && !error.message.includes('private-fragment'));
  const large = await open(artifact, 'w'); await large.truncate(LIMITS.artifactBytes + 1); await large.close();
  await assert.rejects(readStamp(artifact), { code: 'INVALID_ARTIFACT' });
  await assert.rejects(captureStamp(root, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
  await assert.rejects(readStamp(artifact, { signal: AbortSignal.abort() }), { code: 'ABORTED' });
});

test('CLI uses explicit status codes and strips hostile Git redirection', async t => {
  const { root, parent } = await fixture(t);
  await writeFile(path.join(root, 'c1-\u009b31m.txt'), 'fictional control-name file');
  const bin = fileURLToPath(new URL('../bin/worktree-stamp.mjs', import.meta.url));
  const run = (args, options = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, ...options });
  const capture = run(['capture', '--repo', root], { env: { ...process.env, GIT_DIR: parent, GIT_WORK_TREE: parent, GIT_INDEX_FILE: path.join(parent, 'must-not-create-index'), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'not-a-real-program' } });
  assert.equal(capture.status, 0, capture.stderr);
  assert.equal(capture.stdout.includes('\u009b'), false); assert.ok(capture.stdout.includes('\\u009b'));
  const artifact = path.join(parent, 'cli-stamp.json'); await writeFile(artifact, capture.stdout);
  assert.equal(run(['check', artifact, '--repo', root]).status, 0);
  await writeFile(path.join(root, 'src/app.txt'), 'CLI later edit\n');
  const stale = run(['check', artifact, '--repo', root, '--json']); assert.equal(stale.status, 1, stale.stderr); assert.equal(JSON.parse(stale.stdout).status, 'stale');
  const invalid = run(['check', path.join(parent, 'missing-private-name'), '--repo', root, '--json']); assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stdout).status, 'indeterminate'); assert.equal(invalid.stdout.includes('missing-private-name'), false);
  assert.equal(run(['--version']).stdout.trim(), '0.1.0'); assert.match(run(['--help']).stdout, /Tests|tests/);
  await assert.rejects(access(path.join(parent, 'must-not-create-index')), { code: 'ENOENT' });
});

test('POSIX owner-to-group execute-bit changes invalidate unchanged bytes', { skip: process.platform === 'win32' }, async t => {
  const { root } = await fixture(t);
  const filename = path.join(root, 'src/app.txt');
  await chmod(filename, 0o744);
  const stamp = await captureStamp(root);
  await chmod(filename, 0o654);
  const current = await captureStamp(root);
  assert.equal(stamp.state.files.find(entry => entry.path === 'src/app.txt').executableBits, 0o100);
  assert.equal(current.state.files.find(entry => entry.path === 'src/app.txt').executableBits, 0o010);
  assert.equal((await checkStamp(root, stamp)).status, 'stale');
});

for (const fault of ['during-read', 'between-passes']) test(`observed ${fault} mutation fails indeterminate in an isolated process`, async t => {
  const { root } = await fixture(t);
  const source = new URL('../src/index.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import { syncBuiltinESMExports } from 'node:module';
    const [source, root, fault] = process.argv.slice(1);
    const target = path.join(root, 'src/app.txt');
    const original = fs.promises.open;
    let changed = false;
    fs.promises.open = async (filename, ...args) => {
      const handle = await original(filename, ...args);
      if (path.resolve(filename).toLowerCase() === target.toLowerCase() && !changed) {
        const method = fault === 'during-read' ? 'read' : 'close';
        const operation = handle[method].bind(handle);
        handle[method] = async (...parameters) => {
          const result = await operation(...parameters);
          if (!changed) { changed = true; await fs.promises.writeFile(target, 'different bytes during the actual observation\\n'); }
          return result;
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    const { captureStamp } = await import(source);
    await assert.rejects(captureStamp(root), {code:'OBSERVED_RACE'});
    assert.equal(changed, true);
  `, source, root, fault], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});

test('POSIX control characters in paths stay JSON data and special files are unsupported', { skip: process.platform === 'win32' }, async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'line\nbreak\tfile.txt'), 'fictional');
  const stamp = await captureStamp(root);
  assert.ok(stamp.state.files.some(entry => entry.path === 'line\nbreak\tfile.txt'));
  const fifo = spawnSync('mkfifo', [path.join(root, 'named-pipe')], { encoding: 'utf8' });
  assert.equal(fifo.status, 0, fifo.stderr);
  await assert.rejects(captureStamp(root), { code: 'SPECIAL_UNSUPPORTED' });
});
