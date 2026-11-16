# Implementation memory

## Scope and workflow

- User requested implementation of the full roadmap with coordinator-managed subagents, incremental commits and a problem/solution memory. First version skips the 1 Concierge + 3 Node Compose topology; deterministic single-node and direct protocol benchmarks have priority.
- Initial checkout on 2026-11-17 contains only design documents. `main` was clean and five documentation commits ahead of `origin/main`. Do not claim existing commits were pushed or external platforms were verified.
- Rust 1.99, Cargo 1.99, Node 24.21 and pnpm 12.10 are present. DSH Desktop's `desktop` profile is present, but no live Cordis inspect tools are exposed. Any host implementation must use the installed DSH sources and clearly distinguish logical/plugin tests from installed-host validation.

## Decisions

- 2026-11-17: implement protocol/domain in Rust and independently validated language-neutral JSON contract fixtures; TypeScript shares JSON fixtures rather than Rust ABI.
- 2026-11-17: bootstrap with Axum/Tokio and bundled rusqlite, Vue 3 + TypeScript, and a workspace-local installable plain ESM DSH bundle. Transport is explicit long-poll HTTP for the baseline, not falsely described as an outbound WebSocket.
- Keep user instruction, Task state, Grant, Assignment/Lease, Effect, structured Report, Artifact and view preferences separate. Client authentication is mandatory; no unauthenticated development bypass in production defaults.
- Default test fixtures use synthetic data and no Live LLM calls. Do not mutate the running DSH profile or real user projects during tests.

## Task ownership and integration checkpoints

- `agent-1` owns protocol/domain, Rust workspace root and JSON protocol fixtures. Do not commit; coordinator integrates.
- `agent-2` owns Vue app/root TS package files. `agent-3` owns TypeScript node client, installable DSH plugin and deterministic baseline. Neither may touch user runtime profiles.
- Coordinator owns Rust Concierge and bare node, integration, MEMORY/development documentation, final diff and commits.

## Verification journal / integration defects fixed

- Protocol child finished frozen Rust wire/domain work and 22 PASS (`cargo test -p loom-protocol --features fixture-signing`; 17 default); includes JSON fixture vectors, project-aware authorization, signatures, Report/Efffect semantics. No center/DSH claim.
- Web child delivered Vue workspace, 11 tests, typecheck/build PASS. Real browser, connected Rust HTTP, iOS/Android and accessibility not verified. First build error was read during concurrent file writing; stable repeated build PASS. UI root artifact mapping had to be explicit instead of structural guesses.
- Center initial implementation too aggressively coupled early HTTP wiring and new milestones; coordinator reduced scope to authenticated Ticket / Project / Node enrollment+polling / Report+Artifact/Effect / cancellation+fencing. Extra model, pipelines, learning interfaces are unvalidated prototypes and are not release-completion evidence.
- Important CLI bug: duplicate async runtime wrappers / bin include annotations prevented the actual process from running. Replaced with simple Rust library+small binary using one explicit Tokio runtime.
- Benchmark assertions that forgot `?` were corrected so every check propagates to nonzero exit. Do not print or accept PASS after ignored assertion.
- Registration negative check expected reused code rejection; missing token was later found to be the next heartbeat issue, not an evidence of successful bypass. Fixed benchmark assertion to also require non-200 and simplified token sanitization no credentials in stdout.
- DSH currently has no installed real-profile integration permission/results; maintain its bundle offline verification and do not call script workers actual DSH Sessions.

- Long route debugging lesson: server prefixes versus client paths must be diagnosed with exact non-secret outbound URL before changing server routes. The root 404 was Rust bench calling `/api/v1/heartbeat` rather than `/api/v1/nodes/heartbeat`; fixes were made in bench node request prefix and router uses single full-path declarations. Do not weaken route/middleware type checks or create overlapping route probes to guess this.
- Child reports: package `node-client` 6/6 and plugin 5/5 PASS, JS installed Schemastery check and bundled ESM apply-disabled. `SyntheticCoordinator` 9 scenarios passed but cannot substitute the real Rust integration results. DSH plugin manually installable only; actual profile install/activation/session/provider/cancel/reopen/credential integration remain TODO/NOT RUN.

- Critical credential bug found: recovery helper called `State::open(..., None)` silently regenerated an already initialized admin token, invalidating original token. Startup now refuses to refresh unknown existing credential without LOOM_CLIENT_TOKEN; benchmark restart explicitly provides original client token. New installations only issue once.
- Registration'is current default credentials are not DSH Credential Store. Explicit single-user first-run localhost baseline must receive auth at startup for non-LAN.
- Baseline's Grant input now supports array Task capabilities and stored Permission read/write. Read_write UI choice deliberately requires both; no implicit permission via capability or HTTP auth.
- Registry full file map artifact placement hash uses `loom://artifact/<UUID>` global index, controlled host path only separate from global URI. No arbitrary path download.

- Actual single-node integration was finalized: Synthetic9 + Real13 PASS. Real public errors from stale `NodeState.EMPTY` shared object were isolated by cloning initial state; source now has a seventh regression test. A local JSON shape root leak in diagnostics was fixed before final audit; do not trust partial PASS or narrative from either logger alone.
- Integration tests use isolated temporary project/token dirs and a foreground Rust child closed on finally. `scripts/verify-baseline.mjs` runs `runRealIntegration` by default, child exit status controls overall; no PENDING tolerated. DSH and real platforms still explicitly absent.
- Safe root solution: host declares mapping in heartbeat, administrator approves a precise binding row, grant pins binding digest+worker+installation; Node executor verifies both central binding root and actual operator configured root with realpath, rather than accepting arbitrary central cwd or Node self-reported access.
- Stable request replay: same (node,route,request)-persisted RFC attrs results are returned before lease/cancel gates; changed payload digest gets 409. Terminal tickets cannot be rewritten by a different Report. Changed artifacts never overwrite existing files: immutable bytes+lineage checked before exclusive first write, then transactional DB+audit.
- Startup schema reached v3 with persistent cancel_acknowledged. New DB initialization and existing older Schema migration are intentionally different paths. Register uses explicit `LOOM_CLIENT_TOKEN` not generate-if-missing.
- Severe edge closure: failed/late reports may not become success, known success cannot be replaced by failure text, completed Assignment no longer repolled into second success. valid early poll must not resurrect old terminal jobs; currently dispatchable ASG must run once and be filtered afterward.

## Open problems and resolutions

- Scope is large and includes actual hardware, platform-signed distribution and mobile verification. Proceed in evidenced increments rather than marking roadmap milestones complete from mocks, compilation or unit tests.
