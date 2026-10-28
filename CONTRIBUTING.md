# Contributing

Use Git 2.45+ and Node 24.8+ with a current Node 24 or 26 LTS patch. Run `npm test`, then `npm run test:package`. The tests need no model account, API key or dependency install; package smoke uses npm for a fresh local archive installation.

Useful issues include a fictional minimal repository, exact CLI command, Node/Git/OS versions, expected included state and observed result. Keep private contents, filenames, hashes, transcripts and absolute paths out of public reports. Use a disposable directory you own; do not test against an irreplaceable working repository.

Preserve read-only operation and explicit coverage. A new Git format, platform case or filesystem condition should fail indeterminate until its semantics are supported and exercised. Do not silently skip included data, follow source links, execute user commands, weaken bounds or label a matching stamp as proof that tests passed. A deterministic race counterexample is more useful than a broad success claim.

Open a focused pull request with the before/after behavior and checks actually run. Documentation, minimized fixtures and platform-specific observations are welcome. CI spans Linux/macOS/Windows, Node 24 and 26, and the Node 24.8 minimum; a Windows run alone is not cross-platform verification.
