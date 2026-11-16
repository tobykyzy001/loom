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

**Not verified:** live creation/resume with full DSH injection, actual session persistence across a DSH process restart, configured provider/model capability, an actual paid/free model response, cancellation against live loop, correlation between a later assignment and an already completed turn, concurrency isolation with a pre-existing busy Agent, icon/UI rendering, or actual installation. The unit tests use a mock Host to test the adapter's source-defined contract; they are not Host verification. Full-package Node version floor can be `>=22`, but the verified running Host is Node 24.

Runtime dependency is only `@deepseek-ai/schemastery`, which this exact installation exports and supplies as a shipped package. All other Host-side imports are Node builtins or repository modules. No UI package, React, bundler, install script or undeclared npm runtime dependency is required. DSH Host common packages aren't guaranteed to be installed in arbitrary runtime-path-only profiles: without `schemastery` this plugin cannot activate; do not change profiles to fix hidden imports. The bundle carries its own synchronized `src/` Node-client source files, so runtime imports never traverse outside the linked package. They are included in `files`; packed-file lists can be checked with `npm pack --dry-run --json` without installation. The shared `packages/node-client` remains the independent public implementation; its code and this vendored copy must change together or be replaced by a deliberately versioned published dependency later.

Token equality is supported by NodeIdentity ({token,access_token,node_token}) pending Rust response DTO; a universal credential isn't copied into node envelopes or public challenge. Existing Agent/Session fact isn't replaced by plugin state. Grant/capability validation remains coordinator-owned plus local fencing; the local file executor is not DSH execution.

  const recovered = await state.once('assignment', 'digest', async () => { throw new Error('should not run') })
  if (recovered.state === 'unknown') /* only reconciliation/reporting, do not start DSH again */
```

`NodeState` reconstructs unknown before a DSH-specific after-report delivery. DshDispatcher replays an already delivered artifact outbox if that separate callback was interrupted. It doesn't fabricate raw transcripts or a report.
- **Multiple DSH profiles / Worker scopes:** identity/state dirs must be distinct and only empty or explicitly isolated directories; `profile_id` is a protocol label, not authentication. No profile files are scanned or written.
- **Persistent secret handling:** an enrollment code used by development fixture is not stored. Production private keys are not in bundle code or logs. The generic server token is stored under `state_dir` mode `0600`. This is a local file store pending integration with the verified DSH Credential Store; it has not been demonstrated as host credential persistence. Do not use actual secrets in repo examples.
- Worker concurrency limit is Host-local and defaults to 1; it does not claim cross-machine scheduling authority.
- No UI is contributed because none is needed for the M0 outbound worker. Slot registration/event renderers were not fabricated.

## Unit verification without profile effects

```sh
node --test plugins/dsh-loom/test/*.test.js
node --check plugins/dsh-loom/index.js
```

Read manifest patch/locales/icon before copying anything. Use DSH **Plugins > Add plugin** only in a separate user-approved installation/verification task. The existing running profile and its `cordis.patch.yml` are not changed by these files. The final install path would be a profile-managed directory selected by Plugin Manager; it is not known from this checkout and **not claimed installed**.

## Source truth boundary

This package records Agent-to-Ticket assignment plus SessionID/sequence in its node activity, without making that mapping authoritative over user sessions. Existing non-Loom sessions are not disposed on plugin unload. Owned agents are disposed only for jobs that supplied a creation handle. Session `turn/end` defines normal completion, not user-visible copy claiming general model reliability; a response's operation/effect state still requires evidence and reconciliation.
