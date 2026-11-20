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

The driver verifies exact source text and unchanged original file, source and invocation Assignment **differences**, scoped proof metadata, actual DSH Session and returned text. Denials of read/place substitutions, bogus placement/Node, revoked invoke and retire do not introduce a further SDK `request`.

The driver now additionally proves **one exact Worker going offline stops a fresh model ticket** *before* the retire case: the real authenticated Node identity retains the complete current catalog and Installation, reports only the selected `default` Worker as `offline` while its Node remains online. The catalogue preserves the historical source/prepared timestamp but becomes `worker_offline`, `resource_state=unavailable` and `stale`. `matching_physical_node` must use the actual requested Worker (the previously ignored `_worker` parameter), excluding that exact offline Worker rather than substituting another declared online Worker. Creation of model_text then returns **403 `source_node_unavailable`**, while its placement, source Artifact, original invoke Grant and headset/model reports remain unchanged and SDK request count does not grow. The original catalog is restored, then the existing retire rejection remains independent rather than being used as a shortcut label for Worker offline. Rust's P2 fixture independently asserts first valid binding→exact physical Worker becomes unmatched→catalog is history-only→new binding is refused, preserving full tickets/artifacts/grants/placements/audits.

`node tests/model-inventory/browser.mjs` opens the production Vue in isolated Edge, first accepts the valid source projection, then changes only that same registered Node's Worker status. The user-activated resource refresh shows `Worker离线·保留历史记录` and current unavailable/stale, never an invocation/download/activation control, with no new ticket or Grant. It also records desktop and 390px worker-offline screenshots; these are not physical mobile scenarios. Frontend parsing intentionally rejects a contradictory `worker_offline` payload that claims its model is nevertheless `fresh`/`adapter_observed`.

This is a stricter availability check in `create_ticket` as well as the later poll; it is not a fresh probe or an automatic SDK/model/generation execution. Actual global `fresh_observation` requirements and sources are shared with that same invocation code path. `tests/harness/real-model-text.mjs --browser` now also uses actual source/placement prerequisites and observes already-created SDK history with its Grant later revoked, without starting a second response.

This is a **bounded source-to-adapter link only**. It does not prove arbitrary SDK choices, real proprietary/open-weight model deployment, activation, free running providers, GPU inference quality, model download/lifecycle, image generation, production credential broker, remote deployment, second physical host/TLS or mobile/PWA lifecycle. No current desktop profile or ordinary Credential Store is used. The one center + three Workers Compose scenario remains explicitly deferred by user request; these tests are a singleton temporary Concierge and one isolated DSH Worker.

Additional source/registration `model_registry` tests verify tampered grants, revoked placement, retired source, mismatched project/assignment/root and missing/stale/invalid observation cannot bind. Supporting tests do not substitute for actual SDK calls and real task/session events.
