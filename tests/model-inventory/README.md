# Model inventory observation evidence

Run:

```sh
# Actual isolated real DSH SDK lookup and heartbeat producer
node tests/model-inventory/real-dsh.mjs

# Independent real Concierge challenge/signed Node heartbeat projection,
# negative transitions and persistence across a real server restart
node tests/model-inventory/controller.mjs
```

This is a real but **synthetic, isolated DSH SDK adapter observation**. It reuses `tests/harness/environment.mjs` to create a temporary HOME, DSH_HOME and `loom-local-fixture` Profile, copies the current `@loom/dsh-fixture-stub-provider` + `@loom/dsh-loom` bundle there and starts a temporary local Concierge. It does not read or change the current Desktop profile/credential store. The fixture's configured `model_text_tasks: true` opt-in is used only for exact `loom-stub`/`loom-stub-v1` public SDK adapter lookup, not model inference or provider installation.

Required checks:

1. The current DSH SDK returns one exact model resolved by `ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall` with sole text modality and a one-shot stream that **is not called**.
2. The authenticated node heartbeat carries one bounded `inventory.model_catalog` with `source: host_reported`, actual enrolled worker ID and `generation_observed: false`.
3. Project/root declarations remain from base `registrationFacts`; no node ID, installation ID, endpoint, prompt, credential or new actor is copied into model metadata.
4. `model-prepared` in the test-owned `private/fixture-control.jsonl` occurs once across repeated heartbeats; `request` count and ticket/model-Grant creation count are zero. Observation timestamp is retained rather than manufacturing a fresh current-generation proof each heartbeat.
5. `GET /api/v1/model-inventory` is a **required** independent read projection. Match the certified model by Node ID, installation ID, enrolled worker, exact provider/model, host-reported source and observation facts. Its `catalogued: true` controller output is distinct from raw input and never implies `activated`, `allowed`, `executable` or `generation_observed`, all of which are checked false. An unavailable or mismatched projection fails the proof.
6. The process cleans up the temporary DSH Host and Concierge on success or failure.

The additional `controller.mjs` fixture tests a real signed challenge/registration (never a fabricated Node bearer), forbids using administrator credentials on the Node channel, and reads only the authenticated API. It exercises an exactly shaped SDK-catalog input supplied as an explicit raw heartbeat fixture—**not** a real SDK in this separate test—then valid/error/disabled/latest-unknown/valid-again transitions. It also compares the response before/after actual Concierge reopen. The route check requires every unsupported invoke/activate/download attempt to be refused with no generation/runtime permission and all `activated/allowed/executable` flags false, not the old assumption that every `/models` route necessarily returns 501. The separate, real `model_descriptor` registration/retire lifecycle is implemented in `models/local-descriptor.mjs`; it is not a general provider or model activation service. No SDK generation is called by this fixture. A successful result is recorded under its test-owned root as `controller-result.json`; any failed or undelivered compile/projection case is a failed verification, not a pass.

The `controller.mjs` covering projection depends on the controller's `RawCatalog` match returning a defined `Err` arm with a closed block; an undefined-value or bare-error snapshot may not be treated as matching behavior. The expected semantics are: parse missing → `missing_unknown` plus `model_catalog_missing` finding; malformed/extra keys/policy violation → `invalid_observation` plus `source_invalid`; valid empty models with a bounded finding remains fresh; known model with wrong `source`, `generation_observed`, modality, prepared flag or foreign names never becomes executable; raw node scope cannot select `shadow-worker`. Only `resource_state: adapter_observed` alongside `prepared_call_observed: true`, exact text/stub attributes, matching registered worker, `generation_observed: false` and four false policy flags produces `catalogued: true`. That metadata remains `activated: false`, `allowed: false`, `executable: false`. The controller doesn't execute or fetch a provider to reach this response.

The negative unit test guard (`node --test plugins/dsh-loom/test/model-inventory.test.js`) covers default refusal to access `ctx.llm`, malformed/foreign selectors (including `../../.ssh/credentials`), missing providers/models/API, incorrect model info, other modalities, missing source facts, worker mismatch and frozen cache. This doesn't claim a real DSH life cycle. The normal real proof validates only the currently supported narrow stub route; no real paid LLM, image generation, downloading, activation or arbitrary provider worker is called.

Helper documentation and raw shape: [`plugins/dsh-loom/MODEL_INVENTORY.md`](../../plugins/dsh-loom/MODEL_INVENTORY.md). The latest completed result is in that temporary run's `<root>/private/model-inventory-result.json`; a compile failure before launching DSH is **NOT RUN**, not PASS.

## Actual stale heartbeat presentation and exact installation boundary

Run `pnpm --dir apps/web build && node tests/model-inventory/offline-heartbeat.mjs`.

A previous-online installation that stops heartbeat used to remain visually online because the web card and topbar treated self-reported `status: 'online'` as the current presence. `nodeOnline` now uses the controller-derived `online` whenever it is present; absence (offline/revocation/stale/missing time) contributes zero to the active count. If older/cached responses omit that field, the existing last-heartbeat and 90-second client staleness behavior remains a fallback. It does **not** manufacture a new connection measurement. `revoked_at` is explicitly distinct and never a revival.

The proof operates only on an owned isolated Root:

1. creates real Ed25519 identity + a signed single-use enrollment, declares `read_summary` capability only (not a Grant), has a normal authenticated heartbeat `online:true`, and verifies ordinary no-header reads are 401;
2. **stops the Concierge and heartbeat**, then modifies only this fixture's `last_heartbeat` to a fixed older RFC3339 timestamp. It leaves its original `status:'online'`, revocation, worker, inventory and registration intact, with transaction rollback and no other unknown record lookup. No actual user database/remote or edited DSH Profile is involved. `grants/tickets/assignments/artifacts` stay zero;
3. reopens the **same** SQLite dataDir, client token and loopback address, and gets truly `online:false`, `freshness:'stale_offline'`, `source:'host_heartbeat'` with the older absolute timestamp;
4. opens the built Vue in real Edge with the test token, verifying **offline card, zero active count, topbar offline, stale hint and original last heartbeat**—not a faked response. It resumes the same owned browser Profile at 390px, rechecks the saved credentials with a real protected read, and still observes no horizontal overflow or current-online assertion. A 390px desktop viewport is not a physical phone test;
5. performs a separately authenticated management `POST /nodes/{id}/revoke`, then issues an ordinary Node-protocol heartbeat using exactly the issued Node transport credential. Current code rejects it with actual `401 unauthorized`, so revoke is not confused with heartbeat aging. This is not a new general-purpose revoke helper or an implicit admin-token fallback into the Node transport.

Report: `/tmp/loom-node-staleness-proof.json`. The five checks include only public identifiers/timestamps and assertion names, never the actual client/node token, private key, full server object or auth payload. Anonymous-first login and admin-vs-Node credentials are kept distinct. Cleanup closes the owned preview/browser/controller and verifies the test-owned root before removing it; `LOOM_TEST_KEEP_EVIDENCE=1` deliberately retains its test artifacts for inspection.

This covers **one host's heartbeat projection and real desktop GUI**, including the former stale-node online-count bug. It is not a simulated physical network outage, a second physical Host, a mobile lifecycle, a real DSH-model/Remote Registry test or full M1 acceptance.

## Current trusted local hardware condition report

**Verified end to end (current macOS, one physical machine).** Run:

```sh
pnpm --dir apps/web build
node tests/model-inventory/image-capability.mjs
```

This is an opt-in **real hardware + real authenticated Node + real Concierge + real production Edge** proof. The browser **does not execute a probe, model, image generator, download, or an OS installer**. It only evaluates current conditions against an exact existing `read_summary` Grant/Binding/Worker/ProjectRoot, selected explicitly by the user.

The new command is separate from the UI and needs both the process opt-in and exact operator locality confirmation:

```sh
LOOM_ENABLE_LOCAL_HARDWARE_PROBE=1 cargo run --quiet --locked -p loom-concierge --bin loom -- \
  --data-dir <the-owned-controller-data-dir> inventory-probe \
  --node-id <registered-current-local-node-id> \
  --installation-id <the-exact-installation-id> \
  --inspector mac_system_profiler \
  --this-controller-host
```

`--this-controller-host` is a required **operator-selected-local instruction**, not cryptographic device attestation. The registered ID alone cannot prove that a remote/another physical Node is this current machine. Without it, disabled enablement, wrong identity/installation, or unrecognized inspector prevents the native fixed inspector and creates no trusted report/original registry mutation. No arbitrary executable, process PATH, profile directory, network target or OS shell is accepted. The existing five-second bound, 64KiB stdout/4KiB stderr and fixed Mac system-profiler arguments still apply.

The entire `loom.local-hardware-probe.v1` actual bounded DTO goes into server-owned `settings.hardware_probe:<node>:<installation>` with matching audit in **one transaction**. It carries `schema/node_id/installation_id/inspector/observed_at/facts/issues/source=controller_probed/permission_granted:false`, **not** raw stderr or profile contents. The original Node inventory/root/discovery/heartbeats/capabilities/other resources remain independent. Public Nodes/exact inventory/fleet endpoints and placement project the trusted record, never a caller-supplied `hardware_probe` field; a host-report cannot arbitrarily upgrade itself. If the controller has measured no memory (for example GPU-only probe), memory is unknown in this controller's scope, not an inferred “old host claim is enough.” Corrupt records fail closed rather than silently creating physical support.

The actual driver:

1. creates an actual challenge/signing Node identity in an isolated temporary directory and declares its exact project read capability;
2. rejects disabled, wrong Installation, missing `--this-controller-host` and executable-shaped inspector arguments before hardware inspection or changes;
3. calls the **actual fixed macOS system profiler** through the explicit CLI once, compares full returned DTO with the private settings and its audit, then checks the public scoped snapshot;
4. submits a real heartbeats with forged `controller_probed`, massive memory and `permission_granted:true`; verifies the trusted report/physical memory/waiting reasons stay genuine across `/nodes`, `/inventory` and `/placement/evaluate`; a normal valid heartbeat and workload `busy` are kept distinct;
5. reads a **real current read Grant** whose project binding/root/worker match, then assesses the explicit example **macOS/arm64/64GiB** request. In the actual proof, physical memory is **64,000,000,000 bytes = 59.6 GiB**, which is below **68,719,476,736 bytes = 64 GiB**; placement waits with `hardware_incompatible`. `hardware.os`/`hardware.arch` not captured by this bounded probe remain **unknown** rather than becoming fake certainty. This example budget is a declared **condition example**, not the minimum specification of a real image model;
6. opens the production UI, has to explicitly choose the single existing read Grant, then sees those genuine conditions plus `node_busy`/`worker_busy`. It states missing image model/runtime/actual output verification separately and labels controller facts **控制器实测**. The absence of a model catalogue or text-adapter observation is not silently replaced with credible text-model proof;
7. verifies 1280px/390px desktop layout (including a long Node reason wrap), protects read-only POST with the existing `run`401 handling and freshness/epoch gate, and persists the same probe after a same-data-dir, same-port, same-token controller restart. The same Edge session reloads and can see the identical observation time, not a new native probe.

No new Ticket/Grant/model activation/download/provider or generated image exists. Normal read requests for Ticket/model catalog are not counted as writes; final Ticket remains zero, original Grant count one, no extra hidden hardware probe. This driver uses actual Node/SDK **registration/transport plus Rust controller/local native CLI**, not a DSH profile installation or real paid model. The earlier `real-dsh.mjs` remains the separate bounded Stub adapter lookup proof; it is not reused as a real image model.

A separate real-workspace HTTP test, `apps/web/tests/capability-credentials.test.ts`, exercises a valid client credential → actual completed invalid-token 401 and `credentialState='required'` → no extra POST → valid reconnect. Ticket count stays zero. It does not replay a model or bypass stale authentication for a condition report. The test-only `.mjs` Concierge fixture typing is documented in `scripts/fixtures/rust-server.d.mts` and is not a production installer.

The retained result is `/tmp/loom-image-capability-proof.json`, bounded checks/viewports and primitive hardware measurements only (no `server`, `admin`, client/node token, secret key, raw profile or private model/provider stderr). Error paths redact actual test token values; browser profiles and temporary directories stop/delete after proof unless an explicitly requested owned debug directory is retained. They are never committed. Normal temporary-driver cleanup only removes that driver's own resolved isolated root.

**Not covered**: remote/second physical Host, physical-Host attestation, real image generation or quality, general model download/activation, real LLM/Provider/paid calls, real mobile lock/kill/network, Windows/Linux inspector, universal hardware budgets or a complete local Model Registry. Absence, unknown, offline/stale, busy and insufficient conditions remain distinct. This single vertical capability-evaluation report is **not full M1 acceptance**.



`node tests/model-inventory/browser.mjs` starts a separate real controller and a newly generated Ed25519 Node with an explicit enrollment, then makes a genuine authenticated heartbeat carrying the version 1 catalog associated with the already demonstrated SDK adapter information. In this separate step, Vue reads the **stored projection**; no generation dance is repeated. Entering the actual Devices page and an explicit user refresh each produce exactly one authenticated GET.

The browser verifies the Node/worker, exact text model, source/timestamps, context window and permission boundaries visible in the real Vue. `generation_observed`, `activated`, `allowed` and `executable` remain false. It issues no model POST, ticket or Grant and exposes no activate/download/run control. The section has only a read refresh; the separate equipment enrollment stays an independent action. A 390px viewport must keep node/catalog identifiers wrapped with no horizontal overflow. Only the first anonymous bootstrap 401 is expected; later credential-carrying errors and console errors fail the check.

`MODEL_INVENTORY_BROWSER_PASS` was observed together with `model-inventory-result.json`, `model-inventory-desktop.png` and `model-inventory-narrow.png` in its test-owned disposable root. Browser/Vite profiles/caches are removed after use. The UI is not itself pretending to be the SDK layer, and this is not a physical phone, live LLM quality check or general Model Registry.
