# Implementation status

Updated: 2026-11-17.

## Last completed buildable increments

1. `aabcbfb` — language-neutral Node Envelope, project-aware Grant/Lease domain rules and signed JSON fixtures.
2. `545c1be` — authenticated SQLite/HTTP coordinator, Vue evidence UI, TypeScript node and DSH Host bundle, resource bindings, immutable artifact index, deterministic benchmark.
3. `ba57e36` — exclude local dependency links from distribution.
4. `f047e8b` — real Rust HTTP ↔ TypeScript Node actual file execution, Report replay deduping, failure/cancellation evidence, persistent cancellation acknowledgement.
5. `9eff2f6` — actual implementation/test entry points and documented remaining host gaps.
6. `514809c` — verified bare Rust Local Node with signed ownership bindings and the process-level `scripts/bare-integration.mjs` real read/edit/cancel/restart test.

Local commits are not pushed unless separately reported.

## What has actually been demonstrated

- **22 protocol tests** with `cargo test -p loom-protocol --features fixture-signing`: shared Rust wire types, Ed25519 identity, grant/lease/attempt gating, report/effect invariants.
- **Rust deterministic smoke**: authentic registration challenge, explicit projectResourceBinding and Grant, bounded long-poll, artifact digest/lineage verification, immutable ID replacement rejection, exactly repeated report idempotency, cancellation/fencing, restart, unknown-outcome retry barrier, hash-chain audit verification.
- **Real foreground Rust ↔ TypeScript integration** with actual local fixture input and a standalone foreground child process. It demonstrates ordinary reads create content-derived Artifact JSON, file write has actual on-disk bytes, genuine read failure is failed without artifacts, cancellation is acknowledged with no file effect, duplicate reports do not duplicate evidence, collisions cannot replace old bytes, and client credentials cannot be sent as Node credentials.
- **Vue client**: 21 tests plus typecheck and Vite production build, including exact root binding, no implicit Node selection, worker default, Grant semantics, explicit user Memory scope, artifact parsing, cancellation transitional state and confirmation errors. No real-browser/mobile device test.
- **Node client**: 7 tests; persistent key, signed registration, scoped directory executor, replay and restart unknown conversion, plus isolation of initial per-node state.
- **Bare Rust Host Agent**: 14 security/lifecycle tests plus real native process read/write/bind/restart. Atomic-file cancellation racing that cannot prove delivery stays `reconciling/unknown` and preserves private effect evidence; it cannot be reported as an automatic rollback or exactly-once delivery.
- **DSH plugin**: 5 tests; bundle resources/defaults, DSH-API adapter contract, failure cancellation and local transport. Disabled activation/import in installed DSH Schemastery was checked. It has **not** been installed or activated in the user's real profile here.

## Not yet accepted by evidence

- Complete M0 acceptance. M0 explicitly needs a real DSH Host task/cancel/failure/session reopen, meaningful programming task via an Agent (not just deterministic file helpers), subagent collaboration links, actual iOS/Android browser/lockscreen/renewal and sensitive-process review. Current deterministic file chain is a core transport/storage boundary, not the entire M0 product.
- Native **bare** host paths have been locally demonstrated, but not signed, installed or verified as background services on macOS/Linux/Windows. This is distinct from DSH Host plugin acceptance.
- M1/M2+ full fleet capabilities, actual secondary-host scheduling, cross-machine direct transfer, signable platform rollouts/rollback, general Pipeline/model lifecycle, other harnesses, Tauri, learning candidates/verified Skills, platform schema ecosystems and independently implemented Adapter certification. Prototypes for model/pipeline/habit registration have been deliberately removed as misleading self-approved execution, not presented as supported capabilities.
- Actual non-loopback TLS/trusted remote network, OS credential store integration, platform signing/installation, cross-device role separation, true second Node lifecycle and real model/provider tests. The reference HTTP server binds loopback only for this development baseline.

## Next evidence-driven increments

1. Preserve the verified bare-node scope as a deterministic reference, improving unknown/effect reconciliation and platform packaging without claiming platform support from compilation alone.
2. Create an isolated DSH fixture profile by an explicitly user-approved separate verification task and perform real plugin installation/registration/task/cancel/reopen. Keep Credential Store and actual profile secrets distinct and never commit the fixture key. Local files are not system credentials.
3. Expand actual inspector inventory and project mapping beyond root snapshots; distinguish explicitly declared, host-reported, controller-probed, stale/unavailable and denied resources. Do not claim GPU/local imaging support without genuine probes.
4. Add real Browser/PWA evidence only if a supported browser harness/device is available. Do not use generated screenshots or invented devices to fulfill the mobile criterion.
5. Implement subsequent milestones with the same Ticket/Grant/Assignment/Lease/Effect/Artifact contract, not a replacement reporting channel.

See `BASELINE.md`, `MEMORY.md` and current commit diffs for exact commands and integration known issues. test results must be derived by the real commands, not copied as evidence into each future milestone.
