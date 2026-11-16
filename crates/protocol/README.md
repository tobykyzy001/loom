# `loom-protocol`

`loom-protocol` is the shared, versioned Rust domain and wire contract for M0.
It has no HTTP server, database, filesystem or secret-storage implementation.
All domain calls are deterministic: the caller supplies current UTC and current
stale-proof state. Tokio is a small workspace dependency for async adapters,
not a runtime owned or started by this crate. No LLM/provider is called.

## Public modules and key types

- `core`: `ProtocolVersion` (`"loom.node.v1"`), UUID newtypes (`TicketId`,
  `AssignmentId`, `LeaseId`, `ReportId`, `RequestId`, `ArtifactId`, `EffectId`,
  `ProjectId`, `ChallengeId`), `NodeId`, `WorkerId`, `InstallationId`,
  `HarnessKind`, `ProfileId`, `RelativePath`, `Sha256Digest`, `GrantDigest`.
- `domain`: `Ticket`, `TicketKind`, `TicketStatus`, `Assignment`, `Grant`,
  `Permission`, `Operation`, `Lease`, `Report`, `ReportStatus`,
  `ArtifactRef`, `EvidenceRef`, `Effect`, `EffectStatus`, `SessionRef`.
- `node`: `NodeEnvelope<T>` and flattened aliases (`HeartbeatRequest`,
  `AssignmentPollRequest`, `ReportRequest`, `ArtifactUploadRequest`), register
  and challenge DTOs, `WorkerSnapshot`, `Capability`, `AssignmentPayload`,
  `ReportResponse`, `from_json_strict`, `to_canonical_json`.
- `identity`: `NodePublicKey`, `ChallengeNonce`, `RegistrationChallenge`,
  `NodeIdentity`; raw Ed25519 challenge and fingerprint validation.
- `policy`: `AuthorizationStore`, `authorize_report`, `DomainState`,
  `cancel_assignment`, `ReconciliationRule`.
- `state`: `M0StateMachine`, `ReportOutcome`, `HostEffectFact`.
- `error`: derive-`thiserror` `ProtocolError`, and `ProtocolResult<T>`.

The crate root re-exports these types. Major semantics are documented on their
methods. `ed25519-dalek`, base64, chrono, uuid, serde/serde_json and sha2 are
used for precise wire/security primitives; no HTTP framework is selected here.

## Wire contract (`loom.node.v1`)

### Encoding

- JSON object keys and status/operation values use `snake_case`.
- UUIDs are canonical strings, timestamps RFC3339 UTC, times/beats are explicit.
- `NodeId` is exactly the lowercase SHA-256 hex digest of the **raw 32 byte
  Ed25519 public key**--not a hash of base64 text, nickname, hostname or token.
- `public_key` and `signed_challenge` use unpadded base64url of raw 32/64 bytes.
  Sign the nonce's 64 lowercase UTF-8 hex bytes, not JSON or decoded nonce bytes.
- No secret is placed in envelopes. The HTTP transport still authenticates an
  actual node-scoped bearer token and binds it to Node **and Installation**.
- Protocol versions are validated during typed deserialization and dispatch.
  Reject unsupported versions before interpreting body semantics.
- `from_json_strict` rejects duplicate members recursively. Do not allow
  last-write-wins for security-relevant keys. Size limits are the HTTP adapter's
  responsibility. Unknown extra members are currently accepted for forward
  compatibility but can never be interpreted as extra permission.

`NodeEnvelope<T>` always contains `protocol`, `node_id`, `installation_id`, and
`request_id`; its payload is flattened. `sent_at` is optional and observational:
poll clients may omit it. It does not decide Lease freshness. A Report envelope
contains `report_id`, `ticket_id`, `assignment_id`, `worker_id`, `attempt`,
`lease_id`, `lease_epoch`, monotonically positive `sequence`, `grant_digest`,
`status`, `summary`, optional `session`, `artifacts`, `effects`,
`cancel_acknowledged`, and `created_at`. Input accepts `requested_state` as an
alias for `status`; serialization always emits `status`.

`AssignmentPoll.wait_seconds` is in `0..=20`. Heartbeat snapshots state their
worker/profile/harness/capabilities and observation time; server-side staleness
and authenticated inventory are separate. An online/busy heartbeat must declare
one or more workers; degraded may honestly declare none.

### Challenge and initial trust (helpers are not an enrollment service)

`POST /api/v1/nodes/challenge` (public route) has `ChallengeRequest` /
`ChallengeResponse`. Server generates cryptographic random `challenge_id` and
nonce, persists them with node/key/installation and short expiry, and enforces
single consumption. A challenge proves a signature, **not Membership, Project
access or Grant**.

`POST /api/v1/nodes/register` uses `RegisterNodeRequest` /
`RegisterNodeResponse`. `RegistrationChallenge::consume` and
`RegisterNodeRequest::validate` enforce encoding, fingerprint binding and
Ed25519 signature. `NodeIdentity::from_registration` additionally binds the
stored challenge and explicit presence of a server-verified enrollment code.
The server must atomically:

1. hash/compare the single-use unconsumed enrollment code using a secret-aware
   credential primitive (do not log the plaintext code);
1. load an unused fresh challenge matching node/key/installation/nonce;
2. consume it and register the public key, worker/harness/profile in one DB
   transaction, with `request_id` dedupe and no side-channel success state;
3. issue an opaque node-scoped token, storing only an appropriate verifier/hash.

`enrollment_code: String` is a required inbound field. A token-rotation endpoint
may accept a separate transport request DTO omitting it;
`NodeIdentity::authorize_session_rotation` requires an already verified bearer
matching the existing node plus the same key/installation/worker/harness/profile.
Revocation prevents rotation. Do not stuff literal/token secrets into domain
logs, activity or Grant JSON. `RegisterNodeResponse.grant_digest` can be `null`;
registration itself never creates one.

### Assignment/Report and associated Artifact/Effect

`AssignmentPayload` includes the selected Assignment/identity/attempt/fencing,
Project identity, objective and ticket kind. M0 sends `grant_digest`; a grant's
existence/version must be checked at center/Host execution rather than inferred
from report or self-declared capability.

`ReportPayload` fields map to `Report` by `ReportRequest::into_report`.
Round-trip creation uses `ReportRequest::from_report`. `ReportResponse` has
`accepted|reconciling|duplicate|cancelled`, so receivers do not mistake
idempotent replay or uncertainty for a brand-new success.

`ArtifactUpload` uses **`bytes_base64`** (not `bytes`) for a strictly bounded
standard-base64 M0 payload. The HTTP server must reject excessive body sizes
before allocating. `ArtifactUpload::validate` validates *canonical* base64,
matching `metadata.artifact_id` and Assignment/Ticket metadata, byte length and
SHA-256 content. Artifact location is a controlled non-`file:` URI; no host
absolute path is a global Artifact URI. Every reference includes an explicit
UUID, ticket/assignment/origin lineage, media type, byte length, SHA-256 hash,
parents and evidence. Report/Artifact association is separate from transport;
a Report reference is no proof that bytes have actually arrived or been stored.

`Effect` has stable `effect_id`, input digest, matching ticket/assignment/node/
attempt and evidence, plus Artifact IDs already present on the same Report.
Effects follow reconciliation; `Unknown != Failed` and no exactly-once promise
is made. DB inserts/reconciliations must anchor uniqueness on stable
`assignment/attempt/effect_id/input_digest`, not a fresh RequestId.

Example fixtures under [`../../protocol/fixtures/node/v1`](../../protocol/fixtures/node/v1)
are generated from real DTOs and an explicitly synthetic Ed25519 key. They
include challenge, signed register, heartbeat, poll/assignment, successful and
Unknown Report, Artifact payload and invalid protocol/key/signature fixtures.
They can be consumed directly by TypeScript tests. Run the deterministic
generator only when intentionally changing the contract:

```sh
cargo run -p loom-protocol --features fixture-signing --example generate_fixtures
```

## Authorization and M0 state

### Grant is not Lease; neither is registration

`Grant` binds Node **and Installation**, Worker, Project, operation, explicit
`version`, issued/expiry/revocation times and operation path scope. Empty
operations, non-positive versions, backwards expiry and expired/expired-revoked
objects are rejected. `Read` grants operation-level read_summary, not arbitrary
filesystem/resource access. `ReadPath`/`EditFile` give minimal explicit logical
targets. An edit without a target (`SensitiveTargetRequired`) is always denied.

Scope follows path components, so `src` includes `src/main.rs` but never
`src-old/file` or `src/../secret`. Paths are Unicode/slash-separated *logical*
paths. Absolute paths, backslashes, `.`/`..`, drive prefixes, NUL and empty
components are rejected. The Host must additionally canonicalize a supplied
existing root, reject symlink escapes and bind exactly this Grant within its
platform+OS policy; `RelativePath` alone is not a sandbox.

Grant authorization is immutable and independent of the time-limited Lease.
Lease starts at epoch 1, binds exact Assignment/Ticket/Node, and may be revoked
on cancellation. Lease alone. Digest pinning is
`SHA-256(serde_json::to_vec(the valid immutable Grant))`. This compact JSON
encoding, fields, enum variants, timestamps and digest algorithm are **the v1
pinning contract**; change them only with an explicit version/migration. A
copy moved to a different scope/version must have a new digest. Revocation
advances version and fences an old digest even though digests no longer match.
`Assignment::authorize` verifies immutable lease/digest links only; it is not a
project authorization shortcut. `Assignment::authorize_for_ticket` and
`authorize_report` verify actual Project scope with the authoritative Ticket.

`Ticket::new` performs Project/Worker/Node validation when supplied a real
Grant. `Assignment::new` + `Ticket::attached_assignment` establish pending →
running, attempt 1 semantics. `attempt` is a durable authority discriminator;
Worker or Agent identity does not replace Assignment/Lease. Use explicit retry
only on a Failed ticket with no Unknown effects, and a fresh incremental attempt.
Never blindly rerun `Reconciling` tasks.

### Report gate and idempotency

`authorize_report` expects an adapter implementing `AuthorizationStore` over
*a transactionally loaded current* Ticket, Assignment, Grant and Lease. Token
Node + Installation authentication is checked before invoking it.
`authenticated_node_matches` must additionally be evidence of that server check.
It validates all correlation, Non-nil/real Project scope, Grant+epoch fencing,
active expiry/cancel gates and Artifact/Effect lineage via `Report::validate`.

`DomainState` is a small **in-memory**, pure reducer for tests/adapters, not a
second authoritative task store. `accept_report` does these transitions:

| Structured outcome | Current Lease / cancellation | Ticket authority |
| --- | --- | --- |
| Running | Active exact epoch + Grant | running |
| Succeeded | Active exact epoch + Grant | succeeded |
| Failed | Active exact epoch + Grant | failed; preserve evidence |
| Unknown | same; or after accepted cancellation with explicit ack | reconciling, never failed |
| Cancelled | cancellation requested + exact old attempt | cancelled; expiry/revoked Lease may only acknowledge it |

A requested cancellation blocks fresh success/work, persists durable intent,
and supports late exact cancellation acknowledgement/expired-effect uncertainty.
It does not license a new Report after final success or silently revive a task.

Within one Assignment/Lease, `sequence` strictly increases. Repeated
`(node_id, request_id)` plus the **exact same stored Report** returns `duplicate`
with the previously accepted outcome, never new duplicate artifacts/effects.
Same ID plus different content is `IdempotencyConflict`, and mutates nothing.
The reducer only retains the latest report/ledger outcome in its demonstration
state; persistent stores must compare against a durable unique idempotency key,
not a process-local latest sequence. Enforce DB constraints atomically:

- `UNIQUE(node_id, request_id, <endpoint kind>)` and full canonical Report digest
  under the node ticket scope; request IDs are endpoint-scoped, not global grants;
- `UNIQUE(node_id, assignment_id, request_id)` with full Request replay record;
- `UNIQUE(artifact_id)` with immutable hash/lineage and separate byte store;
- `UNIQUE(assignment_id, effect_id)` with immutable `input_digest` and terminal
  reconciliation transitions; report IDs never create extra external effects;
- transactionally advance `(assignment_id, lease_epoch, last_sequence)` and
  report/artifact/effect/ticket rows or change none on rejection.

Use a single center writer, optimistic fencing/version checks in SQLite for
retries/concurrent requests. Do not accept an authenticated replay without
looking up its already recorded Report. Do not let a duplicate Report claim a
revised summary, artifact hash, effect state, Worker or Grant.

## Verification boundaries

From repository root:

```sh
cargo fmt --check
cargo test -p loom-protocol --features fixture-signing
cargo clippy -p loom-protocol --all-targets --features fixture-signing -- -D warnings
```

These checks cover typed serialization/signing and pure domain safety scenarios:
traversal/absolute/empty target, paths and immutable Grant scopes, old/expired/
revoked Lease, stale epoch/digest, revoked Grant, cancel gate and replay,
`Unknown` reconciliation, idempotency conflicts, artifact payload hash/size/IDs,
Node+Worker+Installation identity, signature freshness/replay and Profile scope.
They do **not** prove a real HTTP server, actual SQLite constraints/restart,
remote Node Host behavior, OS symlink protection, full DSH integration, mobile,
or non-macOS platform support. Those require corresponding separate evidence.
