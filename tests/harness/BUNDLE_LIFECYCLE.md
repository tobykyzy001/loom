# Real DSH bundle lifecycle in an isolated profile

## Purpose and boundary

`real-bundle-lifecycle.mjs` exercises the installed **DeepSeek Harness 0.2.2-rc.3** through the actual CLI and SDK interfaces under an owned temporary `DSH_HOME`; the only selected profile is `loom-local-fixture`. It is not a bundle preflight and not a simulator of a DSH process.

No `plugin_manager` action, Desktop state, existing credentials or user project is used. No Agent task, provider inference, billed model use or external web request is performed. The SDK `initialize` handshake using `deepseek-official`/`deepseek-flash` is only a model selection/adapter-generation check, not a claim of model provider availability or authority.

Run from the Loom repository root, with the verified installed Desktop runtime facts inherited:

```sh
node tests/harness/real-bundle-lifecycle.mjs
```

The runner writes a private, owner-only report to `/tmp/loom-bundle-lifecycle-result.json` and exits nonzero for unproven outcomes. It also reports its own temporary root, package versions, actual policy and revocation facts, never those tokens or private keys. No repository package/plugin source is edited by this test; only its isolated copies and patch overlay are changed.

## Actual successful run, after temporal revocation

The coordinator-verified run with exact `controller-support-only` worker role and single controlled shutdown completed with exit **0** and `overall: PASS` against temporary root `/var/folders/gp/y8z6514j1dq96j4q4tj6n_hc0000gn/T/loom-dsh-B5TNPz`:

1. **Real revocation before updating**: a controller-support Node was registered through the real Rust Concierge and given a read Grant rooted only in the synthetic project. That Grant was revoked through the HTTP API. Creating a read Ticket against it with the **same `controller-support-only` worker role as registration/binding** then failed with `grant_scope`. The support identity is explicitly **not a DSH Worker** and does not make Loom's disabled plugin authorized or executing. Wrong/default worker mismatch is not deliberately used to make the rejection easier.
2. **Actual package installation**: public `dsh plugin --profile loom-local-fixture add file:<package>` installed `@loom/dsh-loom@0.0.0`. The manifest/version and `0700` fixture roots were checked.
3. **Disabled workers while the actual Host is serialized**: the SDK was spawned with the same profile and a complete entry override of `allow_workers: false`, `executor: unsupported`. No model text, file effects, delegation or Agent creation were enabled. The public SDK handshake returned `deepseek-harness-sdk-runtime` and the real plugin printed `Disabled for execution: configure enabled, allow_workers, isolated directories and a verified executor explicitly.`. Node-state stayed empty and no DSH Session JSONL existed. SDK shutdown completed successfully.
4. **Wrong root is refused**: trying the reserved `desktop` profile directly at the CLI is refused by its launcher; the test does not scan and not mutate the running profile.
5. **Invalid replacement is rejected and restored**: a metadata-only package declaring an intended missing `cordis.missing.yml` bundle patch causes installation refusal. The old package manifest remain unchanged, showing no partial overwrite.
6. **Metadata-only update in the same profile**: an owned copy changed only `package.json` from 0.0.0 to 0.0.1 and its locale description (the `index.js` hash was compared too). The test used explicit public `dsh plugin remove` and `dsh plugin add` for the `file:` bundle, then package `why` inspection and a **real restart of the same SDK profile**. A new temporary directory is deliberately used for the replacement copy, so the lifecycle is not confused with an unversioned same-link edit. The installed manifest and dependencies show the new package. Worker effects still stayed disabled and absent.
7. **No revoked Grant revival**: after removal/re-add and SDK restart, the controller's same Grant `grant_364d209f1f42435b95b23a4817c48a30` still had `revoked_at: 2026-11-16T23:10:01.347268+00:00`, with unchanged digest `af12b6ef2d68e33e4dacd3cdb8c98f0ba5cf7d98c232e9e4afaac97be107bea1`. A second Ticket attempt against that exact same revoked Grant was again denied `grant_scope`; nothing produced a new read operation or source effect.

Measured shutdown: all owned SDK/Concierge children end successfully or are forcibly shutdown through bounded `finally` cleanup. The report and credentials-bearing Node data remain under the temporary owned roots, never bundled into repository source. `server.stop()` is called once by the runner (helpers also tolerate repeat closes). `tests/harness/runtime.mjs` now supports an optional initializeModel adapter choice so an isolated SDK handshake can select a public test adapter while older harnesses retain `loom-stub-v1` by default. The model selection is only the real SDK's runtime/generation handshake, not the actual provider call; actual Parent/Child and model-text tests still run using their public Stub route.

## Important limits

- `package_installed/updated` is not equal to `worker_registered`, `granted` or execution authorized. This scenario proves **registered installation state, SDK/apply behavior, metadata replacement, and revocation fencing**, not a trust grant. `dsh plugin` is used only in the isolated profile; no global plugin manager is invoked.
- The `remove`+`add` flow is deliberately selected and labelled for a local `file:` bundle. It is **not passed off** as the registry/Git update surface, online publication, GUI detail renderer or a hidden generic DSH update Manager call. Compile-ready and metadata-only source behaviors remain intentionally distinct.
- A registry-ready installed bundle is checked by actual `package.json`, live SDK process output and CLI config/tree, not by claiming a public browser plugin detail page exists in this minimal SDK. Browser GUI inventory needs separate exploration; this runner does not claim it. The original repository `plugins/dsh-loom/` remains unchanged by this lifecycle test.
- The controller-support node supplies real schema/Grant/revocation facts because worker-disabled DSH deliberately never enrolls. Its purpose is not to pretend actual DSH Agent registration, completion trust, or an additional authorized host. It never running a revoked job.
- Fresh worker-disable states create no client credentials, profile Sessions, Agent inference, effect ledger, or host-controlled ticket. A missing source index nor valid bundle patch isn't accepted merely because it lacks malicious content.
- This does not validate current desktop credential-store behavior, general model routing/registry/market installation, full code upgrades, billing/streaming, arbitrary plugins, second physical hosts, native TLS, task quality or all future M2+ milestones.

Diagnostics: a malformed root or unavailable installed runtime is reported as an exact failure, not converted into a passing scenario. Do not interpret an empty root log as proof; this runner separately checks the observed apply-disabled message, package manifests, current policy and side effects before reporting PASS.
