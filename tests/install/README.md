# Synthetic Install Plan v1

Run `node tests/install/plan.mjs` from the repository root. This starts an actual loopback Rust Concierge with a temporary database and `LOOM_INSTALL_SIMULATION=synthetic_inventory`, exercises admin-authenticated create/read/approval/observation/rollback APIs, and restarts that owned process. It uses no real host, SSH, command, package downloader, profile, credential, Ticket, Grant or Assignment.

`loom.install-plan.v1` is separate from the database schema version; current Store is **schema 16** (the previous schema 15 added bounded Ticket priority; schema 16 adds optional `artifacts.read_evidence_json`). `tests/install/plan.mjs` reads the actual `doctor.schema_version` into its PASS output instead of hardcoding an older database tag. This applies only to the schema of durable controller records, not the unchanged `loom.install-plan.v1` protocol. The only built-in package candidate is the recorded Bare Host `0.1.0` current macOS arm64 package metadata and SHA-256. Explicit `fixture-` Inventory rows are not registered Nodes and cannot imply online, trusted, installed or granted status. `observations` are manually supplied synthetic fixture classifications, never evidence of a physical installation. `unknown` remains unknown and cannot be retried or rolled back without a future explicit reconciliation design. Restarting the real server without the simulation environment disables observation (501) while preserving plans and audit history.

Rust coverage: `cargo test -p loom-concierge install_plan --locked`. The suite includes v6→v7→v8→v9→v10 ordered migration preserving Grant/Artifact/report lineage, plus preexisting v7 Grant and Skill candidates, no Task/Grant creation, duplicate/unknown-field rejection, unknown stability and disabled observation. This small slice is not an installer, a generic deployment controller or a platform support matrix.

## Local package verification before a review plan

```sh
node tests/install/package-manifest.mjs
node tests/install/browser.mjs
```

The first real HTTP driver takes the package produced by the existing native smoke, then supplies its existing `package_manifest` path alongside the unchanged `loom.install-plan.v1` component/targets. The controller performs a bounded read-only inspection of the exact manifest and its local bare binary: single-regular-file/link restrictions, bounded JSON/bytes, valid mode/size, matching SHA-256 and byte count, and the present thin Mach-O arm64 metadata. Strict JSON handling and the non-executable status constrain what can produce `pending_approval`; there is no execution, host registration or activation.

The returned component keeps `component.sha256` and gains only controller-derived `source_manifest_sha256`, computed over the exact source manifest bytes. Neither the path nor a client-invented value is accepted as authority. Byte mutation, a wrong declared arch, multi-linked metadata or a falsified source digest are refused before plan creation, with no new Plan/Audit/Grant/Ticket and unchanged public snapshots. This is a **local read-time check** (currently Darwin arm64), not a signature or lasting package-existence guarantee. Subsequent execution still requires fresh independent byte and permission checks.

The real Edge proof uses the actual built package plus the standard synthetic Inventory UI, then confirms that a protected refresh presents the controller-produced digest and “已核验本地manifest与binary（未安装）”. The source path is not published, frontend parser accepts only a 64-hex optional field and preserves missing-field legacy plans, and Ticket/Grant/Node collections are unchanged. This does not create a generic package registry, remote rollout, new secret access or a second Host.

## Actual Vue / Edge review flow

`node tests/install/browser.mjs` launches its own actual Rust controller with the explicit simulation flag plus an isolated Vue/Edge profile. Through the visible UI and confirmation dialogs it creates a fixture-only plan, selects the incompatible Linux example, approves the current plan digest, records a fixture health failure, requests rollback using **the exact apply operation**, then reports that rollback using the newly assigned operation. A separately prepared pending fixture plan becomes `unknown` via an actual visible `connection_lost` confirmation; repeating that exact receipt is read-only and attempting a healthy reclassification is rejected. UI payload shapes are checked, and controller data must contain the real plan digest, current/rollback operation IDs, rollback parent and both separate observations. Ordinary tickets, grants and registered nodes remain unchanged.

Screenshots are taken after actual interaction for a desktop sized view and a 390px simulated viewport (no phone claim). The helper checks that the UI is explicitly labelled synthetic/no real deployment and leaves no hidden tokens or credentials. The owned browser profile and Vite cache are closed and removed after completion; captured images contain only the synthetic fixture names/records.

A known frontend guard previously blocked rollback because `target.observations.length > 0` treated a prior apply as the current operation. It now checks **the current operation ID**. A previous apply cannot be erased or relabelled; only a newly approved rollback may receive its own observation, with the parent apply preserved. An unknown operation is not advanced by this guard fix. A browser page reload is separately reported from the real controller restart in `plan.mjs`; it is not presented as a service restart.

Observed result: both the real HTTP driver and real browser driver exit 0. A coordinator-confirmed browser proof and its two screenshots are `install-plans-result.json`, `install-plans-desktop.png` and `install-plans-narrow.png` under the disposable fixture `TT/loom-real-http-zeTA3H` (normal platform TMPDIR). They retain distinct apply/rollback operation IDs, parent linkage, stable Unknown history and unchanged ordinary tickets/grants/nodes.

`tests/browser/install-plans.mjs` exports the verifier; `tests/install/browser.mjs` is its actual standalone launcher (not merely an import returning exit 0). The launcher always uses its own root, named auth token, controller and isolated browser process; it blocks unapproved origins and later credentialed HTTP errors, allowing only the first anonymous bootstrap 401. It closes owned children and removes its temporary profile/caches.

Screenshots and bounded JSON evidence live only in the disposable fixture temporary directory. This still does **not** prove actual host telemetry, health, second-machine deployment, remote TLS, signing, OS service lifecycle or installer effects.
