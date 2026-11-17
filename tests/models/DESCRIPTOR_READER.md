# Small descriptor artifact reader

This is a metadata-only proof path, **not model execution or a model installation lifecycle**. It deliberately does not reuse the existing `edit_file` replacement-effect artifact or `read_summary` output as the model descriptor body. `LocalNodeRunner` requires a real `model_descriptor` assignment, its original read Grant and same project/node/Worker binding.

The new executor branch is present at:

- [`packages/node-client/src/executor.js`](../../packages/node-client/src/executor.js) — shared pure-JS worker.
- [`plugins/dsh-loom/src/executor.js`](../../plugins/dsh-loom/src/executor.js) — vendored local dispatcher (the DSH Agent adapter has no new file scope).
- The equal `model-descriptor.js` helpers are byte-for-byte synchronized; the executors have intentional role-specific differences outside that helper. The plugin's file source tree and common independent `packages/node-client` tree are not byte-for-byte identical.

## Inputs and authorization

- Ticket kind: `model_descriptor`; `read` Grant (not `invoke_text`, `place_model` or `write` alone).
- Authorized real source path is exactly `<granted-project>/model.json`; no directory walk and no absolute/different path or content-supplied model registration. The server requires the same named path/capability/binding.
- Source is a regular (non-symbolic-link, single-link) file, <=8192 bytes. The executor opens it normally, reads the raw bytes and rechecks the resolved root/file after reading. It has no streaming model call, subprocess, private DSH API, network provider lookup or inferred model weights.
- Exact five input keys only: `schema:"loom.model-descriptor.v1"`, `provider:"fixture-local-text"`, `revision:"v1"`, `input_modalities:["text"]`, `local_only:true`. Duplicate members, extra properties, corrected-but-nonlocal states, `v0`, different provider, multimodal types and malformed UTF-8 are rejected rather than upgraded through `JSON.parse` last-write-wins behavior.

## Two distinct hashes

The returned proof artifact is a small JSON object with the original five fields plus:

| Field | Fact |
| --- | --- |
| `relative_path` | Constant `model.json` rather than an arbitrary host absolute location. |
| `source_kind` | Constant `explicit_local_artifact_descriptor`; not an inference grant. |
| `source_document` | Original strict source JSON text; the provider did not generate a model, code or weights. |
| `source_sha256` | SHA-256 computed from the **original raw source file bytes** (Buffer-equivalent to UTF-8 encoding of that source string). |

This proof has its **own different artifact digest** calculated from the serialized proof bytes as ordinary Loom artifact metadata. It is not the source hash. A Registry reader may validate the exact original five-value schema and compute `sha256(source_document as UTF8) == source_sha256`, then separately verify the immutable wrapper `ArtifactRef.sha256`—which can never be the hash of the raw input for this structured proof. Nothing in the proof establishes an install, activation, runtime, permission Grant, release artifact download or general provider support.

## Actual verification

```sh
node --test packages/node-client/test/*.test.js
node tests/models/produce-descriptor.mjs
```

The driver uses an actual Rust Concierge and actual shared TypeScript `LocalNodeRunner`, with a temporary project, real enrollment/Grant/Lease, then one artifact upload and report. It rejects arbitrary paths/write-supplied input and wrong `invoke_text`/`place_model` Grants at ticket creation. It compares the exact new JSON source/proof bytes and both hashes, and confirms the original model.json was not changed. No DSH Agent/Session/model process is needed. Successful proof output is `<temporary-test-root>/produce-descriptor-result.json`; model generation and **new Rust bare descriptor execution** are NOT RUN/not claimed.

`tests/models/local-descriptor.mjs` is the Registry owner's adjacent driver, not a reason to alter the strict proof to elder `edit_file` output. Any compile/backend or stale-seven-field assertion remains a separate reportable problem rather than something to hide by treating an effect result as a model body.
