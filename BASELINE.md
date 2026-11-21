# First deterministic baseline report

Execution date: 2026-11-17, local macOS development host.

## Runners and actual state

Every fixture uses only synthetic files and short-lived test credentials under a unique temporary directory. The coordinator and deterministic tasks use real HTTP, a real bundled-SQLite database and real filesystem reads/writes. The deterministic tests do not contact a paid model, modify the active Desktop profile, change the system's Credential Store or run a 1+3 topology. The separately named installed-DSH runner creates its own temporary `DSH_HOME/HOME` and explicitly isolated `loom-local-fixture` profile, with an in-process, zero-network Stub Provider; it tests the real DSH Process Agent/Session machinery, not live LLM quality.

Run the authoritative version in this repository rather than treating this document as a self-verifying artifact:

```sh
cargo test -p loom-protocol --features fixture-signing
cargo run -p loom-concierge --bin loom -- smoke
pnpm --dir packages/node-client test
pnpm --dir plugins/dsh-loom test
pnpm --dir apps/web test
pnpm run build
```

## Evidence requirements of the baseline

| Category | Hard external assertion |
|---|---|
| Enrollment | Signed Ed25519 nonce bound to public-key-derived node id and installation; hashed single-use code cannot be replayed |
| Project | Existing directory probed, not cloned/uploaded. Local host must declare the matching mapping. Administrator confirms ProjectId+node/installation/worker binding before Grant |
| Assignment | New Lease pins project binding and grant digest, not just a self-reported capability |
| Artifact | Bounded bytes match size/SHA256 and lineage; immutable ID cannot be reused to overwrite old files; same exact replay does not duplicate effects |
| Report | Artifact must be verified before successful report. Identical request identity+body returns old receipt; changed content conflicts |
| Recovery | Same database reopens tickets, reports, artifact index and credentials without creating a new administrator credential |
| Cancellation | Stop intent persists. Late successful report is rejected. Raw acknowledgement alone does not promote cancellation or success |
| Unknown | Explicit effect evidence becomes `reconciling`, not Failed. `retry` refuses unknown effects rather than repeating an unknown external effect |
| Audit | Hash-chain ordering and raw evidence payload verification, without re-encoding it into a different representation |

## Fixed during initial implementation

- Client bearer token and node token are distinct secrets. No working anonymous/admin fallback in active client APIs.
- Rationalized feature scaffolding into actual routes and removed dead, non-equivalent manager code.
- Temporary restart with an unknown administrator credential refuses to replace an initialized credential.
- A node identity is SHA256 of its raw Ed25519 public key, not an arbitrary supplied name or code.
- Project mappings distinguish host-local values from controlled `loom://artifact/<UUID>` references; a local pathname is not a universal artifact URI.
- Grant `read_summary|edit_file` task shapes are distinct from stored `read|write` permissions. Grants point to explicit node/project bindings, not vague capability descriptions.
- Files are only replaced with an exclusive new artifact ID. Colliding content or lineage is rejected before renaming. The old file cannot be silently overwritten.
- Unfinished unknown effects are not blindly converted to failure or rerun.
- A successful report cannot be overwritten by a different late report. An exactly repeated report is returned idempotently.
- Model/dag registration prefaces are explicitly disabled instead of being portrayed as real execution.

## Explicitly NOT verified

- **Live LLM provider/model behavior, quality and production credentials.** The actual DSH fixture has passed plugin installation, signed outbound Node registration, Agent followup, controlled tool execution and immutable Artifact return through the real installed Host. Its cancellation and resumed-Session proof must be checked from the actual final `node scripts/dsh-fixture-runner/run.mjs` report; do not mark cancellation/resume PASS merely because the fixture exists. A deterministic file Node is not “DSH execution” and a Stub is not a live model.
- Cross-machine second physical Host, direct large-file transport, Beacon/discovery, remote administration or the deferred 1Lis/Compose fleet. The optional local double-isolated Node Artifact handoff does not authenticate a remote machine or a TLS relay.
- OS Linux and Windows hosts, hardware provisioning, signed installers/service integration and OS credential stores.
- Mobile real-device Web/PWA cases, lockscreen/kill-process/resume behavior, desktop installation and rollback.
- 1 Concierge + 3 workers Compose topology (intentionally deferred per user request).
- Mobile real-device Web/PWA cases, lockscreen/kill-process/resume, desktop installers, OS system credential stores, Linux/Windows Host behavior and signed update/rollback.
- Actual research/programming/graphics multi-agent live LLM tasks, non-synthetic data, GPU models or industry pipeline. There is no GPU or physical-device assumption.

## Current authoritative deterministic entry point (2026-11-22)

Run `node scripts/verify-baseline.mjs`. It uses a real Rust Concierge, authenticated HTTP, actual files and an independent Native Bare process, rather than `SyntheticCoordinator` as task authority. The report records exits, commands, actual scene checks and NOT RUN cases; it does not execute a 1+3 Compose topology or install DSH.

The macOS arm64 run passed all 12 scene checks and all seven selected suites. Evidence: [result](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-baseline-verification-ht6dSh/result.json) and [scenario](/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-baseline-verification-hHUkou/result.json). Exact commands and limitations: [DETERMINISTIC_BASELINE](docs/DETERMINISTIC_BASELINE.md). Bare direct handoff and production Composer lifecycle are separate subsequent increments, not promoted by this baseline.

The audited implementation notes live in [MEMORY.md](MEMORY.md); the intended layered test strategy is [testing.md](testing.md). Milestones complete only when their **actual** evidence exists.
