import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const VERSION = '0.1.0';
export const LIMITS = Object.freeze({ files: 10000, fileBytes: 16 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, artifactBytes: 8 * 1024 * 1024, gitBytes: 4 * 1024 * 1024, pathBytes: 4096 });
const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const objectID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const compare = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const coverage = Object.freeze({ tracked: 'all index paths', untracked: 'nonignored regular files', ignored: false, submodules: 'unsupported', links: 'unsupported', observation: 'two matching reads; not atomic', tests: 'not evaluated' });

export class StampError extends Error {
  constructor(code, message) { super(message); this.name = 'StampError'; this.code = code; }
}
const fail = (code, message) => { throw new StampError(code, message); };
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) fail('INVALID_STAMP', 'Unexpected stamp fields.');
}
function relative(value) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || Buffer.byteLength(value) > LIMITS.pathBytes || value.includes('\0') || path.isAbsolute(value) || value.split('/').some(part => !part || part === '.' || part === '..') || (process.platform === 'win32' && /[\\:]/.test(value))) fail('UNSUPPORTED_PATH', 'Unsupported repository-relative path.');
  return value;
}
function text(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { fail('INVALID_UTF8', 'Only valid UTF-8 paths and JSON artifacts are supported.'); }
}
function records(buffer) {
  if (!buffer.length) return [];
  if (buffer.at(-1) !== 0) fail('GIT_FORMAT', 'Incomplete Git path records.');
  return text(buffer.subarray(0, -1)).split('\0');
}
async function git(root, args, signal) {
  signal.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' });
  try {
    const result = await execute('git', ['--no-lazy-fetch', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', root, ...args], { env, signal, timeout: 15000, maxBuffer: LIMITS.gitBytes, encoding: 'buffer', windowsHide: true });
    // Git can omit unreadable untracked directories while returning exit 0.
    // Any warning makes completeness indeterminate; never echo its private text.
    if (result.stderr.length) fail('GIT_WARNING', 'Git reported a metadata warning; completeness is indeterminate.');
    return result.stdout;
  } catch (error) {
    if (error instanceof StampError) throw error;
    signal.throwIfAborted();
    fail(error.code === 'ENOENT' ? 'GIT_MISSING' : 'GIT_UNAVAILABLE', error.code === 'ENOENT' ? 'Git 2.45+ is required on PATH.' : 'Git metadata could not be read within supported bounds; Git 2.45+ and local committed objects are required.');
  }
}

function indexRecords(buffer) {
  const entries = records(buffer).map(value => {
    const match = /^(100644|100755|120000|160000) ([a-f0-9]{40}|[a-f0-9]{64}) ([0-3])\t([\s\S]+)$/.exec(value);
    if (!match) fail('GIT_FORMAT', 'Unsupported Git index format.');
    if (match[3] !== '0') fail('UNMERGED_INDEX', 'Unresolved index conflicts are unsupported; no fresh result is available.');
    if (match[1] === '160000') fail('SUBMODULE_UNSUPPORTED', 'Submodules are unsupported; no fresh result is available.');
    if (match[1] === '120000') fail('LINK_UNSUPPORTED', 'Included symlinks are unsupported; no fresh result is available.');
    return { path: relative(match[4]), mode: match[1], oid: match[2] };
  }).sort(compare);
  for (let i = 1; i < entries.length; i++) if (entries[i - 1].path === entries[i].path) fail('GIT_FORMAT', 'Repeated index paths are unsupported.');
  return entries;
}
const sameStat = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mode === b.mode && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
async function statFile(filename) {
  try { return await lstat(filename, { bigint: true }); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}
async function parents(root, name) {
  let current = root;
  for (const segment of name.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await statFile(current);
    if (!stat) return false;
    if (stat.isSymbolicLink()) fail('LINK_UNSUPPORTED', 'Included symlink directories are unsupported.');
    if (!stat.isDirectory()) return false;
  }
  return true;
}
async function fileState(root, name, budget, signal) {
  signal.throwIfAborted();
  const filename = path.resolve(root, ...name.split('/'));
  const local = path.relative(root, filename);
  if (!local || local === '..' || local.startsWith('..' + path.sep) || path.isAbsolute(local)) fail('UNSUPPORTED_PATH', 'Included path leaves the repository.');
  const ancestors = await parents(root, name);
  const before = ancestors ? await statFile(filename) : null;
  if (!before) return { path: name, kind: 'missing' };
  if (before.isSymbolicLink()) fail('LINK_UNSUPPORTED', 'Included symlinks are unsupported.');
  if (!before.isFile()) fail('SPECIAL_UNSUPPORTED', 'Included paths must be regular files.');
  if (before.size > BigInt(LIMITS.fileBytes)) fail('CAPACITY', 'An included file exceeds the 16 MiB limit.');
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) fail('OBSERVED_RACE', 'An included path changed while opening.');
    const hash = createHash('sha256');
    const buffer = budget.buffer;
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      bytes += read.bytesRead; budget.bytes += read.bytesRead;
      if (bytes > LIMITS.fileBytes || budget.bytes > LIMITS.totalBytes) fail('CAPACITY', 'Included bytes exceed the supported capture limits.');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (!sameStat(opened, after) || BigInt(bytes) !== after.size) fail('OBSERVED_RACE', 'An included file changed while reading.');
    const current = await statFile(filename);
    if (!current || !sameStat(opened, current) || !await parents(root, name)) fail('OBSERVED_RACE', 'An included path changed while reading.');
    return { path: name, kind: 'regular', bytes, executableBits: process.platform === 'win32' ? 0 : Number(after.mode) & 0o111, sha256: hash.digest('hex') };
  } finally { await handle?.close(); }
}

async function observe(root, signal) {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let values;
  const cached = ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--no-ext-diff', '--no-textconv', '--no-renames', '--ignore-submodules=none'];
  try { values = await Promise.all([
    git(root, ['rev-parse', '--verify', 'HEAD'], combined),
    git(root, ['ls-files', '--stage', '--full-name', '-z'], combined),
    git(root, ['ls-files', '--others', '--exclude-standard', '--full-name', '-z'], combined),
    git(root, [...cached, '--ita-visible-in-index', 'HEAD', '--'], combined),
    git(root, [...cached, '--ita-invisible-in-index', 'HEAD', '--'], combined),
  ]); }
  catch (error) { controller.abort(); throw error; }
  // Empty intent-to-add entries can share mode/OID with a genuinely staged empty
  // file. Their explicit cached semantics differ; do not mistake them for fresh.
  if (!values[3].equals(values[4])) fail('INTENT_TO_ADD_UNSUPPORTED', 'Intent-to-add index entries are unsupported; stage or remove them before capture.');
  const head = text(values[0]).trim();
  if (!objectID.test(head)) fail('GIT_FORMAT', 'A committed Git HEAD is required.');
  const index = indexRecords(values[1]);
  const names = [...new Set([...index.map(value => value.path), ...records(values[2]).map(relative)])].sort();
  if (names.length > LIMITS.files) fail('CAPACITY', 'Included paths exceed the 10000-file limit.');
  const files = [];
  const budget = { bytes: 0, buffer: Buffer.alloc(1024 * 1024) };
  // Sequential bounded reads keep memory and file descriptors independent of size.
  for (const name of names) files.push(await fileState(root, name, budget, signal));
  return { head, index, files };
}

/** Observe included Git state twice. This does not run or attest to any tests. */
export async function captureStamp(directory = process.cwd(), { signal: callerSignal } = {}) {
  const timeout = AbortSignal.timeout(60000);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    signal.throwIfAborted();
    const candidate = await realpath(directory);
    const top = text(await git(candidate, ['rev-parse', '--show-toplevel'], signal)).replace(/\r?\n$/, '');
    const root = await realpath(top);
    const first = await observe(root, signal);
    const second = await observe(root, signal);
    signal.throwIfAborted();
    const canonical = JSON.stringify(first);
    if (canonical !== JSON.stringify(second)) fail('OBSERVED_RACE', 'Included Git state changed between observations; retry after writers stop.');
    const stamp = { version: 1, kind: 'worktree-stamp', algorithm: 'sha256', observedAt: new Date().toISOString(), coverage: { ...coverage }, fingerprint: digest(canonical), state: first };
    if (Buffer.byteLength(JSON.stringify(stamp)) > LIMITS.artifactBytes) fail('CAPACITY', 'The stamp exceeds its 8 MiB artifact limit.');
    return stamp;
  } catch (error) {
    if (error instanceof StampError) throw error;
    if (signal.aborted) fail('ABORTED', 'Capture was cancelled or exceeded 60 seconds.');
    fail('FILESYSTEM_UNAVAILABLE', 'Included filesystem state could not be read safely.');
  }
}

/** Validate the exact v1 shape and its self-consistent digest; not authenticity. */
export function validateStamp(stamp) {
  keys(stamp, ['version', 'kind', 'algorithm', 'observedAt', 'coverage', 'fingerprint', 'state']);
  if (stamp.version !== 1 || stamp.kind !== 'worktree-stamp' || stamp.algorithm !== 'sha256' || typeof stamp.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(stamp.observedAt) || !Number.isFinite(Date.parse(stamp.observedAt)) || new Date(stamp.observedAt).toISOString() !== stamp.observedAt || typeof stamp.fingerprint !== 'string' || !hex.test(stamp.fingerprint)) fail('INVALID_STAMP', 'Unsupported stamp metadata.');
  keys(stamp.coverage, Object.keys(coverage));
  if (Object.keys(coverage).some(key => stamp.coverage[key] !== coverage[key])) fail('INVALID_STAMP', 'Unsupported stamp coverage.');
  keys(stamp.state, ['head', 'index', 'files']);
  const { head, index, files } = stamp.state;
  if (typeof head !== 'string' || !objectID.test(head) || !Array.isArray(index) || !Array.isArray(files) || index.length > LIMITS.files || files.length > LIMITS.files) fail('INVALID_STAMP', 'Unsupported stamp state.');
  function ordered(entries) {
    for (let i = 0; i < entries.length; i++) { relative(entries[i]?.path); if (i && compare(entries[i - 1], entries[i]) >= 0) fail('INVALID_STAMP', 'Stamp paths must be sorted and unique.'); }
  }
  ordered(index); ordered(files);
  for (const entry of index) { keys(entry, ['path', 'mode', 'oid']); if (!['100644', '100755'].includes(entry.mode) || typeof entry.oid !== 'string' || !objectID.test(entry.oid)) fail('INVALID_STAMP', 'Unsupported index entry.'); }
  let bytes = 0;
  for (const entry of files) {
    if (entry.kind === 'missing') keys(entry, ['path', 'kind']);
    else {
      keys(entry, ['path', 'kind', 'bytes', 'executableBits', 'sha256']);
      if (entry.kind !== 'regular' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > LIMITS.fileBytes || !Number.isInteger(entry.executableBits) || entry.executableBits < 0 || (entry.executableBits & ~0o111) !== 0 || entry.executableBits > 0o111 || typeof entry.sha256 !== 'string' || !hex.test(entry.sha256)) fail('INVALID_STAMP', 'Unsupported included file entry.');
      bytes += entry.bytes;
    }
  }
  const paths = new Set(files.map(entry => entry.path));
  if (bytes > LIMITS.totalBytes || index.some(entry => !paths.has(entry.path))) fail('INVALID_STAMP', 'Incomplete or oversized included file state.');
  // Rebuild keys in canonical order so equivalent JSON object key ordering works.
  const state = { head, index: index.map(entry => ({ path: entry.path, mode: entry.mode, oid: entry.oid })), files: files.map(entry => entry.kind === 'missing' ? { path: entry.path, kind: entry.kind } : { path: entry.path, kind: entry.kind, bytes: entry.bytes, executableBits: entry.executableBits, sha256: entry.sha256 }) };
  if (digest(JSON.stringify(state)) !== stamp.fingerprint) fail('INVALID_STAMP', 'The stamp fingerprint does not match its recorded state.');
  if (Buffer.byteLength(JSON.stringify(stamp)) > LIMITS.artifactBytes) fail('CAPACITY', 'The stamp exceeds its 8 MiB artifact limit.');
  return { ...stamp, state };
}

function exactSafeInteger(token, number) {
  const parts = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(token);
  if (!parts) return false;
  const fraction = parts[3] ?? '';
  let digits = (parts[2] + fraction).replace(/^0+/, '');
  if (!digits) return number === 0;
  let scale = Number(parts[4] ?? 0) - fraction.length;
  const trimmed = digits.replace(/0+$/, '');
  scale += digits.length - trimmed.length; digits = trimmed;
  if (!Number.isSafeInteger(scale) || scale < 0) return false;
  const expected = String(Math.abs(number));
  if (digits.length + scale !== expected.length || (parts[1] === '-') !== (number < 0)) return false;
  return digits + '0'.repeat(scale) === expected;
}
function strictJSON(value) {
  // Preflight before JSON.parse: a decimal such as 1.0000000000000001 must not
  // round into a valid version/byte count and inherit an unrelated fingerprint.
  const stack = [];
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (character === '"') {
      const start = i++;
      while (i < value.length && value[i] !== '"') { if (value[i] === '\\') i++; i++; }
      const parent = stack.at(-1);
      if (parent?.type === 'object' && parent.key) {
        let key;
        try { key = JSON.parse(value.slice(start, i + 1)); } catch { fail('INVALID_JSON', 'The stamp is not valid JSON.'); }
        if (parent.keys.has(key)) fail('INVALID_JSON', 'Duplicate JSON keys are unsupported.');
        parent.keys.add(key); parent.key = false;
      }
    } else if (character === '{' || character === '[') {
      stack.push({ type: character === '{' ? 'object' : 'array', key: true, keys: new Set() });
      if (stack.length > 8) fail('INVALID_JSON', 'The stamp JSON is nested too deeply.');
    } else if (character === '}' || character === ']') stack.pop();
    else if (character === ',' && stack.at(-1)?.type === 'object') stack.at(-1).key = true;
    else if (character === '-' || character >= '0' && character <= '9') {
      const start = i;
      while (i + 1 < value.length && /[0-9eE+.-]/.test(value[i + 1])) i++;
      const token = value.slice(start, i + 1);
      const number = Number(token);
      if (!Number.isSafeInteger(number) || !exactSafeInteger(token, number)) fail('INVALID_JSON', 'Stamp numbers must represent exact safe integers.');
    }
  }
  try { return JSON.parse(value); } catch { fail('INVALID_JSON', 'The stamp is not valid JSON.'); }
}

/** Read a regular, bounded UTF-8 JSON artifact without following its leaf link. */
export async function readStamp(filename, { signal } = {}) {
  let handle;
  try {
    signal?.throwIfAborted();
    const before = await lstat(filename, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(LIMITS.artifactBytes)) fail('INVALID_ARTIFACT', 'The stamp must be a regular JSON file no larger than 8 MiB.');
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameStat(before, opened)) fail('OBSERVED_RACE', 'The stamp changed while opening.');
    const buffer = Buffer.alloc(LIMITS.artifactBytes + 1);
    let length = 0;
    while (length < buffer.length) { signal?.throwIfAborted(); const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
    if (length > LIMITS.artifactBytes) fail('CAPACITY', 'The stamp exceeds its 8 MiB artifact limit.');
    if (!sameStat(opened, await handle.stat({ bigint: true }))) fail('OBSERVED_RACE', 'The stamp changed while reading.');
    return validateStamp(strictJSON(text(buffer.subarray(0, length))));
  } catch (error) {
    if (error instanceof StampError) throw error;
    if (signal?.aborted) fail('ABORTED', 'Stamp reading was cancelled.');
    fail('INVALID_ARTIFACT', 'The stamp artifact could not be read safely.');
  } finally { await handle?.close(); }
}

/** Compare included state only. A fresh result is never a test-success verdict. */
export async function checkStamp(directory, input, options) {
  const saved = validateStamp(input);
  const current = await captureStamp(directory, options);
  const before = new Map(saved.state.files.map(entry => [entry.path, entry]));
  const after = new Map(current.state.files.map(entry => [entry.path, entry]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed = paths.filter(name => JSON.stringify(before.get(name)) !== JSON.stringify(after.get(name)));
  return { version: 1, status: current.fingerprint === saved.fingerprint ? 'fresh' : 'stale', expectedFingerprint: saved.fingerprint, observedFingerprint: current.fingerprint, capturedAt: saved.observedAt, checkedAt: current.observedAt, headChanged: saved.state.head !== current.state.head, indexChanged: JSON.stringify(saved.state.index) !== JSON.stringify(current.state.index), changedPathCount: changed.length, changedPaths: changed.slice(0, 100), pathsTruncated: changed.length > 100, tests: 'not evaluated' };
}
