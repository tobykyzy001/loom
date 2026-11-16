# Exact `read_summary` Skill replay evidence

Only a **byte-identical replay of one successfully executed deterministic `read_summary` sample** is proven here. It is not a learned Skill driver, a general workflow, a permission to run a stored Skill, or a standing Grant.

## Evidence model

- A pending Skill candidate must name a `source_ticket_id` already present in its bounded `source_refs`. Its project must match that source.
- The source must have an actual successful Assignment/Report and exactly one application/json Artifact from that source worker, with its immutable SHA and bounded deterministic summary fields.
- The source Grant participates in the original project/node/installation/worker/ProjectBinding incarnation. The controller must not bypass host mapping, a current placement, or a Grant revocation.
- `POST /api/v1/candidates/{id}/replay` creates one ordinary `read_summary` Ticket plus a current normal Assignment. It does not finalize a skill or copy an original Artifact. A repeated request returns the same replay binding rather than creating another ticket.
- Only the real ordinary worker can produce the new report and new Artifact. `GET /candidates/{id}/replay` (also refreshed by `GET /candidates`) compares the freshly uploaded bytes directly with the actual stored original bytes and recomputes both SHA-256 digests. Schema alone, a flag, an `artifact_ref`, a self-reported `verified=true`, and text status do not constitute proof.
- A successful explicit accept re-reads and revalidates the source lineage plus the fresh Replay's lineage. The terminal Ticket has to be `succeeded` and not carry stop intent; the replay's actual worker/node/installation/attempt, `lease_id`, `lease_epoch` and parsed expiry must agree with its ordinary Assignment/Report. First acceptance requires the **then-current** unrevoked original Grant, its digest/version, active matching original ProjectBinding, exact worker/node root placement and source_refs. It is not a new execution right obtained from an old replay. Only then can it save an independent `skills` provenance record. Skills are no longer copied into `memories`. Memory candidate acceptance remains separate. Replay orders/backups preserve `verified_at` at first actual verification time, not each read.
- A mismatch, missing lineage, failed/unknown execution, malformed Artifact, false source scope, revoked Grant, or revoked project binding cannot become verified. Revocation cannot create another ordinary replay ticket. Previously accepted proof remains marked historical and `standing_grant=false` / `activation=false`.
- `undo` removes the saved Skill record but does not create a Grant, roll back an Artifact, or replay anything. `reject` and `later` do not execute any work.

Schema migration is additive v7, with `skill_replays` and `skills`; there is no v7 rewrite of Grants, Tickets, Artifacts, Sessions, or audits. v3→7 and v6→7 migration tests preserve those records. The replay association has one candidate→ordinary replay ticket mapping and a separately fresh replay Artifact reference, not a duplicate replay on every request.

## Real foreground test

```sh
node tests/skills/read-replay.mjs
cargo test -p loom-concierge skill_replay
cargo test
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --check
```

The driver uses one temporary project, a foreground loopback Concierge, and the existing deterministic JavaScript Node. The original source file is not overwritten by the replay. A separate explicitly mutated fixture demonstrates that changed actual bytes fail `sample_mismatch` and cannot be accepted. The original successful source artifact and report remain intact. The grant is revoked afterwards and no subsequent replay ticket is created. Reopening the real SQLite center preserves the immutable proof, source/replay artifact bytes, and audit chain.

Actual passing reference:

- Source and replay SHA-256: `6a9ce377d14e3e5266b4bcbbe6cc7613a82cb0961e2023946352996c7321ac45`.
- Mismatch fixture SHA-256: `34e3d336a1e4a135358223e13e55408911e0a15bfb28e51c64510ec996e77cce`.
- One actual replay Ticket beyond the source, plus one deliberately differing negative replay Ticket (3 total in the driver).
- One proof-only `skills` record, zero Skill-created Memories and zero additional Grants.

Hashed bytes are generated per fixture, but these exact fixture values are stable. IDs change per run and are not permissions. No real LLM, provider, actual DSH Profile, arbitrary command/process, configurable Shell/HTTP connector, or paid/network request is used. This remains a local, bounded, deterministic evidence increment, not a general Skill runtime or overall M5 delivery.

## Human review in the actual Web page

A separate Skills page (not Memory) now supports choosing a source Ticket actually bound into the candidate, reading bounded details so the original Artifact can be examined, then explicitly confirming that a normal read-only replay may start. It posts only `source_ticket_id`, never a root/grant override or self-declared verification. The view cannot accept before a real replay, candidate or hash/model-gallery shortcut. After the worker's real artifact and report arrive, the page can show the verification result before the user separately confirms acceptance.

`node tests/skills/read-replay.mjs --browser` uses the same actual source and candidate, launches the Vue page through the local Vite configuration in a new isolated Edge session with local-only proxying, chooses that ticket in the real UI and captures the actual request body. Only then does the test call the real Node runner. It also confirms accept via a second explicit dialog, then checks one new ordinary replay Ticket, different source/replay Artifact IDs, same real byte hash, unchanged grants/memory, and `standing_grant=false` / `activation=false`. Duplicate acceptance is distinguished from initial acceptance and is refused without creating another skill. Changed sample bytes and revoke-after-replay-before-first-save still fail. Replaying again or closing/restarting the center does not create another work ticket.

It also verifies **390px wide simulated viewport** has no horizontal overflow, while both original and replay links/UUIDs stay readable. Screenshots are written to the owned fixture as `skills-proof-desktop.png` and `skills-proof-narrow.png`, with `skills-proof.json`. No credentials or current browser/DSH session is used; the browser profile, Vite cache, process and controller are destroyed per fixture. This was **actual Edge PASS**, not an SSR props screenshot, but it is not a physical mobile certificate.

Frontend evidence assembly is explicit: the tickets list is a summary, not the full Artifact registry. The bounded detail read is only for candidate source/replay references, limited and non-executing; missing, mismatched, revoked or unverifiable related records disable acceptance rather than invent access. Direct source/Grant/task lineage is still determined by the controller, not by a frontend checkbox.

No generic Skill runtime, standalone Skill activation, source-directory execution, arbitrary imported skill learning, script engine, paid LLM generation, provider installation or distributed Skill store is implemented by this small view. Typical outstanding platform, multi-device/TLS and physical mobile remains separate.
