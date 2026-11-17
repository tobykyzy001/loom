# Observed DSH model adapter in a Node heartbeat

This is a **narrow, read-only SDK observation path**, not a model Registry lifecycle. `plugins/dsh-loom/lib/model-inventory.js` is a bounded projection of the already verified public `ctx.llm` surface, not a new plugin service, Client slot, private Host API, model-generation permission or provider automation framework.

## Wire contract

Only after a real `DshDispatcher` has completed its single opt-in lookup, the existing authenticated `POST /api/v1/nodes/heartbeat` may include `inventory.model_catalog`. `node_id` and `installation_id` never appear inside this object; the coordinator already binds the outer node identity from its authenticated enrollment record. `worker_id` is exactly the Worker ID in the same runner's current `workers` fact, not a name inferred from provider/model text.

```json
{
  "schema": "loom.model-inventory.v1",
  "revision": 1,
  "worker_id": "default",
  "lookup_source": "ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall",
  "source": "host_reported",
  "observed_at": "<UTC RFC3339 from completed lookup>",
  "models": [{
    "provider": "loom-stub",
    "model": "loom-stub-v1",
    "source": "host_reported",
    "observed_at": "<same UTC RFC3339>",
    "resource_state": "adapter_observed",
    "prepared_call_observed": true,
    "generation_observed": false,
    "input_modalities": ["text"],
    "context_window": 131072
  }],
  "findings": [{
    "state": "prepared_call_ready",
    "provider": "loom-stub",
    "model": "loom-stub-v1",
    "source": "host_reported",
    "observed_at": "<same UTC RFC3339>"
  }],
  "policy": { "install": false, "download": false, "activation": false, "generation": false }
}
```

`host_reported` is the outer Node's raw source. The Concierge may mark its independently validated, DSH-specific projection as `host_reported_dsh_adapter` without broadening the raw assertion. `catalogued` is optional; this implementation does not manufacture the extra field or a remote-download/local-install/hardware/URI claim. `context_window` is a positive safe integer described by the resolved model facts (normally `131072` tokens/context capacity in the fixture). It is not a file byte count or a host memory benchmark. Other unknown keys must not be tolerated in the raw entry—particularly tokens, endpoints, prompts, credentials, paths, API keys, `node_id` or `installation_id`.

## Reachable and inaccessible paths

- Configuration still requires enabled Host + `allow_workers` + DSH executor + **explicit `model_text_tasks: true`**. This flag now also permits the narrowly scoped adapter **inspection**; neither it nor this heartbeat implies an `invoke_text` Grant. Existing model-task execution remains separately authorized by `invoke_text`.
- The only positive metadata path is the explicitly configured synthetic zero-network provider/model `loom-stub`/`loom-stub-v1`. This is a deliberately controlled bounded proof target, not provider prefixes, wildcard support, generic provider availability, production `deepseek` support, model-name-based inference or an inferred catalog for other worker scopes.
- Actual lookup calls only existing `ctx.llm.listProviders()`, `listModels('loom-stub')`, `resolveModelInfo('loom-stub', 'loom-stub-v1')` and `prepareCall({provider:'loom-stub', model:'loom-stub-v1'})`. It validates the returned exact provider/model, sole text modality, one-shot `stream` function and bounded context. No invocation of that returned `stream`, `ctx.llm.stream`, API, network endpoint, SDK session Agent, CLI child, filesystem/Credential Store, provider installer or model runtime follows from inventory inspection.
- DSH's public LLM `prepareCall` binds an adapter generation and returns config plus one-shot callable. **Preparing that call is not consuming generation**. Consequently `generation_observed` stays false even though a usable adapter exists. `execution_observed`, output text, images, GPU weights/downloads, activation or availability for arbitrary requests are not claimed.
- Disabled or malformed/foreign wildcard selector produces an explicit empty finding rather than reading `ctx.llm`. Missing SDK functions, inconsistent returned facts, text+image or preparation error likewise produce an empty finding. Errors never add raw path/token/error text into the heartbeat. Pending/timeout `DshDispatcher` does not inherit a phantom prior SDK model.
- Bare/local nodes don't acquire this just because they support `read_summary`/`edit_file`, and files/skills/tools don't become Grants. There is no fallback model, installed-weights probe, activation or `/models` general registry implementation.

## Lifecycle / snapshot timing

`runLocalDshPlugin()` creates the existing runner and DSH dispatcher, then waits up to 5000ms for `initializeModelCatalog()` exactly once per new dispatcher, before starting its coordinator. Startup outer HTTP failure and disabled metadata path do not fabricate successes. The lookup itself is bounded; a timeout leaves an empty `lookup_unavailable` snapshot rather than delaying node enrollment forever. If the SDK eventually settles after expiration, its late metadata cannot silently promote that published not-ready snapshot to an active model. This metadata lookup isn't re-run by task builders or on every heartbeat; a later explicitly authorized model_task invocation has its existing, distinct `inspectTextRoute` permission check.

`DshDispatcher.registrationFacts(capabilities)` synchronously returns the base `LocalNodeRunner.registrationFacts()` merged with the cached snapshot. The `workers`, base `project_roots` and `harness_kind` fields are preserved, and a worker mismatch is refused. `CoordinatorLoop.pollCycle()` awaits that dispatcher hook if present, otherwise falls back to the existing base runner; it then performs the ordinary authenticated heartbeat unchanged. Repeated heartbeats hence carry the same observed facts and observation time until fresh DSH executor lifecycle setup, not a made-up recent/healthy model claim. No negative snapshot overwrites a prior last-known-good prepared record within the same cached lifecycle. Shutting down stops heartbeat rather than inventing a fresh activated/offline proof.

The cache is deep-frozen to prevent a later caller from raising `generation_observed`, embedding a provider Grant, or injecting its own `worker_id`; registering a Node isn't a grant to execute a model. Controller remains authoritative for rejecting missing/stale/inconsistent evidence and for returning `unknown` when the latest raw snapshot is absent or invalid.

## Actual local-only proof

```sh
node --test plugins/dsh-loom/test/*.test.js
node tests/model-inventory/real-dsh.mjs
```

The first command uses mocks only for negative/guard cases and does **not** establish a real mounted DSH. The second uses the repository's existing `fixtureRoot`, `isolatedEnv`, `installBundles` and `FixtureHost` with the no-network stub to install the **current source bundle in a new temporary HOME/DSH_HOME dedicated `loom-local-fixture` Profile**, starts a real Concierge and real DSH runtime, then reads back actual node raw metadata. It checks exactly one preparation, repeated heartbeats with the same cached snapshot and **zero request records**. It doesn't create a model ticket, `invoke_text` Grant or generated artifact. Enrollment and test tokens never appear in result metadata.

No real paid model, model downloads, external providers, image generation, uncredentialed remote calls or current `desktop` Profile changes are covered, nor is full lifecycle/persistence/service installation implied. The verified proof **must** also observe the matching record through `GET /api/v1/model-inventory`; a missing mapping fails rather than being converted into a pending pass. That read projection shows `host_reported` plus `read_source:authenticated_node_heartbeat`, not a false claim that the controller itself made a live SDK/provider call. It does not replace raw heartbeat authentication/evidence or model generation evidence. The proof is written only under the test temporary root.
