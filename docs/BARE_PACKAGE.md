# Bare Host native package smoke

## Purpose

Validate a **current-machine, source-built Bare Host binary** and its boundary behavior in a test-owned package directory. This document describes the concrete packaging smoke command below; it is not an installation recipe, platform support matrix or remote deployment plan.

Run from the repository root:

```sh
node scripts/bare-package-smoke.mjs
```

The runner builds `loom-node` from the checked-in Rust source and verifies the resulting executable, its copied bytes and a small versioned package manifest. It does not copy private Node state, user projects, DSH Profiles, credentials or model weights into the package.

## Observed current-host evidence

The coordinator independently ran the completed script with exit **0** and 12 labeled checks. An observed run wrote `./package/manifest.json` and a private smoke report under its owned directory `/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-bare-package-67X0Gt`.

- Package: `loom.bare-host-package.v1`, `loom-node 0.1.0`.
- Observed current host/toolchain: **macOS arm64**, a `Mach-O 64-bit executable arm64`, Rust `1.99.0 (b940084d7 2026-09-28)`.
- Binary size: **21,778,296 bytes**; executable mode `0755` for this generated local candidate. Owned root/state/artifact/project fixture directories are checked `0700` on POSIX.
- SHA-256 of the actual built and copied binary: `1c9dc260a2d689602a6e133b9017561d9b69c30136834e08f51aaa05de3542c5`. Copying preserved both size and bytes; the final package contains only `loom-node` and `manifest.json`.
- Actual `otool -L` inspection observed the system `/usr/lib/libiconv.2.dylib`, `/usr/lib/libSystem.B.dylib` and CoreFoundation dependencies. These are facts for this candidate, not a cross-platform dependency guarantee.
- `cargo build --locked --offline -p loom-node` was used for the source build. An environment missing a locked cached dependency is a real failure/NOT RUN; the script does not silently fetch an alternative dependency.
- `--version` prints `loom-node 0.1.0`; `--help` exposes only the real `bind` and `start` commands. These informational calls return 0 without creating an identity, registration request, coordinator grant, Agent/session or project effect. The test actually executes both and compares owned-root contents before and after.

## Guard behavior actually exercised

The script requires a regular executable file, a byte digest match and a POSIX execute bit. Stale/truncated or zero-byte payloads fail before execution. Symlinks and multi-link inodes are rejected rather than treating a path-shaped filename as an owned immutable binary. The hardlink negative is created from a separate source copy, so the legitimate package remains single-linked. No other-platform alias is supplied or executed.

The existing Bare CLI is used without modification. Explicit `PROJECT_ID=/ABSOLUTE/APPROVED/ROOT` declarations are required; roots do not default to cwd. Relative paths, filesystem root/HOME/current DSH-profile state directories, missing state directories and malformed bindings are exercised. State, artifacts and source-project fixtures remain separate siblings. A missing approved root fails the real bind command.

Invalid enrollment is attempted only against a test-owned local HTTP endpoint. Actual challenge and rejected-registration POST interactions are observed, with no heartbeat, assignment polling or accepted Grant afterward. This rejection fixture proves the controlled negative policy path, not a coordinator success or production authentication quality. The positive ordinary execution lifecycle remains a separate real flow:

```sh
node scripts/bare-integration.mjs
```

That integration command also passed after this packaging increment, including genuinely produced artifacts, an authorized atomic file effect, persisted cancellation and restart without repeating completed work. Its limitations remain unchanged and are independent of package metadata.

The package explicitly records `built_not_installed_not_activated` and `current_host_only`. A generated binary is not an installed, registered, granted or authorized Node. Private identity generation, pairing, ProjectBindings, current Grants and ordinary Tickets remain separate explicit steps.

## Review fixes and remaining limitations

The original child-agent draft was not accepted until it ran end to end. The coordinator fixed a syntax error, an async callback that attempted `await` incorrectly, an asynchronous evidence function that had not been awaited, and a snapshot/property mistake in the informational side-effect test. Cargo is now explicitly offline. The original `otool` check was corrected to redact only the declared binary path rather than treating all legitimate `/Users/...` workspace paths as private-profile evidence. The error predicates were tightened and HTTP request methods checked as POST; a path variable no longer shadows the fs `symlink` function. The hardlink negative no longer contaminates the final legitimate package's `nlink=1` check. The final script was rerun, rather than relying on the draft's filename or source claims.

**Still NOT RUN / not delivered:**

- Any second physical host, cross-machine/TLS transport or remote installation;
- Linux, Windows, other CPU architectures, distributable notarization/signing and platform-specific verification of install/update/uninstall;
- SSH/Ansible deployment, sudo/system service or LaunchAgent installation, dock/tray/Tauri/service behavior;
- OS Credential Store or DSH profile integration, real model invocation and live-provider quality;
- A claim that a package/helper exists on another system until actually built and executed there.

The test creates private temporary state and stops its owned processes and listeners. It does not scan directories for SSH credentials, install a system/global package, inspect the current desktop Profile or perform model/provider calls. Temporary paths appear in the process report for diagnosis; they are not a portable output destination or source of authority.
