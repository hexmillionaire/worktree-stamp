# Worktree Stamp

Check whether included Git content still matches an earlier observation, including changes made to an already dirty worktree. A matching commit and a `dirty: true` flag cannot distinguish two different dirty file contents. Worktree Stamp hashes those bytes and records index state too.

Dependency-free JavaScript ESM. Requires Git 2.45+ and Node 24.8+; use a current Node 24 or 26 LTS patch. Works offline after installation. It runs no tests, agent, model, shell command, Git hook or content filter. It writes no repository, index, receipt or configuration file. An explicit `--no-lazy-fetch` Git capability prevents missing objects from triggering a fetch; older Git fails indeterminate instead of ignoring that safeguard.

```sh
npm install -g @hexmillionaire/worktree-stamp
worktree-stamp capture --repo /path/to/project > ../project-stamp.json
worktree-stamp check ../project-stamp.json --repo /path/to/project --json
```

Save the JSON **outside the observed repository**, or in an intentionally ignored location. Creating a new included output file changes the state being observed. Shell redirection creates the destination before starting the program, so an output inside the repository can even be included while empty.

You can place a checkpoint around a command you run yourself. This POSIX shell example preserves a failed test result instead of replacing it with the stamp check's exit status:

```sh
worktree-stamp capture > ../before-check.json || exit 2
if npm test; then
  worktree-stamp check ../before-check.json --json
else
  exit 1
fi
```

The last command compares included state. Read the test command's own result separately. A fresh stamp says nothing about whether that command ran, passed, selected the right tests or verified the requested behavior.

## What is observed

- Full committed HEAD identity and index paths, staged modes and object IDs.
- Raw bytes of every tracked regular file, including files Git marks assume-unchanged or skip-worktree. Deleted tracked paths are recorded as missing.
- Nonignored untracked regular-file paths and bytes. Spaces and valid UTF-8 names remain literal JSON data.
- The exact owner/group/other execute-bit mask on POSIX. Windows records zero because it does not supply equivalent POSIX mode semantics; identical stamps across operating systems are not promised. Other permission bits and ACLs are uncovered.

Staging unchanged disk bytes can change the stamp because the index is part of its scope. A new commit can change it even if final file bytes are unchanged. Branch names, remotes, timestamps and filesystem ownership are not part of the fingerprint. A clone with the same included state can match; the stamp is content identity, not machine or repository authenticity.

Capture performs two complete observations and requires them to match. It checks opened-file identity and observed size/mode/write timestamps while streaming. An observed race fails as indeterminate. These reads are **not an atomic filesystem snapshot**: a writer can change and restore data between observations, and multiple paths cannot be read at one instant. Stop other writers when you need a quieter checkpoint.

## Exclusions and limits

Ignored files, external state, environment variables, toolchain versions, running services and test results are uncovered. Ignored dependency trees can change without invalidating a stamp. Ordinary Git exclusion rules determine which untracked paths are included; tracked files remain included even if a matching ignore pattern exists. Untracked special files that Git does not enumerate, such as FIFOs, are outside coverage. Special files replacing indexed paths are detected and refused.

Included symlinks, directory junctions, special files, submodules/gitlinks, unresolved conflicts and intent-to-add index entries are unsupported. Capture returns indeterminate instead of silently omitting them. Stage or remove intent-to-add entries before capture; their mode/object IDs alone can be identical to a genuinely staged empty file. Git's own administrative references for linked worktrees remain supported. A committed HEAD is required; unborn/bare repositories and unsupported index formats fail indeterminate. Sparse/partially checked out paths may appear missing; this is a disk observation, not materialization or checkout validation.

Any Git stderr output makes the observation indeterminate, even when Git exits zero. This prevents an unreadable untracked directory warning from silently turning an incomplete path list into a fresh result. Diagnostics use fixed messages rather than echoing Git's potentially private text.

Fixed initial limits: 10,000 included paths, 16 MiB per file, 128 MiB read per observation, 4 KiB per relative path, 4 MiB per Git response and 8 MiB per JSON artifact. Files stream through one reused 1 MiB buffer. Git subprocesses have 15-second timeouts; capture checks a 60-second deadline and optional cancellation between I/O operations. A kernel/filesystem operation already blocked cannot be synchronously cancelled by JavaScript.

Only regular, bounded, valid UTF-8 JSON stamp files are accepted. Unknown fields, duplicate JSON keys, unsupported versions, precision-losing number spellings, repeated/unsorted paths and inconsistent digests are rejected. Source bytes are never included, but relative filenames, byte counts and hashes can still be private. Review an artifact before posting it.

## CLI and API

`capture [--repo PATH]` emits a version 1 stamp as JSON. `check STAMP.json [--repo PATH] [--json]` emits a short status or a version 1 JSON comparison. The repository defaults to the current directory; a subdirectory resolves to its Git root.

| Exit | Meaning |
| --- | --- |
| 0 | Captured successfully, or included state matches (`fresh`) |
| 1 | Included state differs (`stale`) |
| 2 | Invalid, unsupported, cancelled or indeterminate observation |

```js
import { captureStamp, checkStamp, readStamp } from '@hexmillionaire/worktree-stamp';
const saved = await captureStamp('/path/to/project');
const report = await checkStamp('/path/to/project', saved);
console.log(report.status); // fresh or stale; never a test result
// const savedFromDisk = await readStamp('/outside/project-stamp.json');
```

All three asynchronous APIs accept an optional `{signal}` as their last argument. `validateStamp(value)` checks the exact v1 shape and self-consistent fingerprint. See [the v1 format](docs/FORMAT.md). Shape validation is not signature verification: anyone who can rewrite the artifact can fabricate a different observation.

## Why another small tool

[Agent Done Or Not](https://github.com/mohamedzhioua/agent-done-or-not) captures actual commands, applies policies and integrates with CI and stop hooks. [oh-my-hermes](https://github.com/rlaope/oh-my-hermes/blob/main/docs/WORKING-TREE-FINGERPRINT.md) already implements a conservative final-content fingerprint in a broader goal/evidence system; unchanged staging deliberately does not change its final-content identity. [Groundtruth](https://github.com/akahkhanna/groundtruth) checks transcript claims and includes stale-by-tree sensors. [Backcheck](https://github.com/VectorInstitute/backcheck) provides transcript-based analysis, but its repository was archived when checked October 28, 2026.

Use those tools for their broader workflows. Worktree Stamp is a small, standalone capture/check primitive that includes index state. It does not invent content fingerprints, integrate into client configuration, parse completion claims or attest to execution. The [dated research](docs/RESEARCH.md) explains the specific developer request and source-level freshness gap that motivated it.

## Contribute

Run `npm test` and `npm run test:package`. CI covers Linux, macOS and Windows on Node 24/26, plus the Node 24.8 minimum. See [CONTRIBUTING.md](CONTRIBUTING.md). Useful contributions include smaller fictional Git cases, race counterexamples, platform-specific observations and clearer exclusions. No account or API key is required.

Related: [Repo Fixtures](https://github.com/hexmillionaire/repo-fixtures), [Agent Lanes](https://github.com/hexmillionaire/Agent-Lanes), [Agent Desk](https://github.com/hexmillionaire/agent-desk), [Agent Lanes MCP](https://github.com/hexmillionaire/agent-lanes-mcp), [MCP Surface](https://github.com/hexmillionaire/mcp-surface).
