# Implementation and milestone execution plan

## Initial synchronized M0 baseline

Repository roots:
- `Cargo.toml`, `crates/protocol`, `crates/concierge`, `crates/node`: shared domain/protocol, single authority and bare local-node reference.
- `apps/web`: Vue 3 + TypeScript client served by Concierge's optional static directory in development/production.
- `plugins/dsh-loom`: installable ESM DSH Host plugin with its own package manifest.
- `protocol/fixtures`: versioned, language-neutral protocol examples.
- `scripts/verify-baseline.mjs`: single deterministic coordinator/node API benchmark, no Compose 1+3 topology.

Rust crate names and module boundaries must not overlap. Frontend files depend only on the HTTP surface below, not project database objects. The plugin ships its own Node client and files under `plugins/dsh-loom`; an independent shared `packages/node-client` may be added by the plugin owner with only its exported client consumed by Rust integration tests through HTTP messages.

### API conventions

Prefix `/api/v1`. JSON `snake_case`, UTC RFC3339 timestamps, UUID strings. Errors have status and body `{"error":{"code":"...","message":"..."}}`; do not leak internal SQL, file paths or credentials. Client APIs use `Authorization: Bearer <client token>` configured with `LOOM_CLIENT_TOKEN`. The control-plane bootstrap command issues an enrollment code but does not trust an unapproved node.

### Domain baseline

`Ticket`: `id`, `project_id`, `objective`, `status` (`pending|running|waiting_approval|succeeded|failed|cancelled|reconciling`), `attempt`, `assignments`, `reports`, `artifacts`, `created_at`, `updated_at`, `cancel_requested`, `grant_digest`.
`Grant`: immutable authorization with version, project scope and explicit operations. It does not imply Lease. Revocation versions forward, rejects new work and fences old reports.
`Assignment`: `id`, `ticket_id`, `node_id`, `worker_id`, `attempt`, `lease_id`, `lease_epoch`, `lease_expires_at`, `grant_digest`. Worker credentials cannot be reused as client credentials.
`ArtifactRef`: type/version, `artifact_id`, `ticket_id`, `origin_node_id`, `location` (controlled Host URI), `media_type`, `size_bytes`, `sha256` and lineage; not globally treating local paths as global URIs.
`Effect`: stable `effect_id`, input digest, status `recorded|unknown|confirmed|needs_person`, evidence. At-least-once delivery + explicit reconciliation; never claim transparent exactly-once.
`Report`: assignment/lease identifying state (`running|succeeded|failed|cancelled|unknown`), `summary`, evidence, `ArtifactRef`s, effects. Duplicate report digest must not duplicate artifacts/effects.
Explicit memory only with edit/delete/scoped listing. Display expanded/collapsed preferences never modify Ticket state. Audit includes enrollment, authorization, dispatch, cancellation, reports and effects, with no raw secrets.

### Client routes

- `GET /api/v1/health`: minimally queryable public health; all following routes require client token unless described below.
- `GET /api/v1/bootstrap`: summary metadata plus default ticket; UI default conversation anchors to it.
- `GET /api/v1/projects`, `POST /api/v1/projects` (`{"name","root","mode":"read_only"|"read_write"}`); authorize an explicitly supplied existing root through this single-user administrative action. Canonicalize on server and record hashed/normalized scope, don't disclose paths to conversation logs.
- `POST /api/v1/grants`, `GET /api/v1/grants`, `POST /api/v1/grants/{id}/revoke`: administrative task/project grant actions.
- `POST /api/v1/enrollment-codes` (`{}`): one-use expiring code, hash stored, returned once.
- `GET /api/v1/nodes`, `GET /api/v1/audit?ticket_id=...`: administrative inventory/evidence.
- `GET /api/v1/tickets`, `POST /api/v1/tickets`: JSON `project_id`, `objective`, `kind: read_summary|edit_file`, optional `relative_path` (safe relative UTF8 filename, no traversal) and `content` (for edit). Created pending with server-selected placement when capable/authorized. Validation doesn't overpromise AI planning; briefs explicitly interpreted as operation/brief.
- `GET /api/v1/tickets/{id}`: detail with reports/artifacts/effects/visible messages; `POST .../cancel` preserves cancellation intent and fences; `POST .../retry` for reconciling/failed with an explicit attempt and no executing unknown effects.
- `POST /api/v1/tickets/{id}/approval`: explicit non-sensitive workspace operation decision `approve|reject`, reason and unique id; treated as grant action, not chat text.
- `GET /api/v1/tickets/{id}/artifacts/{artifact_id}`: controlled metadata/content download only from known artifacts within authorized storage. No arbitrary path API.
- `GET/PUT /api/v1/preferences?ticket_id=...`: `expanded`, optional sender filter; global and per-ticket overrides.
- `GET /api/v1/memories`, `POST /api/v1/memories` (`project_id`,`content`,`scope`), `PATCH/DELETE /api/v1/memories/{id}`. Never creates grant or auto-observational memory.
- `GET /api/v1/messages` and `POST /api/v1/messages` (`thread_id`, `content`) support a simple single-thread Source/Trigger/Thread baseline. Structured operations remain separate from text. Avoid inferring sensitive permissions from natural language.

### Outbound node routes and authentication

Node starts registration with `POST /api/v1/nodes/register`, body fields fixed by protocol owner: envelope version `loom.node.v1`, installation identity, public-key-derived node fingerprint, challenge nonce, enrollment code and capability list. Codes authenticate first trust only. Center binds node ID and issues node-specific bearer token. Every node request `Authorization: Bearer <token>` and assigned node ID must match enrollment. No asserting arbitrary node ID with a universal token.

All following requests carry protocol version, `node_id`, `installation_id`, `request_id` (idempotency) and correlation fields where applicable:
- `POST /api/v1/nodes/heartbeat`: authenticated inventory/status (`online|busy|degraded`), worker/capability snapshot + timestamp. Staleness determined by center, not self claim alone.
- `POST /api/v1/nodes/assignments/poll`: bounded long-poll at authorized center for this node; returns queued assignment and `Grant` digest, Lease epoch, expiries, objective/brief (outbound polling, no center connection to DSH service).
- `POST /api/v1/nodes/events`: authenticated progress/device/session-link message. Do not accept arbitrary full success as an event. Persist deduped, visible activity/collaboration summaries not raw prompt or transcript.
- `POST /api/v1/nodes/reports`: validates ticket/assignment/lease, revoked grant fencing, idempotency, artifact byte size/hash/known origin and effect state; explicit unknown -> reconciling, not success.
- `POST /api/v1/nodes/artifacts`: body `ticket_id`,`artifact_id`,`assignment_id`,`lease_epoch`,`metadata`, base64 bytes for bounded M0 payload plus hashes. Idempotently stores Known Artifact payload, not arbitrary path content. Later direct host transport without router payload remains an extension.
- `POST /api/v1/nodes/acknowledge`: records accepted/rejected acknowledgement separate from delivered/read; cancellation and lease fencing refuse old active execution.

### Node behavior

Bare reference and DSH plugin implement the same protocol and outbound calls. They persist node identity/token and verified reports/outbox, carry request IDs across restart, implement controlled directory canonicalization/no symlinks escape, atomic effects and cancellation ledger. Never use a global working-directory guard as the sole security boundary. M0 capability permits small `read_summary` (output separate artifact) and `edit_file` (only project explicitly granted write). Node smoke harness uses no AI/LLM. A true DSH executor additionally maps existing DSH Agent/Session events to SessionRef, actual task submission and cancellation only after verifying installed sources; an unavailable verified API must be explicit limitation, not simulated DSH execution.

### Verification before M0 evidence

`cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`; `pnpm --dir apps/web typecheck` and build; plugin syntax/tests plus valid bundle resources; fresh isolated deterministic baseline: enrollment -> trust/Grant -> bounded polling -> task -> real file artifact -> duplicate report -> cancellation -> grant revocation fencing -> restart -> query. Test database and files stay under test-temp dirs. Mark real DSH host, actual iOS/Android, signed installer and Linux/Windows separately NOT RUN. No complete M1+ claim without corresponding evidence.
