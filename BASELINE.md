# First deterministic baseline report

Execution date: 2026-11-17, local macOS development host.

## Runners and actual state

The test fixture uses only synthetic files and short-lived test credentials under a unique temporary directory. The coordinator and deterministic tasks use real HTTP, a real bundled-SQLite database and real filesystem reads/writes. They do not invoke Anthropic/OpenAI/DeepSeek or any other model, attach to DSH, write the Desktop profile, or run a 1+3 topology.

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

- Actual DSH Host installation, configured model providers, Agent create/resume/tool tool results, event replay and cancellation through a real Host. A local deterministic file Node is not “DSH execution”.
- True Rust↔TypeScript actual-file task until the separately named `scripts/run-real-integration.mjs` result exists and passes. Unit protocol fixtures alone do not prove it.
- 1 Concierge + 3 workers Compose topology (intentionally deferred per user request).
- Mobile real-device Web/PWA cases, lockscreen/kill-process/resume, desktop installers, OS system credential stores, Linux/Windows Host behavior and signed update/rollback.
- Actual research/programming/graphics multi-agent live LLM tasks, non-synthetic data, GPU models or industry pipeline. There is no GPU or physical-device assumption.

The audited implementation notes live in [MEMORY.md](MEMORY.md); the intended layered test strategy is [testing.md](testing.md). Milestones complete only when their **actual** evidence exists.
