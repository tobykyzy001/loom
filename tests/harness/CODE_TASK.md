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

### Nonzero real test after editing

A genuine completed `node:test` that returns nonzero is a **failed** Report, with the confirmed source file effect **retained**. This is not a rollback, a fabricated cancellation, a duplicate replay, or an unknown effect. No pretend "no changes happened" accompanies it. The old diff and failed test result stay immutable. An explicit retry is then another real Assignment and real attempt; the preceding history is not rewritten. The test driver explicitly prepares a clean known failing baseline between those attempts, which is not an automatic Agent rollback or a general rule that retry may ignore dirty worktrees.

### Tool/editor error or missing proof

An editor operation may have replaced a file and subsequently fail during a tool callback, its byte validation, Session writing or evidence joining. An error-only/invalid/mixed ToolResult is not safely known to be a refusal with zero effect. Such a source-edit result remains **unknown / reconciliation**, with no fresh source-effect certification or misleading "tool_rejection" claim. Missing or invalid verification also prevents a test-success claim. Structural errors are separate from a properly received completed-but-failed test result.

`isError` from the Host's public result and the adapter's `invalid_error` are not collapsed: a correctly structured actual test failure can be `failed` with retained effect, whereas an editor error/malformed record cannot be trusted to proved absence of file effects. These cases have their currentAssignment and `fixture_code_tools` checks again even if records superficially contain a familiar tool name. Code-task `turn/end(error)` additionally marks that a complete bounded-evidence review is required rather than immediately classifying an overall failed outcome. The complete `executeAssignment` path is unit-tested for an invalid edit followed by terminal error (stays unknown with no verified artifact) and a fully verified nonzero test followed by error (stays failed plus confirmed effect and its two Artifacts). Agent abnormality after a verified passing test is not sufficient to call overall work succeeded.

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
# Explicit external installation facts are required by the existing environment harness.
DSH_NODE_EXECUTABLE=<verified-runtime> \
DSH_INSTALL_DIR=<verified-install-root> \
LOOM_TEST_OUTPUT=<owned-output-directory>/result.json \
node tests/harness/real-code-task.mjs
```

`LOOM_TEST_OUTPUT` is an owned destination. It preserves `result.json` plus `result-desktop.png` and `result-narrow.png`. All other DSH state, browser profile, coordinator, project, Node data and its temporary root are specifically owned and removed after shutdown. The fixture-only pure tool test intentionally retains its plain owned Git samples for review; it neither creates nor requires a DSH profile. Existing parts of this harness already demonstrate cancellation and session resume in other task families; they are not replaced by this bounded code slice.

## Latest real proof

The final driver was executed repeatedly and exit 0, with one failing test followed by an explicitly retried passing one. It produced **1 Ticket, 2 Assignments, 2 Reports, 2 confirmed effects, and 4 Artifacts** (one diff plus one verification per attempt). It actually downloaded those Artifacts through the real API and opened them with production Vue in the existing ticket UI, including independent diff SHA and source-target/test SHA verification. Its restored center and isolated DSH retain the source bytes, Session links and artifact/event counts without a second tool invocation after the recorded last sequence. The audit chain and SQLite integrity check also passed.

Actual desktop detail width is 850px with 267px for Activity; a 390px desktop Edge viewport uses 346px-wide detail/Activity/Artifact containers without page-level horizontal overflow. Desktop Edge screenshots are not proof of iOS/Android, lock screen, physical backgrounding, untrusted remote access, or true mobile lifecycle.

## Explicitly not proven

This fixture does **not** prove general natural-language programming quality, arbitrary source editing, arbitrary command/root/tool use, completed review by another model, generic code Worktree/Pipeline semantics, remote/cooperative work, cloud/provider activation, real model use, multi-host operation, platform signatures/system credentials, physical phones or production-provider billing. It is a single real example of an authorized, scoped Agent changing real source code and producing an independently checked diff and test result on this machine. In particular, unknown outcome and failing tests are not interchanged; a pure tool/executor error isn't reclassified into a successful rewrite or a fabricated rollback.
