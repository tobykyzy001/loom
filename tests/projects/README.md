# Local project probe safety evidence

`git-probe.mjs` registers an **isolated temporary Git repository** with a synthetic credential-bearing `origin`, creates the project over the authenticated Concierge HTTP API, then probes again after modifying a fixture file. The original URL appears only in the temporary repository configuration. Assertions cover the created/reprobed/listed **public inventory**, persisted SQLite project inventory, audit records, dirty-state observation, non-Git document behavior, explicit redaction, and no creation of a probe HOME. The repository is never fetched, cloned or pushed. Fixture commits supply an explicit test author and do not rely on global/system Git configuration.

Run:

```sh
cargo test -p loom-concierge --lib api::tests
node tests/projects/git-probe.mjs
```

The Node driver builds the current `loom` binary through the existing Rust server fixture. It prints `{overall:'NOT RUN', reason:'git binary unavailable'}` when Git is unavailable; that is not platform validation. The Rust Git fixture likewise skips only when `git --version` is unavailable.

The implemented `canonical_remote` contract is deliberately conservative:

- Allow only literal lowercase `http`, `https`, `ssh`, `git` URL schemes or the SCP-style `git@host:path` form.
- Drop complete HTTP(S) userinfo and lowercase the validated public hostname. Preserve case-sensitive, safe path components, with no query or fragment retained. `https://user:password@example.invalid/team/repo.git` becomes `https://example.invalid/team/repo.git`.
- SCP-style SSH becomes `ssh://git@host/path`. `ssh://` permits only literal `git` as an optional public login. Any other username, a password, or a malformed/out-of-range SSH port is redacted.
- Accept only bounded printable-ASCII public host/path material. Reject absolute/local paths, escapes, whitespace/control/non-ASCII characters, `..`, `.` components, empty components, backslashes, shell/wildcard/bracket/`~` material, and option-looking path components. These are not command execution decisions—they are strict metadata eligibility rules.
- Unsupported/redacted configured remotes produce `canonical_remote: null`, `canonical_remote_status: 'unsupported_or_redacted'`, `redacted_remote: true`, and `needs_review: true`. There is no raw error echo. A sanitized public remote has status `public`.

This exposes local public Git metadata only; it does **not** establish remote access or verified availability of the remote. `credential_available: 'unknown'`, `credential_lookup_performed: false`, and `credential_location: null` remain explicit. Probe Git execution uses fixed non-mutating commands, bounded retained stdout (16 KiB), stdin/null and discarded stderr, a watchdog that kills/waits on timeout/overflow, an isolated nonexistent HOME/XDG target, disabled terminal/askpass prompts, no system/global config, and explicit `GIT_DIR`/`GIT_WORK_TREE`. Discovery still reads the registered repository's own `.git/config`; this does not read credential-helper/credential files, create credentials, invoke hooks or perform network operations.
