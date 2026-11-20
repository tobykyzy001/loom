# Bounded direct peer-to-peer artifact handoff

This test is a real **direct data path** between two independent local Node identities, not another coordinator-mediated copy of bytes and not a claim of a second physical host or remote/TLS product readiness.

## Exact proof command

```sh
node tests/direct/loopback-handoff.mjs
```

The maintained case exits **0** with **14 PASS** checks, including a source and latest cancellation/failure case. The output JSON is written in the temporary own fixture root as `direct-loopback-result.json`, with actual `network_bytes` and SHA matched against the physical destination readback.

## What this demonstrates

1. Two actual LocalNodeRunner Ed25519 identities and installation IDs, with independent ProjectBindings, root directories, read Grant on A and write Grant on B. The source Task produces a normal immutable Artifact UUID (`sha256`, origin, source Ticket and source `loom://artifact` URI), not a synthetic ref with no actual byte registry.

2. A real two-stage existing pipeline emits the downstream `edit_file` with `direct: true` **only** for the already-supported `trim` operation. The Assignment still follows real Stage definition / raw Grant / ProjectBinding / Assignment / Lease and contains only the exact parent ref. It does **not** include `bytes_base64` and is not the ordinary coordinator-assisted byte inheritance. Plain documents stay on their normal `direct: false` implementation.

3. Recipient B asks its own Node Bearer (never the admin token) for a `direct_offer` from `POST /api/v1/nodes/direct-offers`. The center re-verifies the exact parent pipeline relationship, actual source Ticket, origin, source-read/dest-write raw Grants, active ProjectBindings, Node/installation/worker and the live current Assignment/Lease. The retained offer binding is persisted in SQLite v5, uniquely by destination ticket/epoch so repeating issue on restart keeps the original offer identity and nonce rather than resetting them.

4. The center issues a bounded `loom.direct-offer.v1` with a one-use random nonce, source/recipient public keys, assignment, lease_epoch, Current read/write Grant versions, source/dst bindings, expiry (minimum of the allowed lease and a one-minute offer window). The signed statement includes ticket, recipient installation/worker/node, artifact UUID, Source Ticket, SHA/origin, source/dest grants and binding IDs. These facts cannot be substituted for arbitrary node names or source origins.

5. The actual A-only `LoopbackArtifactOfferServer` runs an owned dynamic HTTP endpoint on **127.0.0.1**, not on a public interface or an implicit hostname/DNS alias. A numeric `::1` loopback can also be used; no hostname/group-selection/host directory scan is supported. B signs the complete immutable challenge with its real persistent private key. A verifies B's actual public key, recipient identity/worker/installation/lease and artifact origin, AND calls back the coordinator **`/nodes/direct-offers/scope` with the Source Node’s normal bearer**, not Admin credential. That rechecks the then-current grants and bindings and artifact origin again. The coordinator then enforces current target attempt, running/cancel state, current Lease and offer expiry. A verifies them before returning the exact locally retained bytes.

6. The destination really fetches the Artifact over the direct loopback HTTP socket, with explicit endpoint, bounded request/body size, exact media type and byte limit of **1 MiB**. No HTTPS/TLS or external provider transport is claimed. It does not read a path supplied by a caller, an arbitrary host-local file, remote Resource URL or downloaded model.

7. B independently recalculates the real byte count/SHA, checks the original ticket/origin/reference/epoch relationship, normalizes the only already-supported `trim` operation and passes that verified payload to the ordinary `ControlledFileExecutor`. The ordinary write Grant/ProjectBinding/lease and immutable Artifact/Effect pipeline then produce the new file and new immutable Artifact whose real parent UUID/hash/origin/ticket are preserved. This is not simply a child Artifact saying it has a parent.

8. Nonce consumption is durably written under A's separate private state before the byte response. That prevents reuse during the test and after controller restart. A replayed nonce can't write another effect; exact completed polls remain idle with stable file inode. The nonce isn't an unlimited authorization or a universal exactly-once/rollback guarantee: an effect could still require inode/host reconciliation if one side stops after an attempted transfer. It's deliberately a narrow one-read protocol, not a second source of task truth.

9. Cancelled stop intent now causes direct fetch denial even with a previously valid B signature and valid read/write grants. Revoked source Grant stops a fresh unconsumed offer and its next file effect. Overrun source streams are rejected before file creation. Missing/offline socket does not fall back to downloading through the Coordinator.

## Verified errors

- `recipient_signature_invalid` for foreign or wrong signatures,
- `wrong_recipient_or_lease` / current assignment fences,
- `offer_nonce_consumed` for replay,
- `offer_expired` and recipient/lease expiry,
- `source_grant_denied` on revoked source Scope (plus the co-existing `direct_offer_source_denied` scope endpoint error classification),
- `source_response_limit` when actual body bytes exceed the advertised 1 MiB limit,
- non-loopback authority/host alias, source SHA mismatches, direct-response type/size mismatch,
- offline source `source_offline_no_borrow`; no coordinator fallback that manufactures a full success.

All owning peer servers and the foreground coordinator are stopped per-run. Temp identity/storage files are separate from the Source project Root and from real user profiles or credential stores.

## Current reference evidence

Coordinator-independent rerun at 2026-11-16/17 UTC:

- `tests/direct/loopback-handoff.mjs`: **14 PASS, overall PASS / exit 0**.
- Source UUID `4f68fd97-331f-4862-a986-7ce9c29af46a`, Source Ticket `tkt_1945668dd234477e99fe932c99bbbac1`.
- Raw artifact original/current transfer bytes: **210 bytes**, SHA256 `32fe2a591295eafc4c3c9c1a55f27fb64b1d963e6841f9726e519b35cef7c921`.
- Output Artifact `060b69db-bee9-484e-9c0f-74136542e33e` under B, with that direct source ticket and source Node `1fbad3889632afee65213cdb485731d9e9b2c754608b5894d50c9c3fe89205e3`.
- Recipient Node `a321357831191e4647c49c64d544d09dde68e59bdcf8cd24f6dd1862748c5461`.
- `artifact_ref` relationship and the child's lineage `component_sha256` correctly remain independent rather than simply inheriting the old Root/document digest identity.
- Center/original offer ID and issue-nonce survive restart; stopping the actual peer cannot be replaced by a coordinator success fallback.

The local evidence file from that execution was `/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-real-http-NM9yTF/direct-loopback-result.json`. UUIDs change per fixture; these are references for this concrete run, not credentials or machine-stable identities.

## Controller rejects a sibling substituted for the immutable parent

```sh
node tests/direct/parent-lineage.mjs
```

A second real-Node/HTTP proof previously showed a receiver using its valid assignment, lease and write Grant with a different but entirely real sibling Artifact as its claimed parent. The old upload path accepted this, after which the attached report and confirmed effect could complete the child. That was **not** a DirectOffer signature bypass; a regular Node request could bypass the client's own intermediate ref check.

After re-validating its current Node/assignment/lease, the server now obtains `pipeline::input_for_assignment` and compares the entire structured parent `artifact_ref`, including artifact, ticket, origin, digest, URI and the prior lineage. An authenticated valid dictionary entry or identical content from a sibling is no longer enough to choose the upstream independently. Missing or altered references are rejected. If no pipeline parent exists, ordinary Artifact SHA/origin checks remain unchanged.

The driver creates two actual parents and their distinct downstream Assignment. The first substitution gets exact `403 artifact_lineage` before creating a child Artifact, report or confirmed effect, with the original acknowledged Assignment and full Grant set unchanged. A second child keeps its server-identical reference and completes with one proper artifact/report/effect. The two original parent records remain immutable. After the controller actually stops and restarts with the existing credentials, the original wrong-child lookup is still denied and both child outcomes/grants are unchanged.

This is a **server lineage fence over real HTTP**, not a fabricated filesystem write or another physical Host. The deliberate lineage-probe receiver doesn't execute the proposed output bytes or construct its own `DirectOffer`, so the evidence concerns server acceptance, not a new remote agent tool invocation. Existing `loopback-handoff` independently proves actual byte transport and its ordinary file effect, protected offer signatures and failure cases. No-profile-change/hardcoded-parent validation is not a general second-host DAG or unrestricted Artifact sharing grant.

## NOT RUN / deliberately unsupported

Physical second devices, public or remote TLS endpoints, global peer/network discovery, localization or a true immutable remote service, non-hostname-trust aliases replaced by trusted mTLS, cross-machine Root deployment, arbitrary remote root reads, big-file/compressed delivery, model/Harness/OAuth portability, mobile, arbitrary pipelines or a complete M2 final acceptance. This bounded local method only proves the direct protocol and its current-scope enforcement can work without blindly transfering bytes through the coordinator.
