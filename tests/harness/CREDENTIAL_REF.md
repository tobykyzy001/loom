# Scoped DSH credential-reference lifecycle

## What was executed

For this permitted local increment, `node tests/harness/real-credential-broker.mjs` creates a throwaway Rust Concierge, project and zero-network DSH profile under a temporary `loom-dsh-*` root. It installs `@loom-test/credential-record`, which mounts the shipped **0.2.2-rc.3** `LocalCredentialProvider` through a real Loader row at `<fixture-node-state>/credential-store/records.yaml`. A **separate test-only seed plugin** creates one explicit synthetic `loom-local-node/refid-…` record through public `ctx.credentials.modifyRecord`. The synthetic record value is not an actual password, token or user credential.

The real installed Local Node then performed:

1. An independent `credential_inspect` Grant issued `inspect` for the exact ProjectBinding-derived record key. Public `describeRecord` produced a byte-backed bounded `present` metadata Artifact. No record value was returned to the controller.
2. An independently issued `credential_revoke` Grant could only act with a Ticket naming that completed inspection. Before execution and again immediately before `deleteRecord`, the node called `/api/v1/nodes/credential-authorize`, an authenticated Node-envelope endpoint that re-reads the current Grant, Assignment/Lease, exact Binding and immutable inspection bytes. Both responses must exactly match the preflight authority snapshot. The actual SDK service then deleted that exact key and re-read `configured:false`.
3. After restarting the same isolated Host **without seeding**, a fresh inspection observed real persistent `missing`, not a result inferred from the report label.

Latest successful fixture instance of this iteration: `inspect=tkt_a11091c64df94d76b929b7eaeafcefad`, `revoke=tkt_4895eeab04364f8697ac7911101a6b4f`, restart-missing=`tkt_fb33200991bb4c72a640ce2a0927040e`, root `/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-dsh-CIj2c3`. These are per-run evidence IDs, not permanent fixture roots.

`node tests/harness/real-model-binding.mjs` and `node tests/projects/git-probe.mjs` subsequently remained PASS for this increment.

## Hard boundaries

- `credential_inspect` and `credential_revoke` are **separate exact one-operation Grants**. File read/write, `place_model` and `invoke_text` cannot substitute for either. `credential_revoke` can't use `expect_present:true` alone: a current matching inspect Grant and successful Assignment/Report are required, plus one bounded ordinary JSON Artifact, its storage UUID and verified actual bytes/SHA and **all of the safe result identity fields, including absent secrets and `configured:true`**.
- An inspect proof does not establish same-version secret ownership, remote authentication or general repository/inference authority. It proves that this exact key had metadata presence. Revoke is an explicit current-record-key action, not discovery of whichever credentials exist. There is no `readRecord`, secret resolve, `listRecords`, `modifyRecord` or arbitrary owner namespace in production broker execution.
- Grant revocation, cancelled/expired execution, different Node/Installation/Project/Binding, changed authorization and inconsistent proof are refused **before** metadata/deletion where applicable. Deleting reports `unknown` unless actual missing state was re-read: the caller cannot relabel an uncertain external outcome as revoked. A terminal revoke Report and its single Effect must match the immutable reference, deterministic scoped input digest, original Grant version/digest and Artifact subject/SHA; `confirmed` alone is not authority.
- An already verified local completion may be replayed as historical evidence without deleting again. This does not mean the current holder of the record is unchanged. Versions of the underlying secret are not exposed by this public SDK seam, so there is no claim of compare-and-swap on content or an atomic credential transaction with the center.
- The fixture seed never becomes a default production credential. Production `credential_broker_tasks=unsupported` remains off, and normal workers do not globally require the credential service. Enabling `dsh_records` still requires the operator to mount a suitable provider with public `describeRecord`/`deleteRecord`, separately from any Task Grant.
- Only discrete `refid-[a-z0-9][a-z0-9-]…` controller-derived key names are used. Binding and logical Reference id are distinct. Digits are allowed after `refid-` and `cref_`: initially incorrect initial-letter rules silently rejected many random valid Binding-derived ids. Implementations must keep the same bounded prefix/length rule across languages.
- Outcomes are stored through existing durable Node outbox/replay paths. `acknowledged_at` is a delivery checkpoint and suppresses duplicate new execution; unresolved outcomes still require actual evidence rather than implying a central rollback or exactly-once claim. More generic delivery/reconciliation is outside this slice, and coordinator retry must not be used as a replacement permission check.

## What is still NOT RUN

Production Credential/Secret Store, OS Keychain, remote Git authentication, actual secret inspection/rotation, any application's real credential value, physical second host/TLS, generic provider bootstrap, platform service installation, composer `1 Concierge + 3 Nodes`, mobile/PWA lifecycle and deterministic multi-millisecond interruption guarantees are **not accepted**. The validated topology is one Rust Concierge and one isolated DSH installation/worker on this machine. The fixture exposes only its own synthetic file provider record, not Desktop or the current user's projects.

## Failure and repair chronology

The earlier prototype experimented with dynamic LocalCredentialProvider construction, unconditional credential-services required during ordinary Host startup, missing test package identities and an incomplete `expect_present` shortcut. These were rejected, not silently accepted. Actual model readiness also exposed the fixture Stub's `await mkdir` behind an asynchronous effect hiding the adapter registration from SDK initialize; registration now precedes asynchronous readiness work in the tested Host copy and synchronously publishes it before the initialization boundary.

The Host's two client implementations had to support the same authenticated pre-execution method: missing `authorizeCredential` on the vendored DSH client yielded a real pre-authorization `TypeError` and an undeliverable empty-unknown report, not a completed credential operation. This is why a successful self-contained Broker unit test wasn't host acceptance. After obtaining real `present`, a bug where maintenance code never set `credential_action` before composing the revoke-proof expectation was fixed. Both the JS validator and Center recheck reference/inspection proof self-consistency, outer/current scopes and the real immutable SHA now. Diagnostics or temporary probes are not substitutes for these lifecycle assertions.

The Git project lifecycle is intentionally separate; see `tests/projects/README.md`.
