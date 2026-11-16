# Artifact handoff: actual same-host benchmark

This is a **supplemental M0/M1 integration benchmark**, not an M2, geo-distributed, physical multi-machine or Host-direct transport acceptance.

## Actual boundary

The driver `scripts/artifact-handoff.mjs` launches one **real foreground Rust Concierge** using `scripts/fixtures/rust-server.mjs`. It does not use `SyntheticCoordinator`, Compose, Docker, a fixed three-node topology, a real DSH Profile, another machine, private credentials or a real model.

The two logical LocalNodeRunners on this **single host** use:

- independent Ed25519 keypairs, Node IDs, Installation IDs and separately issued Node credentials;
- separate `node-a-state` / `node-b-state` and `node-a-artifacts` / `node-b-artifacts` as private siblings of Project roots;
- two independent temporary approved roots and Project IDs, both created with `POST /api/v1/projects` and `mode: "read_write"`;
- different registered Worker IDs and exact ProjectBinding inventory declarations;
- a read-only Grant for Worker A and a write-only Grant for Worker B.

Being on one host is **not an OS sandbox, process isolation or physical network security claim**. All file Grant checks remain explicit in the Local Node.

## Execute

Build the actual current center instead of relying on a stale executable:

```sh
cargo build -p loom-concierge --bin loom
node scripts/artifact-handoff.mjs
```

The default report is `tests/handoff/artifact-handoff-result.json`. Set `LOOM_HANDOFF_OUTPUT=/tmp/new-handoff-result.json` to write to a new temp path instead. A rerun overwrites this **benchmark evidence only**, never a previous center's Artifact, Ledger or project data.

To run without cloning any model runtime, make `target/debug/loom` executable first using the command above. The standard fixture creates a random temporary single-use controller credential and new temp center; it does not read or alter the current user's DSH Profile. `LOOM_BASE_URL` can only be an isolated loopback center with an explicitly supplied `LOOM_CLIENT_TOKEN`; no remote acceptance is implied.

Exit status follows the entire real outer result: the top **result** has `overall=PASS` with exit `0`, otherwise `overall=FAIL` with exit `1`. Setup faults not producing JSON still produce a nonzero process error, and are never relabelled successful or skipped. Do not pipe stdout to another command and treat its status as the test status. The response JSON expresses each check and a precise first failure. No older reports are used as evidence.

## Latest actual result

- `node scripts/artifact-handoff.mjs`: **PASS**, exit 0, all **14/14** checks passed on 2026-11-17 Asia/Shanghai (report timestamps `2026-11-16T18:00:51.254Z` through `2026-11-16T18:01:58.214Z`).
- `node --test packages/node-client/test/*.test.js`: **7/7 PASS**. This unit run is not substituted for the real HTTP benchmark.
- Source Artifact `5a00f880-4a06-494d-9da7-4f7f49d4064c`, SHA-256 `8c8055bd4422e49f114c65c20204825a249e43629a6eda241172fd8d09da564d`, Origin Node A.
- Destination Artifact `93f3df0b-6bd2-45e5-a804-387e872975d7`, SHA-256 `fbe3bcb8d4ee7c3157fc947f7a6a3e715d6a662cc9b693f9a493e9886bde00a2`, Origin Node B.
- A's observed last heartbeat was `2026-11-16T18:00:51.896145+00:00`; stale observation `2026-11-16T18:01:52.169Z`, about 60.27 seconds later with no A HTTP traffic during the offline driver phase.
- See `artifact-handoff-result.json` for actual Grant/Worker IDs, Report request IDs, Effect ID, source-derived payload, submitted provenance and center-canonical parent record.

The numbers above are this one fresh run's evidence, not fixed expected IDs and not a historical guarantee for a different checkout.

## What the script asserts

1. Rust Health and actual controller registration, signed Ed25519 enrollment, exact Worker/root inventory and bindings.
2. A's other-location binding rejection; cross-Node bearer rejection; read Grant cannot write and write Grant cannot read.
3. A executes `read_summary` on its real input file, producing an original Artifact from HTTP-reported, hash/size-verified bytes.
4. Artifact exact replay (same stored request ID) and mismatching SHA/bytes/lineage are attempted against the Node's *active* Grant. A root Artifact with no parents cannot be used as a fake non-empty-parent rejection test.
5. A stops its outbound HTTP transport and heartbeat/poll driver, then waits until the **actual center** reports `online=false` and `freshness=stale_offline` (60-second freshness threshold; up to 68 seconds for observation). No A HTTP requests are sent during this phase, not merely an `offline` print.
6. A's Grant is revoked. Its Report and Artifact history remains readable. Retry of the completed Ticket adds no Assignment. A new Ticket using the revoked Grant is refused; B cannot claim A's Assignment in a Report.
7. The **operator/controller**, not B's write-only worker, verifies and downloads A's known Artifact over real authenticated HTTP. The operator builds the body's specified `generated_payload` JSON from those verified bytes. This bounded conversion is the operator's data input to a new, explicit `edit_file` Ticket, not autonomous scraping of A's remote filesystem.
8. The scoped B executor accepts only that verified source and the ordinary `edit_file` effect. Its content must match the verified source summary and other known provenance. It calls the existing ControlledFileExecutor, then attaches a bounded original-JSON `artifact_ref`. It does not accept a free metadata object, arbitrary secrets, caller-controlled Artifact digest/origin or effect `input_digest`; those are still recomputed by the ordinary executor/client and validated by the center.
9. B writes `handoff/generated_payload.json` **only in root B**, confirms a real Effect, exports a separate hash-verified Artifact receipt, and has no rootA mapping. The scoped test executor retains the ordinary `{path, kind, operation, target_hash}` receipt, verifies the actual root B file equals the operator's `assignment.content`, and extends its **new** Artifact bytes with `generated_payload` and a base64/SHA/parents copy of the verified Source JSON. It recomputes SHA/byte size for those new bytes in the existing Node DTO, which still computes authoritative digest from the bytes. `target_hash` is checked against the bytes actually written under root B. It never retains an old SHA over enriched bytes or rewrites the base executor's/A's Artifact. Its persisted Report/Artifact request IDs, Assignment/Lease and independent B origin are asserted.
10. The center preserves parent relationship with source Artifact ID, actual source origin, source hash, source location, parent lineage and resulting component hash; it rejects attempts to erase lineage while retaining Artifact ID/bytes. A and B do not become the same origin by co-location.
11. An over-small reader limit rejects the response. The controller audit chain verifies. Evidence contains no enrollment code, raw private key or test bearer token. Local identity private material stays in each temp runner state directory.

## Handoff transport and limits

This handoff is **controller-mediated inline HTTP**: Controller reads the known Artifact using `GET /api/v1/tickets/{ticket}/artifacts/{artifact}`, checks hash/byte size, provides a deterministic file-write body to B, and B uploads its own bounded generated Artifact. Worker B does not receive A's filesystem mapping or administrative token.

`direct_host_transport=NOT IMPLEMENTED`. There is **no direct whole-file >8 MiB transport promise**. The center accepts an inline Artifact from 1 byte through **8 MiB**, its HTTP request has a separate 16 MiB maximum, and this deterministic file executor has its own 1 MiB controlled file limit. The HTTP JSON download is not a general binary large-file API.

This benchmark uses existing explicit `edit_file`; no new Ticket kind or multi-hop Pipeline is introduced. It does not claim arbitrary remote files, general remote Artifact retrieval by a write-only worker, autonomous transfers, exactly-once distributed effects or automatic network/second-machine recovery. Those require separate design and actual evidence.
