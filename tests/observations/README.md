# Source-bound MemoryObservation and manual review test

This directory verifies a **narrow project-scoped MemoryCandidate lifecycle**, not automatic transcript listening, model-generated habits, or a general M5 runtime.

Run:

```sh
node tests/observations/candidates.mjs
node tests/observations/candidates.mjs --browser
cargo test -p loom-concierge observation -- --test-threads=1
```

The driver creates isolated projects and a real signed outbound Node registration, mappings and explicitly authorized read_summary Ticket references. It then uses the controller's normal authenticated `POST /api/v1/candidates` for **manual source selection**. A Source Ticket being real does not mean that its associated task completed. There is no assumption that manually submitting three references means a model recognized a preference.

## Proven contractual bounds

- Every observation requires the known real project, a supported kind, and one to 32 unique bounded source Ticket IDs. All source Tickets must actually be registered to the same project. Repeated references or repeated submission of the same Ticket do not inflate the observation count.
- A Memory projection (`loom.memory-candidate.v1` in its content) requires its explicit source refs. A source/count history is merged rather than replaced. After its recorded expiry, a subsequent fresh source begins a new bounded count; existing candidate history remains readable but the response does not call that another promotion. This is not a durable global learning claim.
- A separate, separately verified Skill candidate remains possible from a selected valid source before it runs the normal single deterministic `read_summary` replay. Without that real replay and distinct immutable Artifact SHA match, accepting it still fails. `tests/skills/read-replay.mjs` preserves the full original source→independent replay proof. A single or repeated Skill-observation POST is not execution by itself.
- A Memory review may only create one derived project Memory after a pending/postponed explicit accept. It attaches all source refs to a precise immutable `candidate_memory_links` relationship and attaches the earliest Ticket to the Memory. The schema tag is not a Grant or a learned-quality score.
- `never` is a distinct, reversible no-repeat suggestion status. `later` allows a later explicit review. An accepted Memory may not be silently rewritten by a later review decision; a repeated accept creates no second Memory. `route` cannot be accepted as a Memory, and an unknown kind cannot fall through an untyped `else` branch.
- Candidate undo and ordinary `DELETE /memories/{id}` use the **same exact-link transaction** for a linked Memory: delete its child link, then its exactly identified derived Memory, and return the candidate to pending, all-or-nothing. No observation history, Ticket, Artifact, Grant or working task is rolled back. An accepted legacy candidate without an exact link is read-only history through this special action; other unrelated Memory rows are not searched/deleted.
- The Memory edit endpoint honors explicit supported scope changes/known project IDs rather than silently discarding them. A linked Memory changed by direct manual editor keeps its original precise candidate link; the undo link targets only that unique derived Memory. This is not a cross-project evidence-transfer mechanism.

## Browser-only evidence

The `--browser` option opens a new **isolated Edge** context only against the local Vue+Rust fixture, authenticates with that fixture's client token and actually confirms both save and withdrawal in the existing ConfirmationDialog. It verifies exact PATCH decision bodies, the server-derived-link UI, **direct reload on the Memories page**, no leaked token in screenshots and a 390px viewport. It deliberately returns the pending state without making any new Grant/Ticket or running a model/worker. The local browser profile's local storage is cleared and its owned temporary profile is removed on exit. The narrow viewport is not a physical iOS/Android certificate.

## Exact migration and database validity

Schema 11 additively creates `candidate_memory_links`. It does not change the independent Skill replay protocol or previously stored model records. Existing `v6` migration tests preserve original Ticket/Artifact/Grant/audit facts. The full raw migration also retains older Model provenance, and v3/v7/v8/v9/v10→11 unit tests check that history can still be opened. Successful default Store creation at 11 must not be rejected by an old `>10` guard; unknown later versions are still refused.

The initial prototype's repeated SQL UPDATE was diagnosed with a minimal Store transaction test, not ignored. Under the current rusqlite binding/version, the numbered-placeholder update returned zero affected rows even though the equivalent row predicate found exactly one record. Explicit named SQL bindings have concrete DB/read-back evidence that both occurrence count and exact source union persist. No claim is made that this validates a different rusqlite release.

No real user/private transcript, production DSH Profile, OS credential provider, guild/team identity, arbitrary source-directory operation, new worker execution or remote/TLS experience is tested by this script. Its temp projects are explicit synthetic fixtures. Python only reads/adjusts that one owned SQLite fixture for the expiry scenario and simple integer reads; it does not grant permissions or interface with another provider. The HTTP driver always creates its own node identity and mappings, and tests no new authority is created.

## Review defects found and fixed

The first refactoring had to preserve the old legacy Memory fixture with no source tag (`source_refs:[]`) but cannot allow a new v1 source-bound projection to opt into that exception. Invalid/missing arrays, duplicate or object refs, and unsupported schema metadata are not shown as legacy evidence. Old accepted candidates without an exact association remain historical/read-only rather than arbitrarily guessed into an undo.

Independent review also identified the FK failure from the pre-existing direct Memory delete, missing candidate loading on direct Memories-page reload, and the old resource loader returning `undefined` despite all successful reads. All three have regression coverage. A mutation confirmation now requires a successful resource refresh to close; if the write has been accepted but the next read fails, the UI exposes that separate condition and leaves the stale state explicit.

This file documents the bounded evidence and failure gates only. Full editing of projects/users' preference scope, actual automatic HabitObservations, semantic summarization, automatic workflow induction, conflict resolution, batch history review, general route candidates, company/personal isolation, and speculative execution remain future milestones or explicitly NOT RUN.
