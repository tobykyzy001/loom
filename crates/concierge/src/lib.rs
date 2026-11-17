//! Authenticated Loom control plane with a durable single-writer store.
#![forbid(unsafe_code)]
pub mod api;
mod command;
mod direct_offer;
mod install_plan;
pub mod inventory;
pub mod inventory_probe;
mod maintenance;
mod model_inventory;
mod model_observation;
mod node_api;
pub mod pipeline;
mod skill_replay;
pub(crate) mod store;

use anyhow::{bail, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use clap::{Parser, Subcommand};
use serde_json::Value;
use sha2::Digest;
use std::{fs, path::Path, path::PathBuf, sync::Arc};

#[derive(Parser)]
#[command(
    name = "loom",
    about = "Loom personal Agent fabric coordinator and bare node"
)]
pub struct Cli {
    #[arg(long, default_value = ".loom")]
    pub data_dir: PathBuf,
    #[command(subcommand)]
    pub command: Command,
}
#[derive(Subcommand)]
pub enum Command {
    Serve {
        #[arg(long, default_value = "127.0.0.1:8787")]
        listen: String,
        #[arg(long)]
        web_dir: Option<PathBuf>,
    },
    Smoke {
        #[arg(long)]
        directory: Option<PathBuf>,
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: String,
    },
    Doctor,
    Reconcile,
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}
pub fn sha256(bytes: impl AsRef<[u8]>) -> String {
    store::hex(sha2::Sha256::digest(bytes.as_ref()))
}
pub fn token() -> String {
    URL_SAFE_NO_PAD.encode(random32())
}
pub fn random32() -> [u8; 32] {
    let mut b = [0; 32];
    rand::RngCore::fill_bytes(&mut rand::rng(), &mut b);
    b
}
pub fn parse_time(text: &str) -> Result<chrono::DateTime<chrono::Utc>> {
    Ok(chrono::DateTime::parse_from_rfc3339(text)?.with_timezone(&chrono::Utc))
}
pub fn uuid(text: &str) -> Result<uuid::Uuid> {
    Ok(uuid::Uuid::parse_str(text)?)
}
pub fn required<'a>(body: &'a Value, field: &str, max: usize) -> api::ApiResult<&'a str> {
    body.get(field)
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty() && v.len() <= max)
        .ok_or_else(|| {
            api::ApiError::bad(format!("{field} must be nonempty and at most {max} bytes"))
        })
}
pub fn safe_relative(value: &str) -> Result<PathBuf> {
    loom_protocol::RelativePath::parse(value)?;
    Ok(Path::new(value).to_path_buf())
}
pub fn public_key_identity(
    encoded: &str,
    node_id: &str,
    installation: &str,
) -> Result<loom_protocol::NodePublicKey> {
    let key = loom_protocol::NodePublicKey::from_base64url(encoded)?;
    if key.node_id()?.as_str() != node_id {
        bail!("node identity does not match submitted public key")
    }
    loom_protocol::InstallationId::parse(installation)?;
    Ok(key)
}
pub fn signature(key: &loom_protocol::NodePublicKey, nonce: &str, signature: &str) -> Result<()> {
    key.verify_challenge(&loom_protocol::ChallengeNonce::parse(nonce)?, signature)?;
    Ok(())
}
pub fn main() -> Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run_cli())
}
async fn run_cli() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "loom_concierge=info".into()),
        )
        .init();
    let cli = Cli::parse();
    match cli.command {
        Command::Serve { listen, web_dir } => {
            let token = std::env::var("LOOM_CLIENT_TOKEN").ok();
            let state = api::State::open(cli.data_dir, token.as_deref())?;
            if token.is_none() && state.bootstrap_token_written {
                eprintln!("First-run administrative client token: {}\nStored only in the dedicated data directory; configure an authenticated client before exposing this service.",state.bootstrap_token);
            }
            let settings = state
                .store
                .lock()
                .map_err(|_| anyhow::anyhow!("store lock"))?
                .setting("listen");
            if settings.is_none() {
                state
                    .store
                    .lock()
                    .map_err(|_| anyhow::anyhow!("store lock"))?
                    .set_setting("listen", &listen)?;
            }
            api::serve(Arc::new(state), listen, web_dir).await?;
        }
        Command::Smoke { directory, listen } => command::smoke(directory, listen).await?,
        Command::Doctor => {
            let token = std::env::var("LOOM_CLIENT_TOKEN").ok();
            command::doctor(&cli.data_dir, token.as_deref()).await?
        }
        Command::Reconcile => command::reconcile(&cli.data_dir).await?,
    }
    Ok(())
}

#[cfg(test)]
mod skill_replay_regressions {
    use crate::store::{hash, Store};

    use rusqlite::params;
    use serde_json::{json, Value};

    struct Fixture {
        _temporary: tempfile::TempDir,
        store: Store,
        source_ticket: String,
        source_artifact: String,
        candidate: String,
        replay_ticket: String,
        _replay_artifact: String,
        _grant: String,
    }

    fn sample(_lines: &[&str]) -> (Vec<u8>, String) {
        let bytes = br##"{
  "schema": "loom.synthetic_summary.v1",
  "path": "input.txt",
  "byte_length": 75,
  "line_count": 3,
  "lines": [
    "Real isolated project input.",
    "No LLM, DSH host or network model was called."
  ]
}"##
        .to_vec();
        let sha = crate::sha256(&bytes);
        (bytes, sha)
    }
    fn fixture() -> Fixture {
        let temporary = tempfile::tempdir().unwrap();
        let store = Store::open(temporary.path()).unwrap();
        for (id, node, installation, worker, root) in [
            (
                "project-a",
                "node-a",
                "installation-a",
                "default",
                "/synthetic/a",
            ),
            (
                "project-b",
                "node-b",
                "installation-b",
                "other-worker",
                "/synthetic/b",
            ),
        ] {
            store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES(?1,?1,?2,'read_only',1,'2026-01-01T00:00:00Z',json_object())",params![id,root]).unwrap();
            store.conn().execute("INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'2026-01-01T00:00:00Z')",params![format!("binding-{id}"),id,node,installation,worker,root,hash(id)]).unwrap_or_else(|_| panic!("binding {id}"));
            store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES(?1,?2,?3,?4,?5,'[\"read\"]',1,?6,'2026-01-01T00:00:00Z',?7)",params![format!("grant-{id}"),id,node,worker,installation,hash(id),format!("binding-{id}")]).unwrap();
            store.conn().execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES(?1,?2,'not-a-secret','not-a-secret','online',?3,?4,?5,'2026-01-01T00:00:00Z',?6)",
                params![node,installation,serde_json::to_string(&vec![json!({"ticket_kind":"read_summary","permission":"read"})]).unwrap(),serde_json::to_string(&vec![json!({"worker_id":worker,"harness_kind":"local-fixture","profile_id":"isolated","status":"online"})]).unwrap(),json!({"project_roots":{id:root}}).to_string(),crate::now()]).unwrap();
        }
        let candidate = "candidate-a".to_owned();
        store.conn().execute("INSERT INTO candidates(id,kind,scope,content,source_refs,status,version,created_at,updated_at) VALUES(?1,'skill','project-a','{\"content\":\"Bounded exact read_summary\"}', '[\"tkt-a\"]', 'pending',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",[&candidate]).unwrap();
        let sample = sample(&[
            "Real isolated project input.",
            "No LLM, DSH host or network model was called.",
        ]);
        let source_ticket = "tkt-a".to_owned();
        let source_artifact = uuid::Uuid::new_v4().to_string();
        let replay_ticket = "tkt-replay".to_owned();
        let replay_artifact = uuid::Uuid::new_v4().to_string();
        for (ticket, assignment, artifact, bytes_sha) in [
            (&source_ticket, "asg-a", &source_artifact, &sample),
            (&replay_ticket, "asg-replay", &replay_artifact, &sample),
        ] {
            store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES(?1,'project-a','Real deterministic summary','read_summary','input.txt',NULL,'succeeded','grant-project-a',?2,'node-a','installation-a','default',1,0,?3,?3)",params![ticket,hash("project-a"),crate::now()]).unwrap();
            store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES(?1,?2,'node-a','default',1,?3,1,?4,?5)",params![assignment,ticket,format!("lease-{assignment}"),crate::now(),crate::now()]).unwrap();
            store.conn().execute("INSERT INTO reports(id,assignment_id,ticket_id,node_id,lease_epoch,request_id,state,summary,evidence,session_ref,cancel_acknowledged,created_at) VALUES(?1,?2,?3,'node-a',1,?4,'succeeded','actual worker summary','[]',NULL,0,?5)",params![format!("report-{assignment}"),assignment,ticket,format!("request-{assignment}"),crate::now()]).unwrap();
            store.conn().execute("INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at) VALUES(?1,?2,?3,'node-a','summary.json','application/json',?4,?5,?6,?7,'[]',?8)",params![artifact,ticket,assignment,bytes_sha.0.len(),bytes_sha.1,format!("{artifact}.artifact"),format!("loom://artifact/{artifact}"),crate::now()]).unwrap();
            std::fs::write(
                temporary
                    .path()
                    .join("artifacts")
                    .join(format!("{artifact}.artifact")),
                &bytes_sha.0,
            )
            .unwrap();
        }
        let definition = json!({"schema":"loom.skill-replay.v1","version":1,"operation":"read_summary","relative_path":"input.txt",
            "project_id":"project-a","node_id":"node-a","installation_id":"installation-a","worker_id":"default",
            "grant_id":"grant-project-a","grant_version":1,"grant_digest":hash("project-a"),"project_binding_id":"binding-project-a",
            "sample_digest":crate::skill_replay::sample_digest_from_bytes(&sample.0,"input.txt").unwrap(),"line_count":3,
            "source_ticket_id":&source_ticket,"source_artifact_id":&source_artifact});
        store.conn().execute("INSERT INTO skill_replays(candidate_id,source_ticket_id,source_artifact_id,grant_id,project_id,node_id,installation_id,worker_id,replay_ticket_id,replay_artifact_id,expected_sha256,expected_sample,sample_digest,status,definition_json,created_at,updated_at,verified_at) VALUES('candidate-a',?1,?2,'grant-project-a','project-a','node-a','installation-a','default','tkt-replay',?3,?4,?5,?6,'verified',?7,?8,?8,?8)",
            params![&source_ticket,&source_artifact,&replay_artifact,&sample.1,serde_json::to_string(&sample_json()).unwrap(),crate::skill_replay::sample_digest_from_bytes(&sample.0,"input.txt").unwrap(),definition.to_string(),crate::now()]).unwrap();
        Fixture {
            _temporary: temporary,
            store,
            source_ticket,
            source_artifact,
            candidate,
            replay_ticket,
            _replay_artifact: replay_artifact,
            _grant: "grant-project-a".into(),
        }
    }
    fn sample_json() -> Value {
        json!({"schema":"loom.synthetic_summary.v1","path":"input.txt","byte_length":75,"line_count":3,"lines":["Real isolated project input.","No LLM, DSH host or network model was called."]})
    }
    fn no_new_tickets(fixture: &Fixture) -> usize {
        fixture
            .store
            .query("SELECT id FROM tickets", [])
            .unwrap()
            .len()
    }

    #[test]
    fn raw_client_flag_does_not_save_skill_or_memory() {
        let fixture = fixture();

        if let Err(error) = crate::maintenance::review_candidate(
            &fixture.store,
            &fixture.candidate,
            &json!({"decision":"accept","replay_verified":true}),
        ) {
            panic!("real replay acceptance error: {error:#}");
        }
        assert_eq!(fixture.store.list("memories").unwrap().len(), 0);
        assert_eq!(
            fixture
                .store
                .query("SELECT * FROM skills", [])
                .unwrap()
                .len(),
            1
        );
        let updated = crate::maintenance::review_candidate(
            &fixture.store,
            &fixture.candidate,
            &json!({"decision":"accept"}),
        );
        assert!(updated.is_err());
        assert_eq!(
            fixture
                .store
                .query("SELECT * FROM skills", [])
                .unwrap()
                .len(),
            1
        );
        let undone = crate::maintenance::review_candidate(
            &fixture.store,
            &fixture.candidate,
            &json!({"decision":"undo"}),
        )
        .unwrap();
        assert_eq!(undone["status"], "pending");
        assert_eq!(
            fixture
                .store
                .query("SELECT * FROM skills", [])
                .unwrap()
                .len(),
            0
        );
        assert_eq!(no_new_tickets(&fixture), 2);
    }

    #[test]
    fn immutable_source_and_replay_scope_must_rederive_at_accept() {
        for (label,query) in [
            ("cross-project","UPDATE skill_replays SET project_id='project-b' WHERE candidate_id='candidate-a'"),
            ("worker","UPDATE skill_replays SET worker_id='other-worker' WHERE candidate_id='candidate-a'"),
            ("wrong-source","UPDATE skill_replays SET source_ticket_id='tkt-replay' WHERE candidate_id='candidate-a'"),
            ("copy-artifact","UPDATE skill_replays SET replay_artifact_id=source_artifact_id WHERE candidate_id='candidate-a'"),
            ("source-grant","UPDATE grants SET project_id='project-b' WHERE id='grant-project-a'"),
        ] {
            let fixture=fixture();
            fixture.store.conn().execute(query, []).unwrap();
            assert!(crate::maintenance::review_candidate(&fixture.store,&fixture.candidate,&json!({"decision":"accept"})).is_err(),"{label}");
            assert_eq!(fixture.store.query("SELECT * FROM skills", []).unwrap().len(),0,"{label}");
            assert_eq!(no_new_tickets(&fixture),2);
        }
    }

    #[test]
    fn wrong_root_worker_scope_rejects_new_replay_and_rolls_back_ticket() {
        let fixture = fixture();
        fixture
            .store
            .conn()
            .execute(
                "DELETE FROM skill_replays WHERE candidate_id='candidate-a'",
                [],
            )
            .unwrap();
        fixture.store.conn().execute("UPDATE project_bindings SET root_scope='/synthetic/other' WHERE id='binding-project-a'",[]).unwrap();
        assert!(crate::skill_replay::create_or_get(
            &fixture.store,
            &fixture.candidate,
            &json!({"source_ticket_id":fixture.source_ticket})
        )
        .is_err());
        assert_eq!(no_new_tickets(&fixture), 2);
    }

    #[test]
    fn failed_and_reconciling_reports_never_promote_skill() {
        let fixture = fixture();

        for (ticket_state, report_state, expected) in [
            ("failed", "failed", "failed"),
            ("reconciling", "unknown", "reconciling"),
        ] {
            fixture.store.conn().execute("UPDATE skill_replays SET status='awaiting_execution',replay_artifact_id=NULL WHERE candidate_id='candidate-a'",[]).unwrap();
            fixture
                .store
                .conn()
                .execute(
                    "UPDATE tickets SET status=?1 WHERE id=?2",
                    params![ticket_state, &fixture.replay_ticket],
                )
                .unwrap();
            fixture
                .store
                .conn()
                .execute(
                    "UPDATE reports SET state=?1 WHERE assignment_id='asg-replay'",
                    [report_state],
                )
                .unwrap();
            let state = crate::skill_replay::present(&fixture.store, &fixture.candidate).unwrap();
            assert_eq!(state["status"], expected);
            assert!(crate::maintenance::review_candidate(
                &fixture.store,
                &fixture.candidate,
                &json!({"decision":"accept"})
            )
            .is_err());
            assert_eq!(
                fixture
                    .store
                    .query("SELECT * FROM skills", [])
                    .unwrap()
                    .len(),
                0
            );
        }
        assert_eq!(no_new_tickets(&fixture), 2);
    }

    #[test]
    fn revoked_start_cannot_create_extra_ticket() {
        let fixture = fixture();
        fixture
            .store
            .conn()
            .execute(
                "DELETE FROM skill_replays WHERE candidate_id='candidate-a'",
                [],
            )
            .unwrap();
        fixture
            .store
            .conn()
            .execute(
                "UPDATE grants SET revoked_at='2026-01-01T00:00:00Z' WHERE id='grant-project-a'",
                [],
            )
            .unwrap();
        assert!(crate::skill_replay::create_or_get(
            &fixture.store,
            &fixture.candidate,
            &json!({"source_ticket_id":fixture.source_ticket})
        )
        .is_err());
        assert_eq!(no_new_tickets(&fixture), 2);
        assert!(crate::skill_replay::present(&fixture.store, &fixture.candidate).is_err());
    }

    #[test]
    fn legacy_memory_accept_still_returns_updated_row_and_real_record() {
        let temporary = tempfile::tempdir().unwrap();
        let store = Store::open(temporary.path()).unwrap();
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('p','p','/fixture','read_only',1,'2026-01-01T00:00:00Z',json_object())",[]).unwrap();
        store.conn().execute("INSERT INTO candidates(id,kind,scope,content,source_refs,status,version,created_at,updated_at) VALUES('memory','memory','p','{\"content\":\"Remember bounded fixture preference\",\"project_id\":\"p\"}','[]','pending',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",[]).unwrap();
        let updated =
            crate::maintenance::review_candidate(&store, "memory", &json!({"decision":"accept"}))
                .unwrap();
        assert_eq!(updated["status"], "accepted");
        assert_eq!(store.list("memories").unwrap().len(), 1);
        assert_eq!(store.query("SELECT * FROM skills", []).unwrap().len(), 0);
    }

    #[test]
    fn real_v6_snapshot_migrates_to_v7_without_rewriting_grant_artifact_or_audit() {
        let directory = tempfile::tempdir().unwrap();
        let db = rusqlite::Connection::open(directory.path().join("loom.sqlite3")).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;
            CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,root TEXT NOT NULL,mode TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,inventory TEXT NOT NULL);
            CREATE TABLE grants(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),node_id TEXT,worker_id TEXT,installation_id TEXT,operations TEXT,version INTEGER,digest TEXT,revoked_at TEXT,created_at TEXT);
            CREATE TABLE tickets(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),objective TEXT,kind TEXT,relative_path TEXT,content TEXT,status TEXT,grant_id TEXT REFERENCES grants(id),grant_digest TEXT,node_id TEXT,installation_id TEXT,worker_id TEXT,attempt INTEGER,created_at TEXT,updated_at TEXT);
            CREATE TABLE assignments(id TEXT PRIMARY KEY,ticket_id TEXT REFERENCES tickets(id),node_id TEXT,worker_id TEXT,attempt INTEGER,lease_id TEXT,lease_epoch INTEGER,lease_expires_at TEXT,created_at TEXT);
            CREATE TABLE artifacts(id TEXT PRIMARY KEY,ticket_id TEXT REFERENCES tickets(id),assignment_id TEXT,origin_node_id TEXT,name TEXT,media_type TEXT,size_bytes INTEGER,sha256 TEXT,storage_name TEXT,location TEXT,lineage TEXT,created_at TEXT);
            CREATE TABLE audits(sequence INTEGER PRIMARY KEY, ticket_id TEXT,actor TEXT,action TEXT,evidence TEXT,previous_hash TEXT,hash TEXT,created_at TEXT);
            PRAGMA user_version=6;
            INSERT INTO projects VALUES('p','p','/synthetic','read_only',1,'2026-01-01T00:00:00Z','{}');
            INSERT INTO grants VALUES('g','p','n','default','i','[\"read\"]',1,'d',NULL,'2026-01-01T00:00:00Z');
            INSERT INTO tickets VALUES('t','p','old','read_summary','README.md',NULL,'succeeded','g','d','n','i','default',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
            INSERT INTO assignments VALUES('a','t','n','default',1,'l',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
            INSERT INTO artifacts VALUES('00000000-0000-4000-8000-000000000015','t','a','n','s','application/json',1,'h',NULL,'loom://artifact/00000000-0000-4000-8000-000000000015','[]','2026-01-01T00:00:00Z');
            INSERT INTO audits VALUES(1,'t','migration','v6','{}','previous','hash','2026-01-01T00:00:00Z');").unwrap();
        drop(db);
        let store = Store::open(directory.path()).unwrap();
        let version: i64 = store
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 8);
        assert!(store
            .query("SELECT * FROM skill_replays", [])
            .unwrap()
            .is_empty());
        assert!(store.query("SELECT * FROM skills", []).unwrap().is_empty());
        assert_eq!(store.get("grants", "g").unwrap().unwrap()["digest"], "d");
        assert_eq!(
            store.get("tickets", "t").unwrap().unwrap()["status"],
            "succeeded"
        );
        assert_eq!(
            store
                .get("artifacts", "00000000-0000-4000-8000-000000000015")
                .unwrap()
                .unwrap()["sha256"],
            "h"
        );
        assert_eq!(
            store.query("SELECT * FROM audits", []).unwrap()[0]["hash"],
            "hash"
        );
    }

    #[test]
    fn every_bad_source_link_is_rejected_before_querying_worker() {
        let fixture = fixture();
        fixture
            .store
            .conn()
            .execute(
                "DELETE FROM skill_replays WHERE candidate_id='candidate-a'",
                [],
            )
            .unwrap();
        fixture
            .store
            .conn()
            .execute(
                "UPDATE tickets SET status='running' WHERE id=?1",
                [&fixture.replay_ticket],
            )
            .unwrap();
        let bad_sources = ["tkt-does-not-exist", &fixture.replay_ticket];
        for source in bad_sources {
            match source {
                "tkt-does-not-exist" => {}
                _ => {
                    fixture
                        .store
                        .conn()
                        .execute(
                            "UPDATE candidates SET source_refs=?2 WHERE id=?1",
                            params![fixture.candidate, json!([source]).to_string()],
                        )
                        .unwrap();
                }
            }
            assert!(crate::skill_replay::create_or_get(
                &fixture.store,
                &fixture.candidate,
                &json!({"source_ticket_id":source})
            )
            .is_err());
            assert_eq!(no_new_tickets(&fixture), 2);
        }
        fixture
            .store
            .conn()
            .execute("UPDATE tickets SET status='running' WHERE id='tkt-a'", [])
            .unwrap();
        assert!(crate::skill_replay::create_or_get(
            &fixture.store,
            &fixture.candidate,
            &json!({"source_ticket_id":fixture.source_ticket})
        )
        .is_err());
        assert_eq!(no_new_tickets(&fixture), 2);
        fixture
            .store
            .conn()
            .execute(
                "UPDATE tickets SET status='succeeded',grant_id='grant-project-a' WHERE id='tkt-a'",
                [],
            )
            .unwrap();
        fixture
            .store
            .conn()
            .execute(
                "DELETE FROM artifacts WHERE id=?1",
                [&fixture.source_artifact],
            )
            .unwrap();
        assert!(crate::skill_replay::create_or_get(
            &fixture.store,
            &fixture.candidate,
            &json!({"source_ticket_id":fixture.source_ticket})
        )
        .is_err());
        assert_eq!(no_new_tickets(&fixture), 2);
        fixture
            .store
            .conn()
            .execute(
                "UPDATE candidates SET kind='memory' WHERE id='candidate-a'",
                [],
            )
            .unwrap();
        assert!(crate::skill_replay::create_or_get(
            &fixture.store,
            &fixture.candidate,
            &json!({"source_ticket_id":fixture.source_ticket})
        )
        .is_err());
    }

    #[test]
    fn revoked_grant_before_first_accept_does_not_create_skill() {
        let setup = fixture();
        setup
            .store
            .conn()
            .execute(
                "UPDATE grants SET revoked_at=?1 WHERE id='grant-project-a'",
                [crate::now()],
            )
            .unwrap();
        assert!(crate::maintenance::review_candidate(
            &setup.store,
            setup.candidate.as_str(),
            &json!({"decision":"accept","replay_verified":true})
        )
        .is_err());
        assert_eq!(
            setup.store.query("SELECT * FROM skills", []).unwrap().len(),
            0
        );
        assert_eq!(
            setup
                .store
                .get("candidates", setup.candidate.as_str())
                .unwrap()
                .unwrap()["status"],
            "pending"
        );
        assert_eq!(
            crate::skill_replay::present(&setup.store, setup.candidate.as_str()).unwrap()["status"],
            "verified"
        );
        assert_eq!(no_new_tickets(&setup), 2);
    }

    #[test]
    fn revoked_binding_before_first_accept_does_not_create_skill() {
        let setup = fixture();
        setup
            .store
            .conn()
            .execute(
                "UPDATE project_bindings SET revoked_at=?1 WHERE id='binding-project-a'",
                [crate::now()],
            )
            .unwrap();
        assert!(crate::maintenance::review_candidate(
            &setup.store,
            setup.candidate.as_str(),
            &json!({"decision":"accept"})
        )
        .is_err());
        assert_eq!(
            setup.store.query("SELECT * FROM skills", []).unwrap().len(),
            0
        );
        assert_eq!(no_new_tickets(&setup), 2);
    }

    #[test]
    fn replay_assignment_lease_terminal_state_and_source_binding_are_required() {
        for query in [
            "UPDATE assignments SET node_id='other-node' WHERE id='asg-replay'",
            "UPDATE assignments SET worker_id='other-worker' WHERE id='asg-replay'",
            "UPDATE assignments SET attempt=3 WHERE id='asg-replay'",
            "UPDATE assignments SET lease_epoch=3 WHERE id='asg-replay'",
            "UPDATE assignments SET lease_expires_at='not-a-timestamp' WHERE id='asg-replay'",
            "UPDATE tickets SET status='running' WHERE id='tkt-replay'",
            "UPDATE tickets SET cancel_requested=1 WHERE id='tkt-replay'",
            "UPDATE candidates SET source_refs='[\"tkt-other\"]' WHERE id='candidate-a'",
        ] {
            let fixture = fixture();
            fixture.store.conn().execute(query, []).unwrap();
            assert!(
                crate::maintenance::review_candidate(
                    &fixture.store,
                    fixture.candidate.as_str(),
                    &json!({"decision":"accept"})
                )
                .is_err(),
                "{query}"
            );
            assert_eq!(
                fixture
                    .store
                    .query("SELECT * FROM skills", [])
                    .unwrap()
                    .len(),
                0
            );
            assert_eq!(no_new_tickets(&fixture), 2);
        }
    }

    #[test]
    fn verified_timestamp_does_not_become_a_new_execution_on_each_read() {
        let fixture = fixture();
        fixture.store.conn().execute(
            "UPDATE skill_replays SET verified_at='2026-01-01T00:00:00Z',grant_revocation_denied_at='2026-01-02T00:00:00Z',updated_at='2026-01-02T00:00:00Z' WHERE candidate_id=?1",
            [fixture.candidate.as_str()],
        ).unwrap();
        fixture
            .store
            .conn()
            .execute(
                "UPDATE grants SET revoked_at='2026-01-02T00:00:00Z' WHERE id='grant-project-a'",
                [],
            )
            .unwrap();
        let first =
            crate::skill_replay::present(&fixture.store, fixture.candidate.as_str()).unwrap();
        let second =
            crate::skill_replay::present(&fixture.store, fixture.candidate.as_str()).unwrap();
        assert_eq!(first["status"], "verified");
        assert_eq!(second["status"], "verified");
        assert_eq!(first["verified_at"], "2026-01-01T00:00:00Z");
        assert_eq!(second["verified_at"], "2026-01-01T00:00:00Z");
        assert_eq!(
            first["grant_revocation_denied_at"],
            second["grant_revocation_denied_at"]
        );
        assert_eq!(first["grant_revocation_denied_at"], "2026-01-02T00:00:00Z");
        assert_eq!(first["updated_at"], "2026-01-02T00:00:00Z");
        assert_eq!(second["updated_at"], "2026-01-02T00:00:00Z");
        assert_eq!(no_new_tickets(&fixture), 2);
    }
}
