# Scoped parent/child Agent delegation — verified example

This is focused evidence for two **real, separately created DSH Agents** in one isolated temporary Profile. It is not a claim of general multi-Harness delegation, a physical second host, or arbitrary natural-language programming ability.

## Runtime scope

- `plugins/dsh-loom` defaults to `delegation_tools=unsupported` and refuses a task carrying `artifact_input`.
- Only the explicit `scoped_fixture` mode dynamically loads the named, already installed test package `@loom/dsh-fixture-stub-provider/delegation`. It is not an arbitrary import path, user tool name or production file-writer capability.
- The parent uses the zero-network `DeterministicAdapter` with an ordinary public inspect tool to read the synthetic `ORBITAL-731` fact. Its ordinary `assistant/message` Artifact, actual SDK session and ordinary `session_link` are persisted.
- The next stage can be requested only by the real current Grant/ProjectBinding and only when the parent Task has a valid completed source Artifact. The old `read_summary -> bounded text transform -> edit_file` phase relationship remains the only supported graph; this fixture maps its bounded child operation to an actual scoped HTML example.
- **No administrative client token is given to the Node or Agent.** The separate current-Assignment source endpoint `POST /api/v1/nodes/assignments/source` authenticates the Node and requires a current matching `valid_lease`. The center selects the exact existing immutable parent in this pipeline and confirms its bytes/hash, source Task status, kind, project and actual parent `session_link`. A submitted mismatched source is refused; the endpoint does not let a task query arbitrary other tickets, Sessions, project directories or grants.
- Child Agent creation uses DSH **0.2.2-rc.3** `ctx.agents.create({sessionId, meta:{cwd,parentSession,origin:'subagent'}, setup: async (...) => {...}, agentOptions})`. The setup registers only the fixture's explicitly scoped, no-path-parameter `loom_fixture_delegate_write`. It uses the constructor's verified `source_ref`, bytes and root; not a free-form model claim.
- `tool/call` and `tool/result` are actual public SDK events. The adapter preserves the specific parent UUID, source Ticket, origin/hash and exact parent Session. It then independently rechecks the real fixed `docs/delegated.html` within the ProjectBinding and actual output hash/size before sending its new Artifact and Effect. Parent source metadata does not itself become the child's authentication.
- The child's metadata has verified `artifact_ref` and `parents`, which the center turns into a single immutable lineage with the source ticket and the child `component_sha256`. The ordinary Node `/nodes/events` link also stores the real child SessionRef and `delegated_from` details in `messages.session_ref` under the actual child Ticket.
- If a tool says an effect may have occurred but evidence does not validate, the adapter preserves **unknown** evidence for reconciliation; it does not claim success or imply a rollback/no-effect.

## Exact command

```sh
node tests/harness/real-delegation.mjs
```

Record this run's exit code **0** with `overall: PASS`. No live model, reverse network control, paid provider request, real credential Store, current `desktop` profile data or untrusted user project was used. Temporary runtime root is cleaned up only by stopping its owned processes; its logs do not contain actual personal credentials.

## What passed

For the successful reference run:

1. Parent ticket `tkt_a27a5be45acb406da023597ea475e63e` produced original Artifact `6083c13b-bd92-4e46-887b-0b8edd087b74` with actual DSH Session `8505c8d3-bf46-49a6-a960-660870d37139`.
2. Child ticket `tkt_83cb6096269b46859483681a26e098f3` produced Artifact `5ee2c989-17df-451b-9520-b8360cb935e1` with separate child Session `e047a314-ee46-4c21-a094-85426409fd78`. The SDK's persisted Session header stored `parentSession: 8505c8d3-bf46-49a6-a960-660870d37139` and `origin: subagent`.
3. Original child HTML actually on disk matches `application/` retrieval. Its real independent SHA-256 is `420d3d5fcd9970ace42ba12abc63237361f55d783ff3db3130811d3b888baa52`. Its reported `loom_fixture_delegate_write` call ID was `loom-delegate-loom-stub-3`, with actual tool-result message ID `83e21078-b5d7-4a54-97f0-75ed0a561194`. Exactly one Effect and one linked Artifact were created.
4. The current Assignment's source proof exposed the correct immutable source bytes and actual parent Session. Requests with changed source SHA, foreign origin, unassigned artifact UUID, wrong parent ticket, wrong old lease or a client-only token were refused. No such request replaced the already verified output bytes.
5. Host was stopped and restarted using the persistent identity rather than a new enrollment code. It retained the same child mapping and the same file bytes; there was no second file Effect, arbitrary toolkit execution or fabricated historical `tool/call` event and no administrative Node/Client credential mixing.
6. The actual child session's `session_link` is retrievable through the authenticated filtered HTTP message route. Fixing this endpoint also stopped `GET /messages?ticket_id=...` from discarding all ticket-bound messages in favor of only the global conversation.

IDs above are evidence for that one execution and change with subsequent synthetic runs. The small isolated source-verification and scoped tool are not general service Discovery or a provider-agnostic M0/M6 certification. DSH without an explicit independently validated delegation capability must still **refuse** `artifact_input`. Bare host also rejects unvalidated source rather than silently executing a normal file write with missing provenance.

## Center-independent relation validation and optional view

The center also re-verifies `session_link.delegated_from` before persisting that ordinary event. It compares the claimed artifact UUID/ticket/origin/hash plus the claimed parent Session with the **realrelation selected by the current child Assignment and its pipeline**. Only then does the center store `source_verified: true` and `validated_by: current_assignment_and_pipeline_relation`. A caller merely supplying these flags does not get a badge: a wrong source or Session is rejected with a 4xx response and no Message row. The real delegation test now sends a forged event with the valid Node token, real child Assignment and changed source hash, and asserts that no extra Message is inserted.

The Web Collaboration tab keeps process messages collapsed by preference, and when expanded presents a compact, read-only relation: the parent Ticket, parent Artifact and two distinct public Session references. It is not a clickable arbitrary filesystem Resource Ref, not a claim of full Host transcript access and not new permission. `GET /messages?ticket_id=...` is an authenticated exact-ticket filter; general SQL database contents are not blindly exposed via a generic Session query.

This is presentation of center-verified immutable lineage, not authorization by the UI. A different `Assignment`, missing/`malformed` reference, private/unknown flag or non-artifact relation is not displayed as source validation. The production builds and 24 Web unit tests, real Edge 8-scenario flow and 390 viewport remain independent regressions, not another replacement for actual SDK evidence.

## Other real defects and corrections found by this probe

- `/pipelines/{id}/run` could recursively acquire a non-reentrant state mutex while holding the original Store guard, timing out. It now advances and returns the current pipeline using one lock. The ordinary document runner now exercises this explicit route as well.
- The public Agent `setup` must not directly return a tool disposer as the setup `commit()` callback. Tool output must have an explicit schema, not an optional string misuse.
- Tool results lost the custom source/session fields when normalized as legacy writes. Scoped delegation retains only their bounded source fields and independently requires all source/session references to match.
- Source-proof bytes and JSON text had to be decoded separately in the test. Thin protocol/storage artifacts must not be confused with their transport base64 or their derived HTML bytes.
- Test-host restarts do not necessarily re-emit the earlier `tool/call` events. Acceptance therefore compares the first live event capture, retained session mapping, report/artifact records and unchanged output instead of demanding a second historical tool event or fabricating any new effect.

## Still NOT RUN

Real paid/natural-language model quality, general agentic programming, production arbitrary filesystem APIs, physical multi-host/direct large-file transfer, Tauri/mobile, Windows/Linux installer/OS credentials, fully arbitrary workflow DAGs, multi-Harness exchanges and open ecosystem certification. This fixture is intentionally a narrow pattern to establish that **actual parent/child Agent execution, permission topology, byte provenance and visible delivery can agree**, not to claim that all future provider or Harness cases pass.
