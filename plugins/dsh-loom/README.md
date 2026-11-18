# Loom local node Host bundle

Experimental, Host-only, plain ESM package for `[configured isolated test coordinator]`. This checkout is **not installed by this repository** and was not installed or activated in the running DSH profile. No plugin Manager action was performed. The directory to pass to the user/administrator for a later manual install is:

```
/Users/zj/Coding/loom/plugins/dsh-loom
```

Installation alone is not registration, a Grant, a tested unit, or activation of workers.

## Verified Host source facts used

Verified read-only with `dsh-doc` from the running Desktop **0.2.2-rc.3** inside `app.asar`, using its `$DSH_NODE_EXECUTABLE` with `ELECTRON_RUN_AS_NODE=1`. Do not substitute another version's source:

- `@deepseek-ai/dsh-agent/src/index.ts`: `ctx.agents.create({sessionId, meta, agentOptions})`, `resume({resumeSessionId})`, `get(id)`, `list()`. Create/resume return an owned handle with `agent` and optional disposal; lookup returns a bare Agent.
- `@deepseek-ai/dsh-agent/src/runtime-types.ts`: `agent.followup({role:"user", content:[{type:"text", text}], source:{kind:"loom"}})`, `cancel({kind:"user"})`, `session`, `status`, `ctx`. `whenIdle()` does not necessarily identify just one task; this implementation waits for `turn/end` instead.
- `@deepseek-ai/dsh-session/src/index.ts`: ordinary `session/event` listener arguments are `(session, event)`. It is never appended to by this bundle. There is no custom Session event type or private plugin persistence marker.
- `@deepseek-ai/dsh-session/src/types.ts`: successful turn completion is `event.data.reason.kind === "completed"`; an absent/unfinished/failure/abort is not interpreted as success. `assistant/message` content supplies actual output evidence; `Session.id` and `Session.seq` are ordinary persistent references.
- `@deepseek-ai/dsh-time-context/src/index.ts` and `@deepseek-ai/dsh-agent-instructions/src/config.ts`: `export function apply(ctx, config)`, `export const Config`, `ctx.on`/`ctx.effect` and Schemastery are the actual installed Host exports/style.
- `$DSH_INSTALL_DIR/package.json` names `@deepseek-ai/dsh`, version `0.2.2-rc.3`, Node engines `>=24.9.0`; the reported desktop Electron is `44.7.0`.

**Verified in a separate temporary fixture Profile:** outbound registration, actual public Agent/session flow, scoped tool-created file effects, a parent/child pair with a real parent Session reference, an exact zero-network text adapter invocation, cancellation acknowledgement, and ordinary session resume evidence. These used the public DSH APIs with the deterministic zero-network stub, not a paid live LLM or arbitrary production harness.

**Still not verified:** production profile install/upgrade, managed Credential Store, provider or natural-language model quality, image generation, arbitrary pre-existing busy Agent compatibility, non-loopback TLS/second machine Node lifecycle, full remote deployment, or icon/UI rendering. The unit tests complement rather than replace these real fixture proofs. Full-package Node version floor can be `>=22`, but the verified running Host is Node 24. A module declaration alone does not prove activation, installation, Grant, or support for another Host.

Runtime dependency is only `@deepseek-ai/schemastery`, which this exact installation exports and supplies as a shipped package. All other Host-side imports are Node builtins or repository modules. No UI package, React, bundler, install script or undeclared npm runtime dependency is required. DSH Host common packages aren't guaranteed to be installed in arbitrary runtime-path-only profiles: without `schemastery` this plugin cannot activate; do not change profiles to fix hidden imports. The bundle carries its own synchronized `src/` Node-client source files, so runtime imports never traverse outside the linked package. They are included in `files`; packed-file lists can be checked with `npm pack --dry-run --json` without installation. The shared `packages/node-client` remains the independent public implementation; its code and this vendored copy must change together or be replaced by a deliberately versioned published dependency later.

Token equality is supported by NodeIdentity ({token,access_token,node_token}) pending Rust response DTO; a universal credential isn't copied into node envelopes or public challenge. Existing Agent/Session fact isn't replaced by plugin state. Grant/capability validation remains coordinator-owned plus local fencing; the local file executor is not DSH execution.

  const recovered = await state.once('assignment', 'digest', async () => { throw new Error('should not run') })
  if (recovered.state === 'unknown') /* only reconciliation/reporting, do not start DSH again */
```

`NodeState` reconstructs unknown before a DSH-specific after-report delivery. DshDispatcher replays an already delivered artifact outbox if that separate callback was interrupted. It doesn't fabricate raw transcripts or a report.
- **Multiple DSH profiles / Worker scopes:** identity/state dirs must be distinct and only empty or explicitly isolated directories; `profile_id` is a protocol label, not authentication. No profile files are scanned or written.
- **Persistent secret handling:** an enrollment code used by development fixture is not stored. Production private keys are not in bundle code or logs. The generic server token is stored under `state_dir` mode `0600`. This is a local file store pending integration with the verified DSH Credential Store; it has not been demonstrated as host credential persistence. Do not use actual secrets in repo examples.
- Worker concurrency limit is Host-local and defaults to 1; it does not claim cross-machine scheduling authority.
- **Optional credential-record tasks:** production default `credential_broker_tasks=unsupported`. Only operator-selected `dsh_records` requests public `credentials` injection and live center authorization: one `credential_inspect` or `credential_revoke` operation per Grant, exact Project/Node/Installation/worker Binding and immutable matching inspection Artifact SHA. Metadata API is `describeRecord`; destructive API is `deleteRecord` only, with a second fresh authorization at that boundary. There is no secret-read/resolve/list/modify API or arbitrary Host-owner record enumeration. These permissions and an SDK `record.kind` are not execution Grants. Isolated `present → revoked → restart missing` tests and non-goals are documented in [tests/harness/CREDENTIAL_REF.md](../../tests/harness/CREDENTIAL_REF.md). Tasks and permission boundaries require an explicitly mounted provider; **real production/system credentials were not tested**.
- No UI is contributed because none is needed for the M0 outbound worker. Slot registration/event renderers were not fabricated.

## Observed model adapter catalog

With the existing explicitly enabled `model_text_tasks` fixture route only, the DSH dispatcher reports a bounded `inventory.model_catalog` through the existing node heartbeat. It uses one cached public SDK `ctx.llm` inspection per dispatcher initialization, preserves the ordinary enrolled Worker/project-root facts, and does not invoke the prepared `stream`. See [MODEL_INVENTORY.md](MODEL_INVENTORY.md) for exact fields and `node tests/model-inventory/real-dsh.mjs` for the real isolated DSH + Concierge proof. This is observed adapter metadata, not a general model registry, cross-provider discovery, inference/right-to-use model authority, or download/activation support. Default-disabled, malformed/foreign selector, missing API/model, bad modality/context or failed preparation never invent a ready model. The paid/live LLM, production Credential Store and current `desktop` profile remain untouched.

## Bounded code-proof fixture (`fixture_code_tools`)

Default remains OFF. This opt-in, test-only fixture lets a current write-Grant-backed isolated DSH Agent modify the one small `src/calc.js` example and then run only a fixed `node --test test/calc.test.js`, returning a real diff and verification Artifact. It uses a clean owned Git root, exact known replacement, immutable ToolCall/ToolResult and independently read file/Git bytes. It has no generic shell, dynamic editor, arbitrary scripts, model/provider promotion, automatic rollback, or unvalidated write permission. Editor errors remain unknown/reconciled while real completed test failures preserve confirmed file effects as failed Reports. Fresh scoped Agent identity is required per code Assignment; code-session reuse is not supported, but completed Ticket reopen/report recovery remains ordinary. See [CODE_TASK.md](../../tests/harness/CODE_TASK.md) for the exact demo, boundaries and actual reproduction commands. This is not a stock code-editor or a full M0 certification.

## Unit verification without profile effects

```sh
node --test plugins/dsh-loom/test/*.test.js
node --check plugins/dsh-loom/index.js
```

Read manifest patch/locales/icon before copying anything. Use DSH **Plugins > Add plugin** only in a separate user-approved installation/verification task. The existing running profile and its `cordis.patch.yml` are not changed by these files. The final install path would be a profile-managed directory selected by Plugin Manager; it is not known from this checkout and **not claimed installed**.

## Source truth boundary

This package records Agent-to-Ticket assignment plus SessionID/sequence in its node activity, without making that mapping authoritative over user sessions. Existing non-Loom sessions are not disposed on plugin unload. Owned agents are disposed only for jobs that supplied a creation handle. Session `turn/end` defines normal completion, not user-visible copy claiming general model reliability; a response's operation/effect state still requires evidence and reconciliation.
