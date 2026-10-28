# Security and observation limits

Worktree Stamp reads trusted local Git repositories and explicitly supplied JSON artifacts. It is a diagnostic tool, not a security sandbox, authenticated ledger, test runner, completion detector or atomic snapshot service.

Included source links and special files are refused. Git metadata itself is read through Git, including its normal linked-worktree references. Ambient `GIT_*` redirection is removed; fsmonitor and optional Git writes are disabled; no diff driver, hook or clean/smudge filter is invoked. Every Git invocation explicitly requires `--no-lazy-fetch` (Git 2.45+) so missing promisor objects cannot silently trigger a fetch. The Git executable and local filesystem remain trusted. Same-user writers can race readers or fabricate a matching saved artifact.

Ignored inputs, external configuration/environment/services and test results are outside coverage. Restoring previously observed bytes can restore a fingerprint; changes that occurred and were undone between observations are not detectable history. Unreadable, excessive or unsupported state fails indeterminate instead of fresh.

Artifacts contain relative paths, sizes, modes and hashes. These can disclose private information even though raw source bytes and absolute roots are omitted. Review reports before sharing them. Git errors are deliberately summarized without echoing local paths or configured command text.

For a suspected vulnerability, use GitHub's private vulnerability reporting if available. Share a fictional reproducer and expected/actual boundary; do not post credentials, private repository content or personal paths in a public issue. No response time or security certification is promised.
