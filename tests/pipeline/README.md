# Bounded document workflow: actual integration

This is **a verified bounded two-operation document workflow**, not a claim of generic M3/M4 industry Pipeline acceptance or a physical multi-machine deployment.

## What is implemented

- Authenticated **POST /api/v1/pipelines** followed by `GET /pipelines/{id}`, `GET /pipelines`, `POST /pipelines/{id}/run`, and `POST /pipelines/{id}/cancel`.
- Exactly two stored stages using `loom.document-pipeline.v1`: an upstream `read_summary` of `docs/<relative path>`, then `edit_file` with `trim`, `collapse_whitespace`, `uppercase`, or `lowercase`.
- Each phase selects an independent **existing raw Grant** and its **current** ProjectBinding. `grant.digest` and `binding.digest` are deliberately distinct semantics, not interchangeable hashes. Check node/install/worker/project/operations and scope before any new Ticket.
- Additive SQLite v4 stores immutable run definitions, mapping of stage to actual raw grant and ticket, and cancellation intent. Real Tickets/Reports/Artifacts keep their ordinary authority; these pointers do not create an alternative task authority.
- Real parent Artifact bytes must exist and match its index before a later stage is created. The derived Assignment carries a bounded validated `artifact_input` with SHA-256, original origin, ticket and base64 bytes. Local Node independently validates byte hash and parent relationship. Its new output metadata takes the source relation, computed fresh from real output bytes; it never inherits stale hashes or generic metadata as permissions.
- Unfinished/unknown/cancelled stages do not advance. Grant revocation/old state cannot be silently replaced by a new location. Exact Task replay does not reproduce the same ticket or file effect. Unexpected transforms, traversal and invalid dependency are denied before any Ticket is created. DSH/Bare adapters that lack this shared input validation reject the input rather than silently drop provenance.

## Cancellation of a received child and terminal aggregate

The same command now also proves a distinct second Pipeline whose parent already succeeded. The writer's real `client.poll({waitSeconds:0})` delivers its child Assignment, but does not create/admit or execute a file. Calling `/pipelines/{id}/cancel` correctly gives `cancel_requested` first. When the real worker observes it, `pollAndRun()` reports `cancel_acknowledged` and one confirmed stopped Report is accepted — **no ordinary source-artifact admission**, no child Artifact or Effect, and no `docs/stop-before-writer.txt`.

Before this fix, that legitimate mixed view (`source=succeeded`, `child=cancelled`) could never escape **cancel_requested**, including after a restart, because the aggregate queue only classified `all(state=cancelled)` as stopped even with the parent having already completed useful work. It was a false ongoing status, not unknown work to roll back. The aggregate is now `cancelled` only in the cancelling branch when every stage is either completed or cancelled. Unknown/reconciling remains distinct; a failed or merely pending/unacknowledged state must not be converted into a falsely clean cancellation.

The actual negative control posts the worker's ordinary acknowledgement after its accepted stopped result, **409 `outcome_unknown`**, with no new execution admission or effect. A second cancel, an identical-definition create replay and both `/run` invocations preserve stage mappings, the one `pipeline.cancel_requested` audit, both Grant IDs/digests/versions, the original source-content and source-artifact SHAs, and no more child Work. After the actual Concierge restart and worker idle polls, overall/stage statuses stay `cancelled`, the original 2 Assignments and 2 Reports plus the sole parent Artifact remain, and `audit/verify` is valid. All earlier successful parent-child lineage and retry negative cases are unchanged.

This is terminal-state + genuine child-acknowledgment verification on the same one-host bounded workflow, not a claim that all pending Source Specs or tool crash outcomes are known/clean, or that a second physical Host/Compose topology, global exactly-once or arbitrary DAG now works.

The adjacent direct-offer fixture also required sequencing, not a weakened producer gate: its earlier edit Assignment still owed a stop frame, and the centre legitimately prioritizes that outstanding stop frame over the next job. Calling `pollAndRun()` yields `cancel_acknowledged` first; only then can the next separate running edit child be issued a DirectOffer and then have the source Grant revoked. Both child ID and current `pipeline.stages[].ticket_id` must match, while the cancelled prior Ticket is preserved and unacknowledged by execution. `node tests/direct/loopback-handoff.mjs` consequently passes all its original byte-integrity, signature, cancellation and revocation checks without manufacturing a replacement active Ticket.

## Real validation

Run from the repository root:

```sh
node scripts/document-pipeline.mjs
```

Observed result of the final maintained version: **PASS, exit 0**, including:

1. Two independent local Ed25519 Node identities, Worker roots, read/write permissions and actual ProjectBindings.
2. A real `read_summary` artifact from the source, followed by a *new actual artifact and file written by an ordinary Node executing `edit_file`* with a regular Assignment/Lease.
3. Validated source UUID, origin, source ticket and immutable lineage including `component_sha256`. Actual on-disk text is whitespace-reduced by the specified transform, not copied from a synthetic expected output constant.
4. Wrong write/operation scopes, traversal, unsupported transforms and non-parent dependencies being rejected.
5. The same run and repeated polls produce no second write or child Assignment (the derived file's inode remains unchanged).
6. The center is stopped and reopened. Node and admin transports rebuild against the current dynamic URL **without** issuing a new enrollment or mixing the admin token with a Node token. Existing saved state and `audit_valid` remain available; `doctor` confirms current additive schema v15 and SQLite integrity. v15 retains this v4 two-stage graph and the schema14 code-evidence fields; its bounded Ticket priority defaults to 0 for these Source/Pipeline tasks and does not become part of their operation/digest or grant authority.

Evidence produced on the successful reference run:

- Source Artifact UUID `905f6ac9-bf8e-4ba2-9e84-0625bfffbed7`.
- Derived Artifact UUID `2c3f3618-bd2a-4163-bbca-1c92e3f72d55`.
- Derived content SHA-256 `7fdb80feec9d72e7514663d9275d1556d3013c96e8b14d95ff469de625f79847`.
- Pipeline UUID `410709b2-15d1-44de-a824-aa605ffa45cb`.

IDs are for that test run only and will change on the next fixture. Do not treat them as production references.

## Limits / NOT RUN

This is one macOS host with two isolated logical validation Workers and different root directories. It is **not** a physical second host, Compose/docker topology, direct host-to-host large file transfer, trusted remote/TLS deployment, or general LLM DAG. No real model, paid request, untrusted network, active DSH Profile, user credentials, another machine or real mobile device was involved.

The service currently implements the narrow read→text-transform→write document kind. It is not an image-generation tool and does not assume a model/GPU or a broad pipeline/Registry ecosystem. A generic DAG registry/model lifecycle and independently certified additional Harness integrations remain to be separately validated. Bare/DSH-specific general file tools are not generalized by this conversion.
