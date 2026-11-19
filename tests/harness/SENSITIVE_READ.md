# Sensitive process: bounded real read evidence

This M0 slice addresses a specific leak: ordinary DSH tool results could be echoed into assistant output and uploaded as an Artifact. It is a deterministic, fixed-source integration test, not automatic secret recognition or a general transcript-redaction guarantee.

## Scope being implemented

Only an authorized `read_summary` Task with `relative_path=input.txt` and the explicit `LOOM_FIXTURE_READ` objective enters this projection. The task must still have a valid current read Grant, ProjectBinding, Node/Installation/Worker and Lease. An objective marker or the path alone never grants access. Existing general DSH conversation behavior is preserved rather than relabeling every use of `input.txt` as this special proof.

The deterministic fixture tool reads one ordinary file directly under its authorized root: at most 4096 bytes, non-symlink, single-link regular file. The adapter independently reads that same source again and verifies its size and SHA against both registered `tool/call` and matching `tool/result` on the actual attached Session. It then constructs a small public Artifact containing only:

- `loom.read-source.v1`: logical `input.txt`, input byte length and input SHA;
- `loom.read-proof.v1`: the real tool, call/result identifiers, ordered event sequence, ordinary DSH Session id/protocol;
- `read_observed:true`, `raw_artifact_published:false`.

The public Artifact has no raw input bytes, objective-as-provenance, tool arguments, assistant transcript, tool result text, provider credentials or absolute paths. The summary is authoritative only about the fact checked by the adapter. The center does not read the Host's file or independently verify a remote SDK; it checks the authenticated Node's structured report against assignment identity and stored immutable Artifact bytes.

Schema 16 only adds nullable `artifacts.read_evidence_json`. Before **any first-write file creation or SQLite index**, the center uses `validate_read_artifact()` to decode the full bytes and compare the exact source/proof/session schema with the read projection. A correct read projection cannot publish arbitrary bytes, raw text, a secret Tool Argument, a fabricated Session, or an altered copy of the immutable DTO. A real HTTP attack with a fresh Artifact UUID, valid metadata and secret replacement bytes gets 400 and no Artifact file. Legacy `code_evidence_json` stays unchanged and not backfilled. The storage column is never exposed verbatim. Artifact details/downloads and Ticket responses publish the separately validated `read_evidence` object, with `read_evidence_json` omitted. `code_evidence_json` remains the unrelated source-change/verification namespace and cannot carry the read marker.

The Report requires the SessionRef carried by the existing `evidence` array. The original database `session_ref` column remains unchanged, as does ordinary assistant-artifact delivery and Session resume behavior. Proof generates no confirmed file Effect: reading is not writing and a plain GET still shows no confirmed operation by default. Unknown reading evidence retains an unknown effect and known SessionRef rather than a success summary.

## Actual verification on this macOS host

The following real driver passed against the installed **0.2.2-rc.5** DSH (original rc.3 evidence remains separately historical):

```sh
DSH_NODE_EXECUTABLE="$DSH_NODE_EXECUTABLE" \
DSH_INSTALL_DIR="$DSH_INSTALL_DIR" \
LOOM_TEST_OUTPUT=/tmp/loom-sensitive-read-proof.json \
node tests/harness/sensitive-read.mjs
```

`/tmp/loom-sensitive-read-proof.json` has `overall:PASS`. The driver runs the installed bundles in its own `loom-local-fixture` Profile, owned HOME/DSH_HOME and a zero-network deterministic adapter. It deliberately embeds a synthetic sensitive marker in the authorized source and makes the real DSH assistant echo that marker into its actual `session/event` and persisted `.v4.jsonl` history. That echo was independently observed, not assumed. The sibling marker is never read nor published.

The same driver then verifies:

- the full source hash/size and matching call/result identity, sequence and actual Session in the Report evidence; the original source text and narration are absent from center Ticket/Message/Audit/Artifact content;
- the expected single Report SessionRef and one immutable Artifact plus no confirmed File Effect for the requested read;
- the `read_evidence` object on actual Artifact downloads and Ticket details, without raw `read_evidence_json` storage fields;
- invalid authentication 401 and cross-Ticket Artifact access 403, a clone against `forbidden.txt` rejected 400, duplicate-without-evidence and duplicate-with-a-foreign-Session both rejected 409, and no metadata/Artifact replacement;
- actual production Vue with collaboration/expanded-process and audit tabs, the proof card's source path/SHA/Session and explicit no-raw-bytes explanation. Four screenshots separately cover collaboration, audit, proof display and a 390px **desktop viewport**. The viewport is not a phone or mobile lifecycle proof;
- completed Tickets before restart, then the actual same-identity Host and center reopen without another source call, another Report/Artifact, or rewriting the original proof. The separate normal Assignment finishing before that boundary is not confused with replay.

One independent review caught duplicate proof acceptance, a mixed read/code projection and an overly early Report sequence gap. All are now fenced: duplicate proof must match exactly; mixed code+read reads fail; Report Session host/protocol/Session must match and its `observed_seq` must be at least the ToolResult sequence. Rust handles DB strings as parsed internal objects, while external responses use explicit public names.

## Schema 15 → 16 migration through the protected read endpoints

`cargo test -p loom-concierge store::tests::v15_upgrade_is_additive_and_preserves_old_authority_and_bytes -- --exact --nocapture` adds a **route- and file-based** regression beyond checking a migrated Store row. It purposefully starts with schema 15's absent new proof column, existing project/grant/digest/Ticket, real artifact bytes and a historical audit, then reopens as schema 16.

- The normal project's `Ticket detail` and actual base64 Artifact download have `read_evidence:null`; original byte contents and original row/hash/digest remain the same, and the internal `read_evidence_json`/`code_evidence_json` names do not enter public responses.
- Requests with **no Authorization header** get a real 401 before Artifact access; they do not validate simply because an admin-token setting is present. `state::open` reuses that already-owned registration rather than replacing the client identity.
- **Non-object read storage** (`[]` in the test) and an invalid object with a different schema return actual **400 `invalid_request`**. A real initial failure showed that the Type TEXT conversion error could echo the storage column name through the otherwise-correct rejection. The public detail/download projection now converts such record/data incompatibilities into a fixed, generic error instead of echoing internal fields. The test forbids the original Artifact text and raw `_json` name in the entire error body.
- Mutating the file's bytes produces actual **409 `artifact_integrity`**, not a newly supplied read proof or a policy pass. Other missing-record/ticket ownership errors retain their distinct semantics.
- Nullable legacy proof and original bytes are restored as test-owned fixtures. Final full row/SHA/Grant/audit comparison confirms that the failed reads and tamper did not silently rewrite the previous authority.

This regression specifically demonstrates **old-record authorized reading and privacy-preserving error projection**. It is not a DSH installation/actuator test, another source-profile migration, mobile lifecycle, second Host or claim of full M0/M1 closure.



- No general secret detector, arbitrary Host DLP or guarantee over all Worker Transcripts. The proof is specific to this exact read fixture. Ordinary DSH conversations retain their existing assistant Artifact delivery behavior; new unknown markers are not proof of read success.
- No production Profile install/activation, host OS credential store, live provider/model calls, paid token cost, other Harness versions, or a claim that a controller observed the SDK directly instead of receiving a checked Node report.
- No physical second Host, cross-host artifact exchange, unrelated model lifecycle, arbitrary DAG, generic model or code-agent support.
- No iOS/Android device, lockscreen/kill/network-change approval, mobile background operation, real mobile authentication.
- No Linux/Windows installer, OS service management, signed update or remote deployment.
- No deferred 1 Concierge + 3 Nodes Compose test (intentionally skipped for this first version).
