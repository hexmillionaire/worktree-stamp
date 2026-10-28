# Version 1 format

`captureStamp(directory = process.cwd(), {signal} = {})` returns this bounded JSON-compatible object. Unknown keys at every shown object level are rejected by `validateStamp` and `readStamp`.

```json
{
  "version": 1,
  "kind": "worktree-stamp",
  "algorithm": "sha256",
  "observedAt": "2026-10-28T12:00:00.000Z",
  "coverage": {
    "tracked": "all index paths",
    "untracked": "nonignored regular files",
    "ignored": false,
    "submodules": "unsupported",
    "links": "unsupported",
    "observation": "two matching reads; not atomic",
    "tests": "not evaluated"
  },
  "fingerprint": "<64 lowercase hexadecimal characters>",
  "state": {
    "head": "<full 40- or 64-character Git object ID>",
    "index": [
      {"path": "removed.txt", "mode": "100644", "oid": "<full Git object ID>"},
      {"path": "src/app.txt", "mode": "100644", "oid": "<full Git object ID>"}
    ],
    "files": [
      {"path": "removed.txt", "kind": "missing"},
      {"path": "src/app.txt", "kind": "regular", "bytes": 9, "executableBits": 0, "sha256": "<64 lowercase hexadecimal characters>"}
    ]
  }
}
```

The example uses placeholders and is illustrative, not a valid artifact. Index and file arrays must be unique and sorted by JavaScript string comparison of `path`. Index modes are `100644` or `100755`. All index paths must appear in `files`. Source symlinks, gitlinks, conflict stages and intent-to-add entries fail capture. Each `regular` hash covers its raw on-disk bytes, with no content-filter normalization.

The fingerprint is SHA-256 over UTF-8 `JSON.stringify(state)` with exactly the key order illustrated: `head,index,files`; index entries `path,mode,oid`; regular entries `path,kind,bytes,executableBits,sha256`; missing entries `path,kind`. `executableBits` is the observed POSIX `mode & 0o111` mask (JSON decimal integer), or zero on Windows. Other permission bits and ACLs are excluded. `validateStamp` reconstructs key order before checking the digest, so JSON object key reordering does not invalidate an otherwise equivalent artifact. Timestamps and coverage are outside that digest but their version 1 values/shapes are validated. CLI output also escapes C1 control characters while preserving their parsed JSON values.

`readStamp(filename, {signal} = {})` reads a regular artifact file with a bounded allocation, fatal UTF-8 decoding and duplicate-key rejection. Nesting, duplicate keys and numeric precision are checked before native JSON parsing. Every number must denote an exact safe integer; `1.0`, `1e0` and `10e-1` are exact equivalents, while `1.0000000000000001` and an underflowing `1e-400` are rejected. It refuses leaf symlinks. Callers provide the path explicitly; the library does not discover private session files, output destinations or credentials.

`checkStamp(directory, savedStamp, {signal} = {})` returns:

```json
{
  "version": 1,
  "status": "stale",
  "expectedFingerprint": "<saved digest>",
  "observedFingerprint": "<current digest>",
  "capturedAt": "2026-10-28T12:00:00.000Z",
  "checkedAt": "2026-10-28T12:05:00.000Z",
  "headChanged": false,
  "indexChanged": false,
  "changedPathCount": 1,
  "changedPaths": ["src/app.txt"],
  "pathsTruncated": false,
  "tests": "not evaluated"
}
```

`status` is `fresh` or `stale`; failures throw `StampError` instead. `changedPaths` lists up to 100 disk-state changes. An index-only or HEAD-only change can be stale with an empty list. CLI `--json` failures return `{version:1,status:"indeterminate",error:{code,message},tests:"not evaluated"}` and exit 2.

The observation is not atomic or authenticated. Matching hashes mean only the included observed state matched; they do not establish execution, test success, test adequacy, provenance or protection against a writer fabricating/restoring state. A hostile same-user process can race readers or rewrite the artifact. Hashes and relative paths may still disclose private information.
