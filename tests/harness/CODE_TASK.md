# Scoped source-code edit and real test Artifact

This is the service/test record for one **M0-sized programming example** on this macOS Host, not a general code-agent or plumbing pipeline contract.

## What actually ran

The offline harness installs the current source bundles only into a new temporary `loom-local-fixture` DSH Profile. The coordinator is another owned local Rust process. It receives an ordinary `edit_file` Ticket bound to the actual `write` Grant, a physical enrolled Node, its `ProjectBinding`, its registered project root, and a new Assignment/Lease. The default production plugin and its tools remain disabled.

The fixture project is a clean Git repository under an explicitly owned `loom-dsh-*` root (or its direct child project). It contains an intentionally incorrect function and `node:test` assertions. The initial real test run fails. A **real isolated DSH Agent** (zero-network `loom-stub` / `loom-stub-v1`, not a live provider) receives the ordinary assignment prompt and invokes two public, agent-scoped tools:

1. `loom_fixture_code_edit` – verifies the exact baseline and unique `return a - b;` fragment in `src/calc.js`, requires the initially clean Git working tree and the nonzero baseline test output, and atomically replaces only `src/calc.js` with the Ticket-approved expected full contents (`return a + b;`). It reports the actual previous/new hashes and baseline test result.
2. `loom_fixture_verify` – independently rechecks the actual output bytes/digest and the single changed tracked path, then runs `execFile(process.execPath, ['--test','test/calc.test.js'])` with `shell:false`, a minimal env including `ELECTRON_RUN_AS_NODE=1`, a 10-second deadline and bounded stdout/stderr.

These are public `ctx.agents.create({ setup })` and `ctx.tools.register` operations. The `setup` receives the **actual Agent Cordis context** as the first argument and its bounded ticket/root as the second. There is no invented wrapper context, global tool discovery, SDK service mock, or private DSH session event. Ordinary `tool/call`, `tool/result`, `assistant/message`, and `turn/end` events are captured with the coupling to the current Assignment and actual Session. Only the fixed fixture source body and `node --test test/calc.test.js` are supported. The file size limit is 32 KiB; no arbitrary test script, shell, provider, project-relative root substitution, remote fetch, git reset/stash/checkout, or unpinned command line is accepted.

## Evidence and outcome classes

For each successful source-edit Assignment, the adapter independently:

- locates the real current Assignment's source ToolCall and the corresponding later verification ToolResult, checks their bounded shapes, source path, sequence, matching SHA, original failing test baseline, and actual Session;
- rechecks the actual file type, link count, size and bytes under the exact ProjectBinding root (and rejects hardlinks/symlinks/out-of-root parents);
- reads **real** `git status`, `git show HEAD:<path>` and `git diff` using only bounded argument arrays and a cleaned environment. No user command or model-authored command is executed;
- confirms the baseline hash, expected content bytes in the Ticket, the one modified path, and a genuine unified `--- a/<path>` / `+++ b/<path>` diff with the one expected old/new fragment;
- delivers an immutable `code-change-<assignment>.diff` and an immutable `code-verification-<assignment>.json`. The verification includes the actual fixed command, target digest, output, passed/failed state, actual exit code, original failed-test exit, Session and source Artifact identifier;
- records one confirmed file Effect per Assignment, linked to the diff. The verification Artifact is report/test evidence, not a second write effect. It does not invent an `artifact_ref` parent: verification records the related source-change Artifact in its evidence, and `parents` in its metadata remains empty because this fixture doesn't create a trusted parent lineage of its own through that UUID alone.

### Public evidence and the actual client view

The coordinator now exposes a deliberately **small public tool-record projection** only for the two fixed fixture tool names. Checked upload metadata contributes `loom.code-provenance.v1`: tool/result identifiers, their sequence, fixed DSH Session reference and source path/digest (plus previous hash/byte count for the edit, or source Artifact UUID for verification). It does not return an entire private `metadata.evidence`, tool arguments, provider, environment, prompts, transcript or arbitrary command. Input records have strict fields and types; extra fields, bad sequences or a named malformed record fail rather than becoming public evidence. Replay cannot change that projection or add it retroactively to an already indexed Artifact.

Storage is additive schema 14: nullable `artifacts.code_evidence_json`. Parent lineage is unchanged; `source_change_artifact_id` is an evidence relation, not an invented parent. Before a normal code Report can be accepted, the center requires the *same two related Artifacts, current Assignment and physical origin Node*, the existing edit_file Ticket, exact target content SHA/size, actual saved verification bytes/hash, fixed command, Session and matching Effect. In this bounded path, a normal failed test retains a confirmed effect, but Unknown is not upgraded: its Effect stays unknown as required by the generic Report gate and the code never becomes an asserted overall success. A projection is not an oracle that Concierge itself ran Git or the test; it is validated authenticated Node-reported execution evidence. In the same Session, `change.result_seq` is strictly less than `verify.call_seq`, so a test cannot be moved before the edit that it claims to verify (the helper tests both reversed and shared-sequence negatives). Before the actual `report()` transaction, submitted Effect identities are additionally compared with existing records' Ticket, Assignment, physical Node, attempt, digest, status, evidence and Artifact references. Cross-Attempt reuse or changed identity facts is 409, not an `INSERT OR IGNORE` that silently loses the newly produced Effect. Identical existing unknown effects may be reconciled without duplicate insertion or an implicit status upgrade; duplicate IDs within one Report are also rejected.

The production `TicketDetail` viewer normalizes center `id` / `lineage` into its own artifact representation, checks the downloaded public projections, matching source/verification bytes, confirmed Effect and a definite matching Report, then offers:

- the real single-file unified diff with literal added/removed line colouring;
- the exact fixed `node --test test/calc.test.js`, source SHA, actual exit code and true passed/failed state for **that Attempt**, plus bounded stdout/stderr;
- the exact Assignment/Effect/source and verification Artifact associations. An older failed Attempt must not borrow the global latest Ticket success or another Session's effect.

Missing/corrupt/cross-Assignment evidence, incomplete downloaded source information, bad hashes, inconsistent command/Report/Effect or legacy Artifact without this public projection fall back to the original **unmodified raw text**, with a visible incomplete-relation note. There is no inferred success, additional Grant, automatic retry or new execution. Raw `<pre>` text remains available and HTML/test output is rendered by Vue as text, not executable markup.

### Nonzero real test after editing

A genuine completed `node:test` that returns nonzero is a **failed** Report, with the confirmed source file effect **retained**. This is not a rollback, a fabricated cancellation, a duplicate replay, or an unknown effect. No pretend "no changes happened" accompanies it. The old diff and failed test result stay immutable. An explicit retry is then another real Assignment and real attempt; the preceding history is not rewritten. The test driver explicitly prepares a clean known failing baseline between those attempts, which is not an automatic Agent rollback or a general rule that retry may ignore dirty worktrees.

### Tool/editor error or missing proof

An editor operation may have replaced a file and subsequently fail during a tool callback, its byte validation, Session writing or evidence joining. An error-only/invalid/mixed ToolResult is not safely known to be a refusal with zero effect. Such a source-edit result remains **unknown / reconciliation**, with no fresh source-effect certification or misleading "tool_rejection" claim. Missing or invalid verification also prevents a test-success claim. Structural errors are separate from a properly received completed-but-failed test result.

`isError` from the Host's public result and the adapter's `invalid_error` are not collapsed: a correctly structured actual test failure can be `failed` with retained effect, whereas an editor error/malformed record cannot be trusted to proved absence of file effects. These cases have their currentAssignment and `fixture_code_tools` checks again even if records superficially contain a familiar tool name. Code-task `turn/end(error)` additionally marks that a complete bounded-evidence review is required rather than immediately classifying an overall failed outcome. The complete `executeAssignment` path is unit-tested for an invalid edit followed by terminal error (stays unknown with no verified artifact) and a fully verified nonzero test followed by error (stays failed plus confirmed effect and its two Artifacts). Agent abnormality after a verified passing test is not sufficient to call overall work succeeded.

### Stop after a completed edit, before the fixed verification subprocess

The opt-in `LOOM_FIXTURE_CODE_PAUSE_BEFORE_VERIFY` scenario pauses **inside the real `loom_fixture_verify.execute` body, before it can start `node --test`**. The preceding `loom_fixture_code_edit` must already have completed successfully. A single SDK `tool/call` for the verifier can legitimately precede this pause; its ABORTED tool transport result is not a completed test. A successful structured `loom.fixture-code-verification.v1` record, by contrast, cannot be reclassified as if no test ever ran.

`DshAdapter.cancel()` records adapter-owned stop intent without mutating the controller's immutable Assignment input, calls the current Agent's genuine `agent.cancel({kind:'user'})`, and releases only that Assignment's bounded gate. The installed SDK supplies a real tool AbortSignal and a subsequent actual `turn/end` with `kind:'aborted'` and nested user cause, at a sequence later than the completed source-edit result. Releasing a gate is not itself an acknowledgement or proof of cancellation. Normal executions never enter this pause. This is an explicit fixture boundary, not a private session event, custom transcript state, generic `pre-step` middleware, or a promise to interrupt arbitrary tools or an already-running child process.

Cancellation intent is also kept while `ctx.agents.create()` is pending. It is rechecked on the same attached Agent before the Assignment's first model request; concurrent execution claims for one Assignment are refused. If that Agent is still idle and no model request was issued, the actual no-tool pre-start stop is preserved. If a pre-existing running Session has not yet received this Assignment's own followup, its other work is neither cancelled nor borrowed as this Assignment's acknowledgement. When this Assignment actually issued a followup through its bound running Agent, the native cancel waits for that same active turn's real user-aborted terminal, not a replacement Agent's same-ID result. Only then is a deadline armed. No observed SDK terminal within that bounded wait remains unknown and unacknowledged, with `expiredClaims` preventing late tool/turn/aborted events from changing the expiry record or causing another followup. An eligible terminal instead clears the deadline, pending intent and the one resolver explicitly. Session wrappers from another lookup cannot replace an attached Agent, claim its pending cancellation, erase its evidence or steal its waiter.

Each cancelled Report also includes one bounded `loom.code-stop-boundary.v1` observation in `report.evidence`, not a new Artifact or permission. It links the held verification ToolCall and its matching ABORTED ToolResult, exact source Artifact UUID, phase and the real user abort sequence in the same Session, after completed source edit. Center checks that boundary schema, the explicit pre-subprocess fixture Ticket marker, matching source identity and ordering. The center is **checking authenticated Node-reported SDK evidence**; it does not physically observe the SDK event loop or the host clock, and cannot certify the phase of an unrelated tool invocation in the abstract. The usual immutable Report request/digest and current Grant/Lease guards remain in force. Without this structured boundary or with a completed real test, the change-only certification is rejected instead of relabelled as a successful stop.

The narrow source-only Report retains one independently checked real diff and one confirmed source Effect, while **the overall Assignment stays `unknown` / `reconciling`**. It carries no verification Artifact and no invented test exit code or rollback. The center requires the durable Ticket stop intent and an actual explicit acknowledgement, which is stored only when `cancelled && report.cancel_acknowledged === true`. Neither the cancellation flag nor an ordinary unknown outcome creates that ack. Native SDK terminal observation is one-shot for the mapped Assignment Session; ordinary tool evidence still requires the exact live Session object, and code-bearing Agents are never reused/resumed for later source tasks.

To avoid making the retained diff impossible to submit, the ordinary cancelled-upload refusal has a **strict, evidence-only change exception**: the existing Ticket/Assignment/current Node, one matching `code-change-<assignment>.diff` payload, exact source bytes and hashes, expected Git diff bytes, actual `text/x-diff` media type, current origin and empty parents. It must also match the fixed source Ticket content and previous SHA. A wrong Ticket, origin, parent, SHA, extra file, or verification projection is refused; unrelated cancelled Artifact uploads and the general `unknown + confirmed Effect` promotion rule remain unchanged. The full Report separately rechecks its sole confirmed source Effect against those real bytes.

If proof is incomplete, the source edit or stop timing cannot be certified; producing a normal completed `Unknown Effect` for reconciliation is allowed, without a fake `session_ref` or file effect. Having an accepted cancellation acknowledgement alone never upgrades a source effect to confirmed. A reconciling Ticket's automatic retry is rejected by the existing controller (`400 invalid_request`), so the driver explicitly creates a legitimate new Ticket with the existing Grant rather than rolling back history. It gets a fresh Agent and Session and independently completes the real fixed test; the stopped Report, Effect ids, raw diff and source bytes remain unchanged on center and Host reopen.

### Session / configuration boundaries

- `fixture_code_tools` defaults to **false** and emits no code-tools setup until explicitly enabled for the isolated fixture, with the existing current write Grant, live Binding, permissions and admission checks. Dynamic importing is limited to exact optional test subpaths. Requiring a real installed fixture for this mode does not make it present in production bundles or a generic dependency.
- A reusable/externally addressed Session, or any code-bearing Agent reuse, is **not supported** by this first code slice. A fresh authorized Agent is required per code Assignment. Read-only reopening/report recovery from the same Concierge/Host, however, doesn't replay a completed assignment or manufacture another tool call.
- The script also requires only the deterministic `loom-stub`/`loom-stub-v1` model route. External Provider/model selectors are rejected, rather than hidden behind the fixture marker. There is no general LLM selection, prompt/tool authorization, direct local stock file editor permission, or paid provider assertion.
- Root/actor/Grant/Worker validation remains shared authority, not scope inferred from prompt content, tool labels, registration, or discovered data. Changing the Git root or attempting a symlink/hardlink escape doesn't pass that validation.
- Dirty tracked worktrees, passing/atypical baselines, duplicate/unknown paths, wrong target content, multiple edits, missing earlier edit results, and concurrent extra changes never count as this known-good example. Source/Test paths and consecutive tool use are both single-purpose and bounded.

## Exact reproduction commands

Only run real DSH steps with explicit explicit installation facts, never the actual user profile or credential discovery:

```sh
# Own Git fixtures and actual Git/Node test invocation, not Agent certification.
node tests/fixtures/code-tools.mjs

# Plugin unit tests, byte shape, errors, invalid scopes and ordinary compatibility.
pnpm --dir plugins/dsh-loom test

# Source-only packaged-boundary checks. This isn't an installation proof.
node tests/harness/bundle-preflight.mjs

# Real installation into a temporary isolated DSH profile, real Ticket/Tool/Artifact flow,
# failed test -> retained confirmed edit -> explicit retry -> real report/Artifact/Vue/recovery.
# Also: real stop before verification subprocess -> preserved diff/unknown/source effect -> new Task.
# Explicit external installation facts are required by the existing environment harness.
DSH_NODE_EXECUTABLE=<verified-runtime> \
DSH_INSTALL_DIR=<verified-install-root> \
LOOM_TEST_OUTPUT=<owned-output-directory>/result.json \
node tests/harness/real-code-task.mjs
```

`LOOM_TEST_OUTPUT` is an owned destination. It preserves `result.json` plus `result-desktop.png` and `result-narrow.png`. All other DSH state, browser profile, coordinator, project, Node data and its temporary root are specifically owned and removed after shutdown. The fixture-only pure tool test intentionally retains its plain owned Git samples for review; it neither creates nor requires a DSH profile. Existing parts of this harness already demonstrate cancellation and session resume in other task families; they are not replaced by this bounded code slice.

## Latest real proof

The final driver was executed repeatedly and exit 0, including one failing test followed by an explicitly retried passing **normal retry Ticket**. That historical Ticket retains **1 Ticket, 2 Assignments, 2 Reports, 2 confirmed effects, and 4 Artifacts** (one diff plus one verification per attempt). It actually downloaded those Artifacts through the real API and opened them with production Vue in the existing ticket UI, including independent diff SHA and source-target/test SHA verification. Its restored center and isolated DSH retain those source bytes, Session links and artifact/event counts without a second tool invocation after the recorded last sequence. The audit chain and SQLite integrity check also passed.

The **extended same process** now additionally verifies a genuinely completed source edit followed by real user cancellation before the fixed verifier's subprocess, and a separate new successful Ticket. Its full final counts are **3 Tickets, 4 Assignments, 4 Reports, 4 confirmed source effects, and 7 Artifacts**. Across those Tickets, the reconciling cancelled Ticket has one actual diff/one confirmed source Effect but no test Artifact, while ordinary successful retries retain their separate prior evidence. The driver verifies the real ABORTED/user turn and aborted verifier tool result, exact Git/source bytes and public projection, `cancel_acknowledged`, read-after-actual-restart, rejection of the old Ticket's automatic retry with no new Assignment, and no post-abort new tool calls. The final new Task succeeds in a different Assignment and Session without mutating stopped history.

Actual desktop detail width is 850px with 267px for Activity; a 390px desktop Edge viewport uses 346px-wide detail/Activity/Artifact containers without page-level horizontal overflow. Desktop Edge screenshots are not proof of iOS/Android, lock screen, physical backgrounding, untrusted remote access, or true mobile lifecycle.

## Explicitly not proven

This fixture does **not** prove general natural-language programming quality, arbitrary source editing, arbitrary command/root/tool use, completed review by another model, generic code Worktree/Pipeline semantics, remote/cooperative work, cloud/provider activation, real model use, multi-host operation, platform signatures/system credentials, physical phones or production-provider billing. It is a single real example of an authorized, scoped Agent changing real source code and producing an independently checked diff and test result on this machine. In particular, unknown outcome and failing tests are not interchanged; a pure tool/executor error isn't reclassified into a successful rewrite or a fabricated rollback.
