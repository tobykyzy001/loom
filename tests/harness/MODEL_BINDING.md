# Bounded model source → placement → SDK execution

`node tests/harness/real-model-binding.mjs` proves a **single, bounded fixture** path through genuine Rust Concierge and a real isolated DSH Host installation. It is not a model discovery, installation, download, arbitrary provider invoice, or production model validation.

## Chain

1. A temporary `model.json` contains only the approved five fields: `loom.model-descriptor.v1`, `fixture-local-text`, `v1`, `['text']`, `local_only:true`.
2. The **same authenticated Node/Installation/Worker** grants a precise ProjectBinding and read permission. Its explicitly enabled `model_descriptor` task reads only this bounded file through the controlled file executor, not through an Agent or LLM. The created proof contains the original document and source SHA, along with immutable task/worker/Aritfact lineage.
3. The controller registers the proof. It verifies actual immutable Artifact bytes, the source document's raw SHA separately from the proof SHA, the completed source Assignment, its scoped Grant/Binding and source Effect. Then independently authorized `place_model` Grant records the current placement.
4. A subsequently **different `model_text` Ticket** carries `loom.model-binding.v1`, derived by the center from this registered source and approved placement—not arbitrary caller-provided Grant facts. A distinct `invoke_text` Grant still must be present. Revocation, retirement, wrong Project/Node/Worker or missing placement preclude execution.
5. At each poll the controller rechecks model source, current place_model authorization and binding, exact current assignment/worker/Node/root scope, and a per-current-Worker fresh authentication-heartbeat adapter observation. `permission_granted:false` and catalog flags alone are never treated as inference authority.
6. DSH also validates all binding fields and both center-issued Grant records before preparing a model call. It then invokes only `loom-stub/loom-stub-v1` through the **verified public SDK**, observes an actual message/stream and uploads a new immutable JSON text artifact. Session evidence is attached to that new Assignment, not the descriptor reader.

Three distinct digests/entities must not be replaced:

- source_document's raw UTF-8 SHA (`source_sha256`);
- the containing proof Artifact SHA;
- The logical digest of the **original source Assignment** (`source_assignment_digest`). It is computed from the original Assignment ID plus its fixed read-only spec (`model_descriptor`, `model.json`, no-content/null). The later invocation has its own Assignment ID and objective.

The worker preserves top-level `effect.input_digest` and corresponding immutable Artifact refs. `grant.project_root` in a poll response is derived from the **matching current ProjectBinding**, not fresh permission supplied by a user. Node validation tolerates only this documented derived field and still compares all persisted Grant identity, scope, digest, operation, revocation/binding facts.

## Evidence and boundaries

The driver verifies exact source text and unchanged original file, source and invocation Assignment **differences**, scoped proof metadata, actual DSH Session and returned text. Denials of read/place substitutions, bogus placement/Node, revoked invoke and retire do not introduce a further SDK `request`. `tests/harness/real-model-text.mjs --browser` now also uses actual source/placement prerequisites and observes already-created SDK history with its Grant later revoked, without starting a second response.

This is a **bounded source-to-adapter link only**. It does not prove arbitrary SDK choices, real proprietary/open-weight model deployment, activation, free running providers, GPU inference quality, model download/lifecycle, image generation, production credential broker, remote deployment, second physical host/TLS or mobile/PWA lifecycle. No current desktop profile or ordinary Credential Store is used. The one center + three Workers Compose scenario remains explicitly deferred by user request; these tests are a singleton temporary Concierge and one isolated DSH Worker.

Additional source/registration `model_registry` tests verify tampered grants, revoked placement, retired source, mismatched project/assignment/root and missing/stale/invalid observation cannot bind. Supporting tests do not substitute for actual SDK calls and real task/session events.
