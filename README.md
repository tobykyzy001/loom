# Loom

> Your agents. Your machines. One conversation.

Loom is an implementation-in-progress of a personal Agent fabric: a single authenticated Concierge coordinates explicit Task, Grant, Assignment/Lease, Effect and Artifact state. Existing execution environments keep their own Session, data and permissions.

## Implemented in this checkout

- Versioned Rust wire/domain protocol (`crates/protocol`) with synthetic Ed25519 fixtures and Grant/Lease fencing tests.
- SQLite single-writer Concierge with client/session authentication, single-use enrollment, signed Node identity challenges, authorized assignment polling, structured reports, at-least-once effects, bounded artifacts, explicit memory and a hash-chained audit digest.
- Vue 3 + TypeScript authenticated conversation, task evidence, Project/Grant/Memory, display-preference, node fleet and activity views. No mocked Agents or fake completed tasks.
- Outbound TypeScript deterministic Local Node client and a buildable Host-only DSH bundle. The bundle only starts work when explicit config enables it. DSH Host adapters are based on installed DSH 0.2.2-rc.3 APIs; installed-DSH APIs. Under an isolated temporary `DSH_HOME/HOME`, `tests/harness/real-lifecycle.mjs` has actually installed and activated the bundle, registered a node, issued an actual DSH Agent followup, executed a controlled tool and returned a hash-checked Artifact. Those cases do not yet prove cancellation or Session resume; the live-model quality and full M0 product acceptance remain incomplete.

This is a **development baseline**, not an approved production release. No arbitrary terminal-command Runner, model download, silent clone/upload, automatic LAN takeover, unmanaged profile updates or privileged remote installers have been added. Natural-language chat text alone is not a permission grant.

## Development commands

```sh
# Rust protocol and support crates
cargo test -p loom-protocol --features fixture-signing
cargo test --workspace --locked
cargo run -p loom-concierge --bin loom -- smoke

# Deterministic reference clients and plugin; no model/API provider called
pnpm --dir packages/node-client test
pnpm --dir plugins/dsh-loom test
pnpm --dir apps/web test
pnpm run build

# Replace this example with an explicitly local UID folder, not a user profile/profile patch
cargo run -p loom-concierge --bin loom -- --data-dir /tmp/my-isolated-loom-center serve \
  --listen 127.0.0.1:8787 --web-dir apps/web/dist
```

The first start prints a bootstrap client token to the terminal and stores it only in the selected state directory. Subsequent starts with the same DB require the same `LOOM_CLIENT_TOKEN`; recovery cannot silently replace the administrator credential. A non-loopback listen address is unsafe in this initial HTTP implementation; HTTPS/reverse-proxy trust boundaries must be completed before exposing a network interface.

```sh
LOOM_CLIENT_TOKEN='<same-local-admin-token>' \
  cargo run -p loom-concierge --bin loom -- --data-dir /tmp/my-isolated-loom-center serve \
  --listen 127.0.0.1:8787 --web-dir apps/web/dist
pnpm --dir apps/web dev
```

Open the local development server port printed by Vite and enter the token in the UI's connection dialog. There is no built-in token. The Vite proxy forwards API calls to `127.0.0.1:8787`.

### Authorized local file task

Current deterministic tasks are deliberately bounded to `read_summary` (read a small ordinary project file and create a new JSON Artifact) and `edit_file` (replace only an explicitly named relative file, atomically). They are **not** a model-generated programming agent.

1. Use **Projects** to register an existing local project directory. Registration is a probe, not a Grant.
2. Start a local reference Node with an isolated state directory and node token from the authenticated **Devices** view's enrollment-code generation. Its configuration declares the approved ProjectId→local root mapping.
3. Confirm that exact Node/Installation/Worker mapping through `POST /api/v1/project-bindings`. The node must first declare that exact mapping in a heartbeat; a client cannot replace it with another location or remote machine.
4. Create the smallest applicable Grant, then create the Task. Capability and registration alone do not produce work. The immutable assignment pins its ProjectBinding and grant digest.

See `IMPLEMENTATION_PLAN.md`, `packages/node-client/README.md`, `plugins/dsh-loom/README.md` and `MEMORY.md` for current integration decisions, verified command results and known gaps. Do not substitute existing DSH profile files, credentials or real personal projects for the synthetic fixtures.

## Test boundary

The following independent levels are intentionally different:

```sh
cargo test -p loom-node
node scripts/bare-integration.mjs
node scripts/real-integration.mjs
node scripts/verify-baseline.mjs
node scripts/dsh-fixture-runner/run.mjs
```

- Bounded deterministic local-node core: 11 shared-entity safety cases at present plus true foreground Rust↔TypeScript workflows.
- Bare Rust local-node protocol and real read/write/restart behavior.
- **Actual installed DSH isolated fixture**: plugin CLI install/activation, signed registration, real DSH Agent turn/tool/Artifact. Cancellation and resumed Session are still gates in this same runner, so observe its actual completion result rather than claiming it because installation succeeded. A zero-network Stub Provider exercises orchestration, not live model behavior.

No 1 Concierge + 3 Node Compose topology was built per the initial request. There are no paid LLM calls, no Chrome/iOS/Android/Windows/Linux host tests recorded yet, no signed installers, and no integrated OS credential store. Protocol/unit PASS or a working DSH task does not mean production acceptance across all of these.

Live LLM and real multi-agent programming remain a separate enabled next-level test with explicit budgets and provider configuration. Never create them by reading an existing user's DSH profile, credentials, browser token or private project paths. `model`/`pipeline` endpoints are intentionally unavailable until real adapters and complete DAG scheduling can be validated.
