# Scoped model text invocation — verified with a real DSH SDK

The repository now proves **one narrow provider/model text invocation** through actual DSH public APIs. It is not a broad Model Registry, not an activation/downloading mechanism, not a real paid LLM invocation and not image-generation approval.

## What is actually implemented

- `kind: model_text` has its own operation **invoke_text**, explicitly accepted when creating Grants. `read`, `write` and `read_write` do not include this permission. Existing file-operation Grants remain separate from this invocation authorization.
- For this narrowly proven scenario, `provider: loom-stub` and `model: loom-stub-v1` are explicitly selected. Arbitrary provider/model selection is refused, not redirected to another billing/provider route or filled in from local GPU hardware. The ordinary deterministic local destination `not-a-file-operation` is a marker rather than a model/file authorization substitute.
- The original ticket carries a versioned immutable `loom.model-text.v1` content document with the goal, provider and model. It is attached to the same Grant / Node Binding / Assignment / Lease chain. A poll reads it again and verifies the exact fields rather than assuming a provider/model from a filename or a metadata payload supplied later by the model.
- DSH currently integrates with `ctx.llm` in actual code. `model_text_tasks` defaults **false**. Opting in requires the normal plugin enabled / worker permission / explicit Agent creation / exact provider/model configuration **and** the separate `invoke_text` Grant. Missing any of these, an unknown Node, unsupported model, no public LlmAdapter, an unexpected artifact_input or absent text modality prevents creating a new Agent and causing a provider call. Unmounted interfaces are errors, not fabricated live-model capabilities.
- Model observation uses the current DSH 0.2.2-rc.3 public runtime: `ctx.llm.listProviders`, `listModels`, `resolveModelInfo` and **`prepareCall({provider,model})`**. The latter takes an object and returns a frozen prepared configuration plus a stream, not a two-positional-argument return shaped like the adapter-internal call.
- The prepared call is not itself run by policy inspection. The text is returned from a real ordinary `ctx.agents.create/get/resume`, Agent `followup`, public LlmAdapter stream and actual `assistant/message` / `turn/end`. The real harness proves the exact model call preparation and returned `assistant/message` by its fixture control log and DSH Session events, not a fabricated response field substituted afterward.
- The result has a separate `loom.model-ref.v1`: provider/model, text modality, `host_reported` origin, `not_live_llm: true` for the stub, current `invoke_text` grant ID and an actual output artifact SHA-256. The **derived Artifact's own bytes and hash** are compared with the HTTP artifact retrieval after the response; parent's SHA is not inherited as output identity. “execution_observed” requires an actual nonempty text response, not just catalog registration.

## Exact validation command

```sh
node tests/harness/real-model-text.mjs
```

The isolated Profile and Rust fixture operate on synthetic directories. No real user project, current desktop Profile, personal Credential Store or model provider account was read or mutated. No network live model was invoked.

## What actually passed

Read grant alone and write grant alone were both refused at task creation with `operation_scope`, before any Agent call. The exact `invoke_text` Grant on the precise Worker/ProjectBinding and explicit fixture was allowed to create a real task and return a nonempty text Artifact. Other provider/model paths were rejected.

Verified reference run:

| Fact | Reference result |
| --- | --- |
| Status | `overall: PASS`, exit 0 |
| Ticket | `tkt_dd526b9b43c24b6ea9c08766fd3ea001` |
| Assignment | `asg_54ae2b1f4f2e4407bf6325ff1afa33b3` |
| Result Artifact | `f10d2288-cc24-4a4c-9781-78d3ec65a6ff` |
| Actual output SHA-256 | `9ef8bed5d379a3b5383944259b0f3aac37efb87d93a0d6f7858473f8caa02e6c` |
| Actual child DSH Session | `5b4303d6-f556-42f4-ae1b-fe67d961c185` |
| Provider / model | `loom-stub` / `loom-stub-v1` |
| Operation / mode | `invoke_text`, zero network deterministic stub |
| Real Project file effects | none (`effects: []`) |
| After host restart | same session and bytes, no new invocation |

The harness independently retrieves the stored result bytes and verifies the hash. It reads the actual agent messages and ordinary session/log evidence. Unit tests separately cover default-off, wrong read/write grant, wrong selector/node, absent public provider functions, image-vs-text confusion and prepared-call shape. They do not replace the real SDK proof.

## Deliberate limitations / NOT RUN

- Natural-language model usefulness/quality, real provider inference, billing/credentials and cross-provider portability are not proven.
- Current model installation, weights download, model Registry placement/lifecycle, public general inference registry and verified activation/deactivation are not delivered.
- GPU detected on this one physical macOS does not infer a usable model, encoder, image generator or placement grant.
- Nothing in this text invocation permits arbitrary file operations, side effects disguised as tool output, image generation or unvalidated source handoff. Bare and other hosts without this public model implementation remain unsupported for this task type.
- Physical second hosts, other Harness APIs, direct file transport and OS/desktop credential integration remain separately unverified.

The correct `/models` status at present is **full registry/verified placement and general activation not implemented**, not that no real invocation ever occurred. This limited, well-identified testing capability must not be silently expanded to that larger platform claim.
