# Loom Node client

A dependency-free ESM M0 outbound client, identity/outbox store, and deterministic single-node file executor. It is **not** a DSH executor, a second task authority, a server transport, or a general-purpose shell.

## Run

Use an absolute `stateDir` explicitly reserved for the test or isolated plugin instance. The initial registration needs a one-use enrollment code obtained by the coordinator's client-token-authenticated administrative API.

```sh
# Synthetic protocol regression, then spawn an isolated real Rust Concierge and actual Node execution.
node scripts/verify-baseline.mjs

# Equivalent real-only command; writes a credential-free JSON result to a temporary directory.
node scripts/run-real-integration.mjs

# Alternatively, connect to a caller-managed loopback server only.
LOOM_BASE_URL=http://127.0.0.1:8787 \
LOOM_CLIENT_TOKEN=<synthetic-test-token> \
node scripts/run-real-integration.mjs
```

The real runner uses `target/debug/loom` if present, otherwise `cargo run -p loom-concierge --bin loom --`, and isolates its center/node/project entirely below a new temporary directory. `LOOM_SERVER_CMD` is an optional **direct command with arguments, not a shell script**; `LOOM_TARGET_BINARY` can select a specific binary. The short-lived test client token is set only in the child environment, never put in its arguments or JSON result. The test terminates its child server; it neither installs nor launches DSH and never reads or changes a user Profile.

Registration defaults to `workerId: 'default'`, matching ordinary Rust ticket placement. Other workers and remote registrations must be explicit. `projectRoots: { [projectId]: root }` declares the host-owned mapping in the heartbeat. The administrator separately approves that exact mapping with `/api/v1/project-bindings`; neither Grant nor Ticket can substitute cwd, `$HOME` or another locally discovered path for the approved root.

```js
import { LocalNodeRunner, ControlledFileExecutor } from '@loom/node-client'
const node = await LocalNodeRunner.create({ baseUrl, stateDir, artifactDir, enrollmentCode,
  projectRoots: { [projectId]: '/absolute/explicit/isolated/project' },
  registration: { workerId: 'default', harnessKind: 'local-http', profileId: 'isolated' } })
await node.tick() // authenticated outbound HTTP only; drain the outbox and inspect authoritative Ticket state
```

No environment profile, working-directory guard, or external npm package supplies authorization. Assignment+Grant are checked for node identity, lease/Grant version, project, operation and expiry. The local executor only handles deterministic `read_summary` and `edit_file` under an explicitly granted test project. Paths are real, non-symlink project directories; ordinary file size is limited to 1 MiB. Edits use same-directory atomic rename. Read effects do not modify project files. Atomic rename is not inverse rollback, `fsync`, or crash-atomic database semantics.

## Persistence and effects

`identity.json` contains an Ed25519 keypair and the node-specific bearer token; private keys stay under the supplied isolated state directory. `node-state.json` persists request IDs, assignment fences, completions, activity, artifact/report/event outbox entries, and a bounded local delivery journal. HTTP failures retain outbox entries with retry time; 401/403/409/410/422 are blocked pending operator action. Unknown effects must be reconciled and are never retried blindly. Durable writes use same-directory atomic rename; this does not make a whole task transaction crash-atomic.

The executor writes a pending local effect record **before** rename and leaves an artifact with content hash. On restart, unfinished dispatcher completions become `unknown`. `reconcileEffect()` only checks external bytes; it cannot identify someone else's later modification.

## Wire fields fixed

`POST /api/v1/nodes/challenge`: public `{protocol:"loom.node.v1",node_id,installation_id,public_key}`. `node_id` is SHA-256 of the raw 32-byte public key, lowercase hex. `POST /api/v1/nodes/register` adds `enrollment_code`, `nonce`, `signed_challenge`, `request_id`, `capabilities`, `worker_id`, `harness_kind`, `profile_id`. Base64url base encodings are used for raw public key and raw 64-byte signature over the nonce UTF-8 bytes. Existing node registration may present its old node token. All later calls are node-token only, never fallback to `LOOM_CLIENT_TOKEN`.

Poll: `{protocol,node_id,installation_id,request_id,last_assignment_id,wait_seconds}`. Reports use `ticket_id`, `assignment_id`, `lease_epoch`, `requested_state`, `summary`, `evidence`, `artifacts`, `effects`. `POST /nodes/artifacts` carries metadata plus bounded M0 `bytes_base64`. `POST /nodes/acknowledge` records accepted/rejected separately. The server retains authority for validity and response semantics.

Some actual Rust response shapes and assignment/Grant nesting are not yet documented in this repository. `poll` expects `{assignment:null|object}`; `assignment.grant` supplies project root, `project_id`, `operations`, `version`, `digest` etc. JSON `grant_version` is locally matched against Grant version. For stable interop, emit all these fields under assignment-level `kind`,`relative_path`,`content`,`id`,`ticket_id`,`node_id`,`lease_id`,`lease_epoch`,`lease_expires_at`,`grant_version`,`grant_digest`,`attempt`. The isolated synthetic fixture in `scripts/fixtures` uses this candidate shape and is **not proof of conformance with the current Rust server**.

Acknowledge accepted/rejected, `cancellation` and `reason` are the node's candidate payload pending coordinator integration. Public client routes `GET /health`, `POST /enrollment-codes`, `POST /projects`, `POST /grants`, `POST /tickets`, `GET /tickets/{id}`, `POST /tickets/{id}/cancel`, and `GET /nodes/artifacts` aren't emulated by the node client; the baseline harness consumes them directly on the authorized coordinator API.

## Test

```sh
node --test packages/node-client/test/*.test.js
```

Unit and isolated deterministic HTTP tests use only Node built-ins and synthetic data. They do not invoke paid models, the user's filesystem outside a temp directory, or DSH Sessions.
