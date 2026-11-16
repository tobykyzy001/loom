# Implementation status

Updated: 2026-11-17.

## Last completed buildable increments

1. `aabcbfb` — language-neutral Node Envelope, project-aware Grant/Lease domain rules and signed JSON fixtures.
2. `545c1be` — authenticated SQLite/HTTP coordinator, Vue evidence UI, TypeScript node and DSH Host bundle, resource bindings, immutable artifact index, deterministic benchmark.
3. `ba57e36` — exclude local dependency links from distribution.
4. `f047e8b` — real Rust HTTP ↔ TypeScript Node actual file execution, Report replay deduping, failure/cancellation evidence, persistent cancellation acknowledgement.
5. `9eff2f6` — actual implementation/test entry points and documented remaining host gaps.
6. `514809c` — verified bare Rust Local Node with signed ownership bindings and the process-level `scripts/bare-integration.mjs` real read/edit/cancel/restart test.
7. `c24e0dd` — native effect recovery, cancellation fencing and real Bare process output evidence.
8. `92f05fd` and `565a35d` — versioned resource observations, bounded probes, placement reasoning and typed Fleet facts.
9. `e1da1f0` — actual isolated DSH install/register/tool-task/abort/resume, with one in-flight Report producer and explicit stop intent vs actual cancelled evidence.
10. `174ad01` — immutable, source-linked Artifact lineage, placement-scope checks, current-binary test hygiene and real same-host two-worker handoff.
11. `cc65c35` — actual native Web assets and usable desktop/390-viewport workspace, with the App conditional-branch correction.
12. `a0b32b3` — bounded DSH public-tool semantic HTML file, genuine external Effect/SessionRef and zero-live-model verification.
13. `aacdf34` — bounded, versioned document-DAG protocol validation (not a claim of an executed industry DAG).
14. `2126038` — real bounded two-stage document execution, immutable parent input, v4 run/stage projection and restart validation.
15. `0f3ec88` — actual parent/child Agent delegation with source/current-Lease proof, center-refused forged references, immutable child lineage and filtered collaboration evidence.

Local commits are not pushed unless separately reported.

## What has actually been demonstrated

- **22 protocol tests** with `cargo test -p loom-protocol --features fixture-signing`: shared Rust wire types, Ed25519 identity, grant/lease/attempt gating, report/effect invariants.
- **Rust deterministic smoke**: authentic registration challenge, explicit projectResourceBinding and Grant, bounded long-poll, artifact digest/lineage verification, immutable ID replacement rejection, exactly repeated report idempotency, cancellation/fencing, restart, unknown-outcome retry barrier, hash-chain audit verification.
- **Real foreground Rust ↔ TypeScript integration** with actual local fixture input and a standalone foreground child process. It demonstrates ordinary reads create content-derived Artifact JSON, file write has actual on-disk bytes, genuine read failure is failed without artifacts, cancellation is acknowledged with no file effect, duplicate reports do not duplicate evidence, collisions cannot replace old bytes, and client credentials cannot be sent as Node credentials.
- **Vue client**: 24 tests plus typecheck and Vite production build, including exact root binding, no implicit Node selection, worker default, Grant semantics, explicit user Memory scope, artifact parsing, cancellation transitional state and confirmation errors. Actual standalone desktop Chromium E2E passes current read/write/grant/cancel evidence and narrow viewport checks; no physical phone, lock-screen, network-switch or accessibility validation.
- **Node client**: 8 tests; persistent key, signed registration, scoped executor, replay and restart unknown conversion, per-node state isolation, plus immutable descendant-input hashing/tamper rejection.
- **Bounded document flow**: real `read_summary → text transform → edit_file` on two isolated workers with actual Artifacts, raw grants and canonical lineage. API is limited to four text transforms under `docs/` plus definition/run history, polling advancement and cancellation intent (v4). Its live test includes wrong-scope denial, idempotent re-poll, and center reopen with schema/audit/data validation. It is not a general industry DAG, model lifecycle, physical cross-machine relay or certified other-Harness conversion. Validation and limits are in [tests/pipeline/README.md](../tests/pipeline/README.md).
- **Bare Rust Host Agent**: 15 security/lifecycle tests plus real native process read/write/bind/restart. Unvalidated ArtifactInput is rejected before effect metadata/write. Atomic-file cancellation racing that cannot prove delivery stays `reconciling/unknown` and preserves private effect evidence; it cannot be reported as an automatic rollback or exactly-once delivery.
- **Bounded parent/child Agent delegation**: an actual isolated DSH parent creates an immutable source with its own Session; a separate child Session has the real `parentSession`, gets exact current-Assignment source proof, and emits a scoped ToolResult/new HTML with canonical artifact lineage. Source hash/origin/ticket/lease and forged relation rejects are actually exercised; parent/child source and generic Session references are not permissions. Ordinary recovery keeps the same child Session/file without duplicate effects. Filtered per-ticket messages expose the center-verified relation for the optional collaboration view. Evidence/limits: [tests/harness/DELEGATION.md](../tests/harness/DELEGATION.md). Production default remains `unsupported`, and the demonstrated tool is test-only.
- **DSH plugin and isolated actual Host**: 15 plugin regressions plus actual parent/child delegation, in a separate temporary `DSH_HOME/HOME` fixture. In a separate temporary `DSH_HOME/HOME` fixture the plugin was actually installed, activated, outbound registered; actual Agent followup, controlled tool use, ordinary session evidence and an accepted immutable Artifact were demonstrated. Actual **cancelled aborted turn** and **same-Session restart/resume** plus a **bounded semantic HTML file effect** PASS, alongside 12 plugin regressions and commits `e1da1f0` / `a0b32b3`. This is a real in-process zero-network Stub exercising real DSH APIs, not a billed live model or quality validation. It still does not claim arbitrary DSH Agent programming, subagent collaboration, current-profile credential integration, mobile, multi-Harness or platform packaging. The proven file effect uses the explicitly registered bounded `loom_fixture_write` test tool; generic tool/provider effects are not read or inferred.

## Not yet accepted by evidence

- Complete M0 acceptance. M0 explicitly needs a real DSH Host task/cancel/failure/session reopen, meaningful programming task via an Agent (not just deterministic file helpers), subagent collaboration links, actual iOS/Android browser/lockscreen/renewal and sensitive-process review. Current deterministic file chain is a core transport/storage boundary, not the entire M0 product.
- Native **bare** host paths have been locally demonstrated, but not signed, installed or verified as background services on macOS/Linux/Windows. This is distinct from DSH Host plugin acceptance.
- M1/M2+ full platform/image/general fleet/model scheduling capability remains incomplete. A real same-host pair of independent local Nodes demonstrates controller-mediated Artifact handoff with independent identities/root Grants, node liveness/offline, revocation, immutable lineage and replay rejection; this is **not** a physical second machine, Host-direct transfer or general DAG. Signable platform rollouts/rollback, general Pipeline/model lifecycle, other Harnesses, Tauri, learning candidates/verified Skills and independently certified Adapter ecosystems remain incomplete. Prototypes for model/pipeline/habit registration have been deliberately removed as misleading self-approved execution, not presented as supported capabilities.
- Actual non-loopback TLS/trusted remote network, OS credential store integration, platform signing/installation, cross-device role separation, true second Node lifecycle and real model/provider tests. The reference HTTP server binds loopback only for this development baseline.

## Next evidence-driven increments

1. Preserve the verified bare-node scope as a deterministic reference, improving unknown/effect reconciliation and platform packaging without claiming platform support from compilation alone.
2. A real isolated-DSH parent/child source delegation with a fixed scoped tool has direct evidence. Further Agent cases and additional Harnesses need separate, actual proofs; do not generalize this special fixture. Installer, Credential Store and profile portability also remain unverified. Local identity files are not system credentials.
3. Expand actual inspector inventory and project mapping beyond root snapshots; distinguish explicitly declared, host-reported, controller-probed, stale/unavailable and denied resources. Do not claim GPU/local imaging support without genuine probes.
4. Add real Browser/PWA evidence only if a supported browser harness/device is available. Do not use generated screenshots or invented devices to fulfill the mobile criterion.
5. Implement subsequent milestones with the same Ticket/Grant/Assignment/Lease/Effect/Artifact contract, not a replacement reporting channel.

See `BASELINE.md`, `MEMORY.md` and current commit diffs for exact commands and integration known issues. test results must be derived by the real commands, not copied as evidence into each future milestone.
