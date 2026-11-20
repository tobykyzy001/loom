# Local project probe safety evidence

## Production project facts and explicit re-probe

Run the production-browser proof in addition to the original API probe:

```sh
pnpm --dir apps/web build
node tests/projects/browser.mjs
```

`tests/projects/browser.mjs` uses a real owned Git repository, a separate plain document directory, a real Rust Concierge, and standard Playwright/Edge with a separate owned profile. No real desktop/DSH profile, remote Host, provider or paid model is read or called. It has no real `desktop` credential lookup and **no clone, fetch or remote operation**. It verifies:

- an initial nested `Project.inventory` contains actual `form`, `source: controller_probe`, `probed_at`, public canonical remote, HEAD and local modification state returned by real Git commands;
- the protected Projects page displays this evidence, with the actual Git HEAD as a **baseline**, not as proof that current worktree bytes match it. `git status` clean is not silently emitted for dirty, unknown or non-Git;
- dirty `read → change file → explicit refresh` uses the real authenticated existing `POST /projects/{id}/probe`. One held first request visibly disables refresh, and a second click while disabled creates no second call. This is a busy-lifecycle check, not a new once-only side-effect guarantee;
- an unsafe remote remains suppressed in both the real API and UI, whereas its known-redaction state remains public. Credential-store categories/status stay distinct from credential contents or remote access;
- a Git command with no viable repository metadata can lawfully produce `dirty:null` and `revision:null`. The UI explicitly says it has not obtained the current modification state; it does not mark a clean worktree. Missing inventory in a probe receipt is rejected rather than replacing a previous observation;
- stopping the Concierge, deleting the **owned fixture's** Project row in its owned SQLite database, reopening and probing it produces a real `HTTP 400 project not found`. The UI preserves the earlier Project inventory and shows an explicit refresh error instead of fabricating a successful observation. The test then restores the exact fixture row and none of its independently created Grants or credentials;
- an actual same-data-dir, same-token, same-loopback-origin restart returns all Project inventory and preserves root/mode/version/created_at instead of opening a new empty SQLite database. The driver separately verifies the currently saved `probed_at` is preserved;
- 390px layout and a useful narrow project card have no horizontal overflow or row order substitution. This is a desktop viewport, not physical mobile proof.

The response projection accepts documented missing/null forms, limits revision to actual 40/64-hex IDs, enforces strict types/timestamps and canonical remote status. Unknown repository blobs and raw credential strings never enter public cards. **A working-tree `dirty:null` is explicitly unknown**, not dirty false. No new binding, Grant, Assignment or runtime action is created solely because an observation was displayed or refreshed.

To retain fixture screenshots and driver logs explicitly, use `LOOM_TEST_KEEP_EVIDENCE=1`. Default finally stops the owned browser/preview/server and verifies the resolved test root before deleting it; other sources/profiles are not scanned or modified. `/tmp/loom-project-facts-proof.json` contains only bounded checks without client/Node tokens, raw repository configuration or private remote strings. Git absence or a non-macOS platform is explicit **NOT RUN**, not a portability pass.

This completes the local fact-reading/explicit-refresh slice, not the full M1 environment, second Host or project execution graph.


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

This exposes local public Git metadata only; it does **not** establish remote access or verified availability of the remote. `credential_available: 'unknown'`, `credential_lookup_performed: false`, and `credential_location: null` remain explicit. Probe Git execution uses fixed non-mutating commands, bounded retained stdout (16 KiB), stdin/null and discarded stderr, a watchdog that kills/waits on timeout/overflow, an isolated nonexistent HOME/XDG target, disabled terminal/askpass prompts, no system/global config, and explicit `GIT_DIR`/`GIT_WORK_TREE`. Discovery still reads the registered repository's own `.git/config`; this does not read credential-helper/credential files, create credentials, invoke hooks or perform network operations. **Hooks are not the only configured helper entry point.** A former probe also invoked an external `core.fsmonitor`; the fixed invocation now explicitly overrides that key with the command-line `-c core.fsmonitor=` for every controlled inspection command, without editing that repository setting.

The actual independent HTTP negative fixture records a marker and exits non-zero if Git invokes its helper. Before the fix, that marker appeared while `read_only_probe:true` was returned; now it must remain absent through create and re-probe. A control after unsetting the same configuration still preserves the actual revision and modified-file `dirty:true` observation. Original remote redaction, permission status and the no-probe-HOME rule all remain. This is the current macOS/POSIX helper proof for the specific `core.fsmonitor` channel, not a claim of trusted execution of every arbitrary Git repository configuration or verification of other operating systems.
