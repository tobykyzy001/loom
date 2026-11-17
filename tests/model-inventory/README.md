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

The additional `controller.mjs` fixture tests a real signed challenge/registration (never a fabricated Node bearer), forbids using administrator credentials on the Node channel, and reads only the authenticated API. It exercises an exactly shaped SDK-catalog input supplied as an explicit raw heartbeat fixture—**not** a real SDK in this separate test—then valid/error/disabled/latest-unknown/valid-again transitions. It also compares the response before/after actual Concierge reopen. It must never reinterpret the missing `/models` lifecycle route into an activation API; that route stays unimplemented. No SDK generation is called by this fixture. A successful result is recorded under its test-owned root as `controller-result.json`; any failed or undelivered compile/projection case is a failed verification, not a pass.

The `controller.mjs` covering projection depends on the controller's `RawCatalog` match returning a defined `Err` arm with a closed block; an undefined-value or bare-error snapshot may not be treated as matching behavior. The expected semantics are: parse missing → `missing_unknown` plus `model_catalog_missing` finding; malformed/extra keys/policy violation → `invalid_observation` plus `source_invalid`; valid empty models with a bounded finding remains fresh; known model with wrong `source`, `generation_observed`, modality, prepared flag or foreign names never becomes executable; raw node scope cannot select `shadow-worker`. Only `resource_state: adapter_observed` alongside `prepared_call_observed: true`, exact text/stub attributes, matching registered worker, `generation_observed: false` and four false policy flags produces `catalogued: true`. That metadata remains `activated: false`, `allowed: false`, `executable: false`. The controller doesn't execute or fetch a provider to reach this response.

The negative unit test guard (`node --test plugins/dsh-loom/test/model-inventory.test.js`) covers default refusal to access `ctx.llm`, malformed/foreign selectors (including `../../.ssh/credentials`), missing providers/models/API, incorrect model info, other modalities, missing source facts, worker mismatch and frozen cache. This doesn't claim a real DSH life cycle. The normal real proof validates only the currently supported narrow stub route; no real paid LLM, image generation, downloading, activation or arbitrary provider worker is called.

Helper documentation and raw shape: [`plugins/dsh-loom/MODEL_INVENTORY.md`](../../plugins/dsh-loom/MODEL_INVENTORY.md). The latest completed result is in that temporary run's `<root>/private/model-inventory-result.json`; a compile failure before launching DSH is **NOT RUN**, not PASS.

## Fleet read-only browser check

`node tests/model-inventory/browser.mjs` starts a separate real controller and a newly generated Ed25519 Node with an explicit enrollment, then makes a genuine authenticated heartbeat carrying the version 1 catalog associated with the already demonstrated SDK adapter information. In this separate step, Vue reads the **stored projection**; no generation dance is repeated. Entering the actual Devices page and an explicit user refresh each produce exactly one authenticated GET.

The browser verifies the Node/worker, exact text model, source/timestamps, context window and permission boundaries visible in the real Vue. `generation_observed`, `activated`, `allowed` and `executable` remain false. It issues no model POST, ticket or Grant and exposes no activate/download/run control. The section has only a read refresh; the separate equipment enrollment stays an independent action. A 390px viewport must keep node/catalog identifiers wrapped with no horizontal overflow. Only the first anonymous bootstrap 401 is expected; later credential-carrying errors and console errors fail the check.

`MODEL_INVENTORY_BROWSER_PASS` was observed together with `model-inventory-result.json`, `model-inventory-desktop.png` and `model-inventory-narrow.png` in its test-owned disposable root. Browser/Vite profiles/caches are removed after use. The UI is not itself pretending to be the SDK layer, and this is not a physical phone, live LLM quality check or general Model Registry.
