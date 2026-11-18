# DSH vendored ordinary ACK response-loss and recovery

This document describes the **actual `plugins/dsh-loom` Host bundle** and one focused offline SDK-backed test. It does not promote the shared `packages/node-client` replay contract into a claim about a different SDK or all Harnesses.

## Run

```sh
node tests/harness/ack-replay.mjs
# or preserve the actual report:
out=$(mktemp -d /tmp/loom-dsh-ack-recovery-XXXXXX)
LOOM_TEST_OUTPUT="$out/result.json" node tests/harness/ack-replay.mjs
```

The harness requires verified `DSH_NODE_EXECUTABLE` and `DSH_INSTALL_DIR` Desktop runtime facts. It creates a **new isolated `loom-local-fixture` Profile** and Node/project/input directories under its owned test root. It does not install into or read the current `desktop` profile or its credential store, and does not call an online/paying model. The provider is the registered zero-network `loom-stub` adapter; actual DSH Agent creation, followup, tool calls and ordinary Sessions are used.

`tests/harness/environment.mjs` optionally lets this one driver pass an absolute package `sourceOverrides['dsh-loom']` directory. The before/baseline scenario archives the prior plugin from git commit `6b3bd71` into a new owned directory and installs that real older bundle. Ordinary invocations of `installBundles` and other harness drivers have no overrides and retain their current behavior. There is no source-byte-or-module-name inference that the older behavior is already proved.

The separate fixture-only `stub-provider/ack-recovery.js` hook wraps the shared outbound coordinator client's `http.fetch`, not any Agent provider, session, tool registry or Session event log. It activates only when `LOOM_FIXTURE_ACK_RESPONSE_LOSS=hold|replay`, and restores the instance transport on disposal. It is not a production DSH plugin feature. Clock/data fields in its bounded public log are not secrets; authorization headers and private keys are not copied into it.

## What `hold` actually interrupts and proves

A first real Node HTTP ACK is allowed to reach the real Rust Concierge. The adapter reads its HTTP 200 JSON — including valid `accepted:true` and actual `acknowledged_at` — **then deliberately discards that response before the Node client can observe it**. This is an injection at the client transport boundary, not a claim of a symmetric physical network outage.

Before this repair, the vendored client bypassed the outbox for ACKs. The archived scenario proves its pre-dispatch admission can exist at the controller while the client never creates an `ack` queue entry, never invokes `loom_fixture_write`, and reaches the existing **unknown/reconciling** outcome. This does not mean a Grant was absent or an SDK task succeeded. There is no synthesized SDK terminal, file write, cancellation or Artifact to hide the lost original execution.

The repaired path preserves durable ordinary ACK intent before HTTP. A true HTTP 200 with malformed/missing timestamp is not an accepted delivery; only an actual valid receipt clears the ACK pending row. Unknown transport/5xx retains pending, never silently manufactures accepted. The first logical body's nonce is retained across process reopen/replay, while logical digest matching retains the full Node/ticket/Assignment/epoch and ordinary body fields excluding only request_id. It is not a signature or an execution authorization.

The real DshDispatcher starts the initially validated one original operation, not a replacement Agent, Assignment or pre-made terminal. The driver requires its real controlled file-tool write, then reads all three durable `ack`, `artifact`, and `report` intents. At that point, centre **Report/Artifact/Effect are all zero**, despite the real file effect and the valid first Admission. This is the mid-flight distinction between local completion and central evidence; it is not a claim that no real effect happened.

The first actual Host is stopped. A new actual Host uses the saved isolated Node enrollment and NodeState, with `LOOM_FIXTURE_ACK_RESPONSE_LOSS=replay` and no new enrollment code. The coordinator obtains the **original audited timestamp** with a genuine server `duplicate:true` ACK. Same-scope Artifact/Report then follow in causal order. The hook observes the replay HTTP rather than allowing a self-declared `duplicate` local field to substitute for a real network return.

The driver requires all of the following, not just a clean-looking task status:

- exactly **one** actual `loom_fixture_write` call, even across the real Host restart;
- exact preservation of original Assignment/lease epoch, ACK request ID, Node identity and `dsh-session-map.json`'s one Session for this Assignment;
- one original `assignment.acknowledged` audit in SQLite, with actor=`node`, real Assignment ID and `delivered_is_not_read:true` — repeated transport does not mint another admission;
- one succeeded Report, one actual Artifact and one confirmed Effect in the controller;
- byte-identical original project file and downloaded Artifact, checked independently by length and SHA-256;
- a valid coordinator audit chain, SQLite integrity, and no extra Node registration through re-enrollment.

The final proof also documents the isolated baseline as `unknown/reconciling_not_execution_success`, not a convenient "nothing happened" simplification. Pending or a duplicate receipt does not manufacture cancellation acknowledgement, Report, Artifact/Effect or another Grant.

## Current verified artifacts

- [Actual final replay result](/tmp/loom-dsh-ack-recovery-final-XEfDLI/result.json)
- [Source-bound proof manifest](/tmp/loom-dsh-ack-recovery-final-XEfDLI/manifest.json)

The final driver SHA-256 is `2bfd42b60f26cdea722b9b040d8077bccc8f95dd51b4e95be333602656656d75`, and result digest is `887f1f7b516b9312879cb30abdf9bd25973de45778f7923a977c5f94ebdc70cc`. This final driver was rerun after review required the exact tested version rather than an earlier replay whose hook only saw the initial execute. The final `ac4b958b8a1f516cdb14a0c659f0cb69391b42f2e1a8b7323c86d4631f2736b3` is the 231-byte real HTML Artifact hash, **not** a source-script hash.

Run the sibling full validation suite when changing Node transport:

```sh
pnpm --dir plugins/dsh-loom test
node tests/runner/ack-replay.mjs
node tests/runner/ack-audit-atomic.mjs
node tests/runner/cancel-before-admission.mjs
node tests/runner/grant-revocation-fence.mjs
LOOM_TEST_OUTPUT="<owned>/result.json" node tests/harness/real-lifecycle.mjs
```

## Explicit limits

This is a generic vendored-DSH **normal ordinary ACK + one initially authorized effect** recovery proof. It is not universal exactly-once execution, an arbitrary mid-tool/crash outcome guarantee, another Harness adapter, global priority, physical multiple hosts, real provider lifecycle, phone OS worker behavior, new Grant/dispatch authority, or the deferred 1 Concierge + 3 Node topology. Stop/cancel fields still use the existing direct route and qualifications; ordinary replay never promotes stop intent into an acknowledged cancelled task. The central schema remains15 and NodeState JSON remains version1.

**Do not** equate `report_or_execution_completed:false` on a duplicate ACK with the state of the separate Report that is subsequently delivered: the flag describes what this admission receipt did, not a proof that a Report cannot exist elsewhere.
