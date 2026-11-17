# Local model descriptor evidence

This small backend slice binds a **real, bounded local `model.json` file** to a model metadata registration. It is not a model loader, model installer, general Model Registry, model service or invocation provider. No UI or desktop/DSH profile mutation is part of this path.

## Evidence chain

1. The explicit temporary project is registered. A separate authenticated Node with its real scoped Worker/ProjectBinding receives a **normal `read` Grant** for the target file. `place_model` does not imply file access; `read`, `write` and `invoke_text` do not imply a placement grant.
2. The current TypeScript LocalNode handles `kind: model_descriptor`, reads only `model.json` and enforces at most 8 KiB, regular/non-symlink content and exactly five source keys: `schema`, `provider`, `revision`, `input_modalities`, `local_only`. Only `loom.model-descriptor.v1`, `fixture-local-text`, `v1`, `['text']`, `true` are accepted. No weights, remote URLs, credentials, images or other file paths are interpreted.
3. Its real Task/Report creates a bounded JSON proof Artifact containing those five keys, `source_kind`, exact `relative_path`, `source_sha256` and `source_document`. `source_sha256` is the actual input file byte SHA. The proof Artifact has its own different SHA. It is not a generic summary or a raw file pathname substitute. Bare's ordinary `edit_file` effect wrapper is not considered this proof kind.
4. Registration checks actual Artifact storage, the Artifact index SHA, the caller's reviewed SHA, the proof shape and literal original document. Server-computed `sha256(source_document UTF-8 bytes) == source_sha256` and the outer five metadata fields equal the original five. No raw project path, input endpoint or credentials enter a registry DTO.

## Recognized APIs

Current admin-authenticated controller APIs, not public anonymous APIs:

- `POST /api/v1/models`: `{schema:'loom.model-registry.v1',source_ticket_id,source_artifact_id,worker_id,reviewed_sha256}`. Also validates the original current `read` Grant/Binding and completed `model_descriptor` Task/Assignment. Repeat registration with the same evidence/scope is idempotent but does not skip these checks. Model rows are **`registered`, not installed/activated**.
- `GET /api/v1/models`, `GET /api/v1/models/{id}`: fixed metadata, source Ticket/Artifact UUIDs/hash/scope and authorization history. `descriptor` is an object, not a serialized JSON string. An absent legacy row's fields do not turn into certified source evidence.
- `POST /api/v1/models/{id}/placement-approvals`: `{grant_id,worker_id,node_id,installation_id,reviewed_sha256}` requires an exact current **place_model** Grant, matching current Node/Installation/Worker/ProjectBinding and the registered immutable hash. Read/write/invoke_text do not substitute for it.
- `POST /api/v1/models/{id}/place`: requires that persisted approval and current Grant. Receipt is `approved_for_placement` (批准放置授权，未运行), never a running service, Assignment/Ticket, loaded Artifact or inference event. Same model+grant+binding+digest returns the existing receipt, not a duplicate database row/audit.
- `POST /api/v1/models/{id}/retire`: exact reviewed SHA marks history `retired`; no new approval/place is allowed. It does not delete the original file/Artifact/Grant or claim a rollback or inverse task.

SQLite v10 adds nullable original source `assignment_digest` and `source_assignment_id` alongside the v9 metadata/placement authorizations. They correspond to the immutable **logical source Assignment** and its canonical no-content spec digest, not the raw file hash or invocation Task/Assignment. New placement receipts retain Grant/Binding identity. Earlier prototype tables and v3/v6/v7/v8 records remain, with no existing Grant, Ticket, Artifact or audit replacement. `current` is evaluated from the live Grant, binding and model status without destroying historical approvals.

## Validation

```sh
# Genuine Node-created source artifact; token/settings stay in temp state.
node tests/models/produce-descriptor.mjs

# Genuine source → metadata register → distinct place authorization → revoke/retire/reopen.
node tests/models/local-descriptor.mjs

# Full compatibility, migrations and all-target lint.
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
pnpm --dir packages/node-client test
pnpm --dir plugins/dsh-loom test
```

The default source-registration checks do not install packages/credentials, contact model providers, discover arbitrary files, invoke a paid LLM, generate images or activate GPU resources. Success means only the byte-backed descriptor evidence and the separate revocable metadata permission behaved as claimed. `status='registered'` and `approved_for_placement` are explicitly not `installed`, `loaded`, `active`, `running` or `generation_observed`.

A separate, genuinely executed **bounded** link now exists for this fixed source provider and exact SDK adapter: [tests/harness/MODEL_BINDING.md](../harness/MODEL_BINDING.md) (`node tests/harness/real-model-binding.mjs`). Only after the same current Worker has byte-backed registration, a distinct current place_model Grant/approval, an independently granted invoke_text operation, matching root/identity and a fresh scoped adapter observation can it issue the new text Ticket. That driver actually obtains DSH/SDK output and Session evidence, not merely a registered catalog flag; source and invocation Assignments remain different and the logical source Assignment digest is not a file SHA. `place_model`, reading, `catalogued`, registering, placing, direct invocation and generation remain different facts and permissions.
