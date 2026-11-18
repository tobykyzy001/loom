//! Single-writer SQLite persistence. Mistakes are returned, never converted to
//! an alternative fake request result.
use anyhow::{Context, Result};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn now() -> String {
    Utc::now().to_rfc3339()
}
// IDs are generated only by domain-specific factory methods in the application.
pub fn hex(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}
pub fn hash(value: &str) -> String {
    hex(Sha256::digest(value.as_bytes()))
}
pub fn same_secret(expected: &str, actual: &str) -> bool {
    constant_time_eq::constant_time_eq(expected.as_bytes(), actual.as_bytes())
}

pub struct Store {
    connection: Connection,
    pub root: PathBuf,
}
impl Store {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(root.join("artifacts"))?;
        let connection = Connection::open(root.join("loom.sqlite3"))?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;",
        )?;
        let store = Self { connection, root };
        store.migrate()?;
        Ok(store)
    }
    fn migrate(&self) -> Result<()> {
        let current: i64 = self
            .connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if current > 15 {
            anyhow::bail!(
                "database schema is from a newer Loom release (found {current}, supported 15)"
            )
        }
        if current == 0 {
            self.connection.execute_batch(r#"
            CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE challenges(id TEXT PRIMARY KEY,node_id TEXT NOT NULL,installation_id TEXT NOT NULL,public_key TEXT NOT NULL,nonce TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,used_at TEXT);
            CREATE TABLE enrollment_codes(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,used_at TEXT);
            CREATE TABLE nodes(id TEXT NOT NULL,installation_id TEXT NOT NULL,public_key TEXT NOT NULL,token_hash TEXT NOT NULL,status TEXT NOT NULL,revoked_at TEXT,capabilities TEXT NOT NULL,workers TEXT NOT NULL,inventory TEXT NOT NULL,registered_at TEXT NOT NULL,last_heartbeat TEXT,PRIMARY KEY(id,installation_id));
            CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,root TEXT NOT NULL UNIQUE,mode TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,inventory TEXT NOT NULL);
            CREATE TABLE grants(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),node_id TEXT NOT NULL,worker_id TEXT NOT NULL,installation_id TEXT NOT NULL,operations TEXT NOT NULL,version INTEGER NOT NULL,revoked_at TEXT,digest TEXT NOT NULL,created_at TEXT NOT NULL);
            CREATE TABLE tickets(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),objective TEXT NOT NULL,kind TEXT NOT NULL,relative_path TEXT NOT NULL,content TEXT,status TEXT NOT NULL,grant_id TEXT NOT NULL REFERENCES grants(id),grant_digest TEXT NOT NULL,node_id TEXT NOT NULL,installation_id TEXT NOT NULL,worker_id TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,cancel_requested INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE TABLE assignments(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),node_id TEXT NOT NULL,worker_id TEXT NOT NULL,attempt INTEGER NOT NULL,lease_id TEXT NOT NULL UNIQUE,lease_epoch INTEGER NOT NULL,lease_expires_at TEXT NOT NULL,acknowledged_at TEXT,created_at TEXT NOT NULL,cancelled_at TEXT,last_report_at TEXT);
            CREATE TABLE artifacts(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),assignment_id TEXT NOT NULL,origin_node_id TEXT NOT NULL,name TEXT NOT NULL,media_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,storage_name TEXT NOT NULL,location TEXT NOT NULL,lineage TEXT NOT NULL,created_at TEXT NOT NULL,code_evidence_json TEXT);
            CREATE TABLE reports(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL,ticket_id TEXT NOT NULL,node_id TEXT NOT NULL,lease_epoch INTEGER NOT NULL,request_id TEXT NOT NULL,state TEXT NOT NULL,summary TEXT NOT NULL,evidence TEXT NOT NULL,session_ref TEXT,cancel_acknowledged INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(assignment_id,request_id));
            CREATE TABLE effects(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),assignment_id TEXT NOT NULL,node_id TEXT NOT NULL,attempt INTEGER NOT NULL,input_digest TEXT NOT NULL,status TEXT NOT NULL,evidence TEXT NOT NULL,artifacts TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(id,node_id));
            CREATE TABLE requests(node_id TEXT NOT NULL,route TEXT NOT NULL,request_id TEXT NOT NULL,payload_digest TEXT NOT NULL,response TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(node_id,route,request_id));
            CREATE TABLE preferences(ticket_id TEXT PRIMARY KEY,expanded INTEGER NOT NULL,sender_filter TEXT,updated_at TEXT NOT NULL);
            CREATE TABLE memories(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),content TEXT NOT NULL,scope TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,source_ticket_id TEXT);
            CREATE TABLE messages(id TEXT PRIMARY KEY,ticket_id TEXT,sender TEXT NOT NULL,recipient TEXT,kind TEXT NOT NULL,content TEXT NOT NULL,session_ref TEXT,visibility TEXT NOT NULL,created_at TEXT NOT NULL,request_id TEXT,UNIQUE(ticket_id,request_id));
            CREATE TABLE IF NOT EXISTS project_bindings(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),node_id TEXT NOT NULL,installation_id TEXT NOT NULL,worker_id TEXT NOT NULL,root_scope TEXT NOT NULL,binding_digest TEXT NOT NULL,approved_at TEXT NOT NULL,revoked_at TEXT);
            ALTER TABLE grants ADD COLUMN project_binding_id TEXT;
            CREATE TABLE nodes_registry(id TEXT PRIMARY KEY,kind TEXT NOT NULL,source TEXT NOT NULL,inventory TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE TABLE models(id TEXT PRIMARY KEY,name TEXT NOT NULL,revision TEXT NOT NULL,location TEXT NOT NULL,placement_policy TEXT NOT NULL,status TEXT NOT NULL,approved_by TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE TABLE model_placements(id TEXT PRIMARY KEY,model_id TEXT NOT NULL REFERENCES models(id),node_id TEXT NOT NULL,location TEXT NOT NULL,status TEXT NOT NULL,reported_at TEXT NOT NULL);
            CREATE TABLE pipelines(id TEXT PRIMARY KEY,name TEXT NOT NULL,definition TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
            CREATE TABLE stages(id TEXT PRIMARY KEY,pipeline_id TEXT NOT NULL,ordinal INTEGER NOT NULL,depends_on TEXT NOT NULL,operation TEXT NOT NULL,input_digest TEXT NOT NULL,output_digest TEXT,status TEXT NOT NULL,artifacts TEXT NOT NULL);
            CREATE TABLE observations(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,scope TEXT NOT NULL,occurrences INTEGER NOT NULL,source_refs TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
            CREATE TABLE candidates(id TEXT PRIMARY KEY,kind TEXT NOT NULL,scope TEXT NOT NULL,content TEXT NOT NULL,source_refs TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
            CREATE TABLE audits(sequence INTEGER PRIMARY KEY AUTOINCREMENT,ticket_id TEXT,actor TEXT NOT NULL,action TEXT NOT NULL,evidence TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL,created_at TEXT NOT NULL);
            "#)?;
            self.connection.execute("PRAGMA user_version=3", [])?;
        }
        if current == 1 {
            self.connection.execute_batch("CREATE TABLE IF NOT EXISTS project_bindings(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),node_id TEXT NOT NULL,installation_id TEXT NOT NULL,worker_id TEXT NOT NULL,root_scope TEXT NOT NULL,binding_digest TEXT NOT NULL,approved_at TEXT NOT NULL,revoked_at TEXT);
            ALTER TABLE grants ADD COLUMN project_binding_id TEXT;
            PRAGMA user_version=3;")?;
        }
        if current == 2 {
            self.connection.execute_batch("ALTER TABLE reports ADD COLUMN cancel_acknowledged INTEGER NOT NULL DEFAULT 0; PRAGMA user_version=3;")?;
        }
        if current <= 3 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS document_pipeline_runs(
                    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),name TEXT NOT NULL,
                    definition_json TEXT NOT NULL,definition_digest TEXT NOT NULL UNIQUE,cancel_requested_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS document_pipeline_stages(
                    pipeline_id TEXT NOT NULL REFERENCES document_pipeline_runs(id),stage_id TEXT NOT NULL,
                    ticket_id TEXT UNIQUE REFERENCES tickets(id),raw_grant_id TEXT NOT NULL REFERENCES grants(id),
                    checkpoint_state TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
                    PRIMARY KEY(pipeline_id,stage_id)
                );
                PRAGMA user_version=4;"
            )?;
        }
        if current < 5 {
            self.connection.execute_batch("CREATE TABLE IF NOT EXISTS direct_offers(
                id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),lease_epoch INTEGER NOT NULL,
                artifact_id TEXT NOT NULL REFERENCES artifacts(id),origin_node_id TEXT NOT NULL,recipient_node_id TEXT NOT NULL,
                nonce TEXT NOT NULL UNIQUE,recipient_public_key TEXT NOT NULL,definition_json TEXT NOT NULL,
                created_at TEXT NOT NULL,UNIQUE(ticket_id,lease_epoch)
            ); PRAGMA user_version=5;")?;
        }
        if current < 6 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS model_observations(
                    artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id),
                    artifact_sha256 TEXT NOT NULL,
                    ticket_id TEXT NOT NULL REFERENCES tickets(id),
                    assignment_id TEXT NOT NULL,origin_node_id TEXT NOT NULL,
                    provider TEXT NOT NULL,model TEXT NOT NULL,
                    input_modalities TEXT NOT NULL,source TEXT NOT NULL,
                    execution_observed INTEGER NOT NULL,output_observed INTEGER NOT NULL,
                    not_live_llm INTEGER,grant_id TEXT NOT NULL REFERENCES grants(id),
                    operation TEXT NOT NULL,observed_at TEXT NOT NULL,
                    recorded_at TEXT NOT NULL,session_id TEXT,observation_kind TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS model_observations_ticket ON model_observations(ticket_id);
                PRAGMA user_version=6;"
            )?;
        }
        if current < 7 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS skill_replays(
                    candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),
                    source_ticket_id TEXT NOT NULL REFERENCES tickets(id),
                    source_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
                    grant_id TEXT NOT NULL REFERENCES grants(id),
                    project_id TEXT NOT NULL REFERENCES projects(id),
                    node_id TEXT NOT NULL, installation_id TEXT NOT NULL, worker_id TEXT NOT NULL,
                    replay_ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets(id),
                    replay_artifact_id TEXT UNIQUE REFERENCES artifacts(id),
                    expected_sha256 TEXT NOT NULL, expected_sample TEXT NOT NULL,
                    sample_digest TEXT NOT NULL, status TEXT NOT NULL,
                    reason TEXT, definition_json TEXT NOT NULL,
                    grant_revocation_denied_at TEXT,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, verified_at TEXT
                );
                CREATE INDEX IF NOT EXISTS skill_replays_source ON skill_replays(source_ticket_id,source_artifact_id);
                CREATE TABLE IF NOT EXISTS skills(
                    id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES candidates(id),
                    scope TEXT NOT NULL, kind TEXT NOT NULL, source_ticket_id TEXT NOT NULL REFERENCES tickets(id),
                    source_artifact_id TEXT NOT NULL REFERENCES artifacts(id), replay_ticket_id TEXT NOT NULL REFERENCES tickets(id),
                    replay_artifact_id TEXT NOT NULL REFERENCES artifacts(id), grant_id TEXT NOT NULL REFERENCES grants(id),
                    definition_json TEXT NOT NULL, proof_json TEXT NOT NULL, created_at TEXT NOT NULL
                );
                PRAGMA user_version=7;"
            )?;
        }
        if current < 8 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS install_plans(
                    id TEXT PRIMARY KEY, plan_json TEXT NOT NULL,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS install_targets(
                    plan_id TEXT NOT NULL REFERENCES install_plans(id), target_id TEXT NOT NULL,
                    target_json TEXT NOT NULL, updated_at TEXT NOT NULL,
                    PRIMARY KEY(plan_id,target_id)
                );
                PRAGMA user_version=8;",
            )?;
        }
        if current < 9 {
            // Old intentionally minimal v3–v8 snapshots may predate the
            // prototype model tables. Add those tables before inspecting cols.
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS models(id TEXT PRIMARY KEY,name TEXT NOT NULL,revision TEXT NOT NULL,location TEXT NOT NULL,placement_policy TEXT NOT NULL,status TEXT NOT NULL,approved_by TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
                 CREATE TABLE IF NOT EXISTS model_placements(id TEXT PRIMARY KEY,model_id TEXT NOT NULL REFERENCES models(id),node_id TEXT NOT NULL,location TEXT NOT NULL,status TEXT NOT NULL,reported_at TEXT NOT NULL);"
            )?;
            for (table, column) in [
                ("models", "node_id"),
                ("models", "installation_id"),
                ("models", "worker_id"),
                ("models", "project_id"),
                ("models", "source_ticket_id"),
                ("models", "source_artifact_id"),
                ("models", "descriptor_json"),
                ("models", "descriptor_sha256"),
                ("models", "source_kind"),
                ("model_placements", "grant_id"),
                ("model_placements", "binding_id"),
            ] {
                let present: i64 = self.connection.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info(?1) WHERE name=?2",
                    [table, column],
                    |row| row.get(0),
                )?;
                if present == 0 {
                    self.connection
                        .execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"))?;
                }
            }
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS model_placement_authorizations(
                    id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES models(id),
                    grant_id TEXT NOT NULL REFERENCES grants(id), grant_digest TEXT NOT NULL,
                    project_id TEXT NOT NULL REFERENCES projects(id), binding_id TEXT NOT NULL REFERENCES project_bindings(id),
                    node_id TEXT NOT NULL, installation_id TEXT NOT NULL, worker_id TEXT NOT NULL,
                    accepted_state TEXT NOT NULL, reviewed_model_digest TEXT NOT NULL, approved_at TEXT NOT NULL,
                    UNIQUE(model_id,grant_id)
                 );
                 PRAGMA user_version=9;",
            )?;
        }
        if current < 10 {
            // Schema 9 was experimental; inspect first so upgrading it (or an
            // already-columned prototype) is additive, idempotent and lossless.
            let present: i64 = self.connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('models') WHERE name='assignment_digest'",
                [],
                |row| row.get(0),
            )?;
            if present == 0 {
                self.connection
                    .execute_batch("ALTER TABLE models ADD COLUMN assignment_digest TEXT")?;
            }
            let source_id_present: i64 = self.connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('models') WHERE name='source_assignment_id'",
                [],
                |row| row.get(0),
            )?;
            if source_id_present == 0 {
                self.connection
                    .execute_batch("ALTER TABLE models ADD COLUMN source_assignment_id TEXT")?;
            }
            self.connection.execute_batch("PRAGMA user_version=10")?;
        }
        if current < 11 {
            self.connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS candidate_memory_links(
                candidate_id TEXT PRIMARY KEY REFERENCES candidates(id),
                memory_id TEXT NOT NULL UNIQUE REFERENCES memories(id),
                source_refs TEXT NOT NULL,
                created_at TEXT NOT NULL
            ); PRAGMA user_version=11",
            )?;
        }
        if current < 12 {
            let tx = self.connection.unchecked_transaction()?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS source_instances(
                    id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, source_key TEXT NOT NULL,
                    kind TEXT NOT NULL, label TEXT, definition_digest TEXT NOT NULL,
                    last_sequence INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    UNIQUE(owner_key,source_key)
                );
                CREATE TABLE IF NOT EXISTS source_threads(
                    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_instances(id),
                    client_thread_id TEXT NOT NULL, last_sequence INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    UNIQUE(source_id,client_thread_id)
                );
                CREATE TABLE IF NOT EXISTS source_events(
                    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_instances(id),
                    thread_id TEXT NOT NULL REFERENCES source_threads(id),
                    external_event_id TEXT NOT NULL, kind TEXT NOT NULL,
                    content TEXT NOT NULL, payload_digest TEXT NOT NULL,
                    ticket_id TEXT REFERENCES tickets(id), occurred_at TEXT, received_at TEXT NOT NULL,
                    source_sequence INTEGER NOT NULL, thread_sequence INTEGER NOT NULL,
                    UNIQUE(source_id,external_event_id),
                    UNIQUE(source_id,source_sequence),
                    UNIQUE(thread_id,thread_sequence)
                );
                CREATE INDEX IF NOT EXISTS source_events_thread_order ON source_events(thread_id,source_sequence);
                CREATE TABLE IF NOT EXISTS source_event_cursors(
                    id TEXT PRIMARY KEY, owner_key TEXT NOT NULL,
                    source_id TEXT NOT NULL REFERENCES source_instances(id),
                    thread_id TEXT NOT NULL REFERENCES source_threads(id),
                    after_sequence INTEGER NOT NULL, schema TEXT NOT NULL, created_at TEXT NOT NULL
                );",
            )?;
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS messages(
                    id TEXT PRIMARY KEY,ticket_id TEXT,sender TEXT NOT NULL,recipient TEXT,kind TEXT NOT NULL,
                    content TEXT NOT NULL,session_ref TEXT,visibility TEXT NOT NULL,created_at TEXT NOT NULL,
                    request_id TEXT,source_event_id TEXT REFERENCES source_events(id),
                    UNIQUE(ticket_id,request_id)
                );",
            )?;
            let messages_present: i64 = tx.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages'",
                [],
                |row| row.get(0),
            )?;
            let column_count: i64 = if messages_present == 1 {
                tx.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('messages') WHERE name='source_event_id'",
                    [],
                    |r| r.get(0),
                )?
            } else {
                1
            };
            if messages_present == 1 && column_count == 0 {
                tx.execute("ALTER TABLE messages ADD COLUMN source_event_id TEXT REFERENCES source_events(id)", [])?;
            }
            tx.execute("PRAGMA user_version=12", [])?;
            tx.commit()?;
        }
        if current < 13 {
            let tx = self.connection.unchecked_transaction()?;
            for (column, definition) in [
                ("task_ticket_id", "TEXT"),
                ("task_digest", "TEXT"),
                ("creation_kind", "TEXT NOT NULL DEFAULT 'unbound'"),
                ("task_spec_json", "TEXT"),
            ] {
                let exists: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('source_events') WHERE name=?1",
                    [column],
                    |r| r.get(0),
                )?;
                if exists == 0 {
                    tx.execute(
                        &format!("ALTER TABLE source_events ADD COLUMN {column} {definition}"),
                        [],
                    )?;
                }
            }
            tx.execute_batch(
                "CREATE TABLE IF NOT EXISTS source_work_specs(
                   event_id TEXT PRIMARY KEY REFERENCES source_events(id),
                   task_ticket_id TEXT NOT NULL UNIQUE REFERENCES tickets(id),
                   spec_json TEXT NOT NULL UNIQUE, digest TEXT NOT NULL UNIQUE,
                   created_at TEXT NOT NULL
                 );
                 CREATE UNIQUE INDEX IF NOT EXISTS source_events_one_task ON source_events(task_ticket_id) WHERE task_ticket_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS source_task_valid
BEFORE UPDATE OF task_ticket_id,task_digest,task_spec_json,creation_kind ON source_events
FOR EACH ROW WHEN NOT (NEW.task_ticket_id IS NULL AND NEW.creation_kind='unbound' AND NEW.task_digest IS NULL AND NEW.task_spec_json IS NULL) BEGIN
 SELECT RAISE(ABORT,'source_task_fields_required') WHERE NEW.task_ticket_id IS NULL OR NEW.task_digest IS NULL OR NEW.task_spec_json IS NULL OR NEW.creation_kind<>'explicit_task_created_after_intake';
 SELECT RAISE(ABORT,'source_task_ticket_mismatch') WHERE NOT EXISTS(
  SELECT 1 FROM tickets WHERE id=NEW.task_ticket_id AND kind='read_summary' AND content IS NULL
  AND grant_id=json_extract(NEW.task_spec_json,'$.grant_id') AND grant_digest=json_extract(NEW.task_spec_json,'$.grant_digest')
  AND node_id=json_extract(NEW.task_spec_json,'$.node_id') AND installation_id=json_extract(NEW.task_spec_json,'$.installation_id')
  AND project_id=json_extract(NEW.task_spec_json,'$.project_id') AND worker_id=json_extract(NEW.task_spec_json,'$.worker_id')
  AND objective=json_extract(NEW.task_spec_json,'$.objective') AND relative_path=json_extract(NEW.task_spec_json,'$.relative_path'));
 SELECT RAISE(ABORT,'source_event_spec_mismatch') WHERE NEW.kind<>'user_message'
  OR NEW.id<>json_extract(NEW.task_spec_json,'$.source_event_id') OR NEW.content<>json_extract(NEW.task_spec_json,'$.objective')
  OR NEW.payload_digest<>json_extract(NEW.task_spec_json,'$.event_request_digest') OR NEW.task_digest<>json_extract(NEW.task_spec_json,'$.digest');
 SELECT RAISE(ABORT,'source_work_spec_missing') WHERE NOT EXISTS(
  SELECT 1 FROM source_work_specs WHERE event_id=NEW.id AND task_ticket_id=NEW.task_ticket_id AND spec_json=NEW.task_spec_json AND digest=NEW.task_digest);
END;
CREATE TRIGGER IF NOT EXISTS source_task_no_rebind
BEFORE UPDATE OF task_ticket_id,task_digest,task_spec_json,creation_kind ON source_events
FOR EACH ROW WHEN OLD.task_ticket_id IS NOT NULL OR OLD.task_digest IS NOT NULL OR OLD.task_spec_json IS NOT NULL OR OLD.creation_kind<>'unbound' BEGIN
 SELECT RAISE(ABORT,'bound_source_task_is_immutable');
END;
CREATE TRIGGER IF NOT EXISTS source_event_identity_immutable
BEFORE UPDATE OF source_id,thread_id,external_event_id,kind,ticket_id,content,payload_digest,occurred_at,received_at,source_sequence,thread_sequence ON source_events BEGIN
 SELECT RAISE(ABORT,'source_event_identity_is_immutable');
END;
CREATE TRIGGER IF NOT EXISTS source_work_specs_no_update BEFORE UPDATE ON source_work_specs BEGIN
                   SELECT RAISE(ABORT,'source_work_spec_immutable');
                 END;
                 CREATE TRIGGER IF NOT EXISTS source_work_specs_no_delete BEFORE DELETE ON source_work_specs BEGIN
                   SELECT RAISE(ABORT,'source_work_spec_immutable');
                 END;",
            )?;
            tx.execute("PRAGMA user_version=13", [])?;
            tx.commit()?;
        }
        if current < 14 {
            // This optional public projection is populated only by the existing,
            // authenticated Artifact upload path after strict evidence validation.
            // In particular, legacy raw metadata is never scanned for backfill.
            let column_present: i64 = self.connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('artifacts') WHERE name='code_evidence_json'",
                [],
                |row| row.get(0),
            )?;
            let tx = self.connection.unchecked_transaction()?;
            if column_present == 0 {
                tx.execute(
                    "ALTER TABLE artifacts ADD COLUMN code_evidence_json TEXT",
                    [],
                )?;
            }
            tx.execute("PRAGMA user_version=14", [])?;
            tx.commit()?;
        }
        if current < 15 {
            let column_present: i64 = self.connection.query_row(
                "SELECT COUNT(*) FROM pragma_table_info('tickets') WHERE name='priority'",
                [],
                |row| row.get(0),
            )?;
            let tx = self.connection.unchecked_transaction()?;
            if column_present == 0 {
                tx.execute(
                    "ALTER TABLE tickets ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN -100 AND 100)",
                    [],
                )?;
            }
            tx.execute("PRAGMA user_version=15", [])?;
            tx.commit()?;
        }
        Ok(())
    }
    pub fn conn(&self) -> &Connection {
        &self.connection
    }
    pub fn conn_mut(&mut self) -> &mut Connection {
        &mut self.connection
    }
    pub fn setting(&self, key: &str) -> Option<String> {
        self.connection
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .unwrap_or(None)
    }
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.connection.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value])?;
        Ok(())
    }
    pub fn get(&self, table: &str, key: &str) -> Result<Option<Value>> {
        if !matches!(
            table,
            "projects"
                | "grants"
                | "nodes"
                | "tickets"
                | "assignments"
                | "artifacts"
                | "memories"
                | "candidates"
        ) {
            anyhow::bail!("unknown entity")
        };
        let value = self
            .connection
            .query_row(
                &format!("SELECT rowid,* FROM {table} WHERE id=?1"),
                [key],
                row_value,
            )
            .optional()?;
        Ok(value.map(|mut v| {
            if let Value::Object(ref mut o) = v {
                o.remove("rowid");
                o.remove("token_hash");
                o.remove("public_key");
            }
            v
        }))
    }
    pub fn list(&self, table: &str) -> Result<Vec<Value>> {
        if !matches!(
            table,
            "projects" | "grants" | "nodes" | "tickets" | "memories"
        ) {
            anyhow::bail!("unknown entity")
        };
        let mut stmt = self.connection.prepare(&format!(
            "SELECT * FROM {table} ORDER BY rowid DESC LIMIT 500"
        ))?;
        let rows = stmt
            .query_map([], row_value)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .map(|mut v| {
                if let Value::Object(ref mut o) = v {
                    o.remove("token_hash");
                    o.remove("public_key");
                    if table == "tickets" {
                        o.remove("content");
                    }
                }
                v
            })
            .collect())
    }
    pub fn query(&self, sql: &str, values: impl rusqlite::Params) -> Result<Vec<Value>> {
        let mut stmt = self.connection.prepare(sql)?;
        let rows = stmt
            .query_map(values, row_value)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }
    pub fn detail(&self, ticket: &str) -> Result<Value> {
        let t = self.get("tickets", ticket)?.context("ticket not found")?;
        let a = self.query(
            "SELECT * FROM assignments WHERE ticket_id=?1 ORDER BY created_at",
            [ticket],
        )?;
        let reports = self.query(
            "SELECT * FROM reports WHERE ticket_id=?1 ORDER BY created_at",
            [ticket],
        )?;
        let effects = self.query(
            "SELECT * FROM effects WHERE ticket_id=?1 ORDER BY created_at",
            [ticket],
        )?;
        let artifacts = self.query(
            "SELECT * FROM artifacts WHERE ticket_id=?1 ORDER BY created_at",
            [ticket],
        )?;
        let messages = self.query(
            "SELECT * FROM messages WHERE ticket_id=?1 ORDER BY created_at",
            [ticket],
        )?;
        let mut result = t;
        result["assignments"] = json!(a);
        result["reports"] = json!(reports);
        result["effects"] = json!(effects);
        result["artifacts"] = json!(artifacts);
        result["messages"] = json!(messages);
        Ok(result)
    }
    pub fn authenticate_node(
        &self,
        node_id: &str,
        installation_id: &str,
        token: &str,
    ) -> Result<bool> {
        let expected=self.connection.query_row("SELECT token_hash FROM nodes WHERE id=?1 AND installation_id=?2 AND revoked_at IS NULL",params![node_id,installation_id],|r|r.get::<_,String>(0)).optional()?;
        Ok(expected.is_some_and(|v| same_secret(&v, &hash(token))))
    }
    pub fn authenticate_client(&self, token: &str) -> bool {
        self.setting("client_token_hash")
            .is_some_and(|expected| same_secret(&expected, &hash(token)))
    }
    pub fn audit(
        &self,
        ticket: Option<&str>,
        actor: &str,
        action: &str,
        evidence: &Value,
    ) -> Result<()> {
        audit_tx(&self.connection, ticket, actor, action, evidence)
    }
    pub fn audits(&self, ticket: Option<&str>) -> Result<Vec<Value>> {
        if let Some(ticket) = ticket {
            self.query(
                "SELECT * FROM audits WHERE ticket_id=?1 ORDER BY sequence",
                [ticket],
            )
        } else {
            self.query("SELECT * FROM audits ORDER BY sequence DESC LIMIT 1000", [])
        }
    }
    pub fn verify_audit(&self) -> Result<bool> {
        let mut previous = "GENESIS".to_string();
        for row in self.query("SELECT * FROM audits ORDER BY sequence", [])? {
            let expected = hex(Sha256::digest(
                format!(
                    "{}\n{}\n{}\n{}\n{}\n{}",
                    previous,
                    row["created_at"].as_str().unwrap_or_default(),
                    row["actor"].as_str().unwrap_or_default(),
                    row["action"].as_str().unwrap_or_default(),
                    row["ticket_id"].as_str().unwrap_or_default(),
                    row["evidence"].as_str().unwrap_or_default()
                )
                .as_bytes(),
            ));
            if row["hash"].as_str() != Some(&expected)
                || row["previous_hash"].as_str() != Some(&previous)
            {
                // Invalid audit evidence returns false; raw payload is never re-encoded.
                return Ok(false);
            }
            previous = expected;
        }
        Ok(true)
    }
}
pub fn audit_tx_plan(
    connection: &Connection,
    actor: &str,
    action: &str,
    evidence: &Value,
) -> Result<()> {
    // Plans deliberately have no Ticket foreign key, but share the same hash chain.
    audit_tx(connection, None, actor, action, evidence)
}

pub fn audit_tx(
    connection: &Connection,
    ticket: Option<&str>,
    actor: &str,
    action: &str,
    evidence: &Value,
) -> Result<()> {
    let previous = connection
        .query_row(
            "SELECT hash FROM audits ORDER BY sequence DESC LIMIT 1",
            [],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or("GENESIS".into());
    let at = now();
    let payload =
        json!({"event_type":action,"actor":actor,"evidence":evidence,"created_at":at}).to_string();
    let hasher = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        previous,
        at,
        actor,
        action,
        ticket.unwrap_or_default(),
        payload
    );
    let digest = hex(Sha256::digest(hasher.as_bytes()));
    connection.execute("INSERT INTO audits(ticket_id,actor,action,evidence,previous_hash,hash,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![ticket,actor,action,payload,previous,digest,at])?;
    Ok(())
}
pub fn row_value(row: &Row<'_>) -> rusqlite::Result<Value> {
    let mut map = Map::new();
    for i in 0..row.as_ref().column_count() {
        let key = row.as_ref().column_name(i)?.to_owned();
        let value = match row.get_ref(i)? {
            rusqlite::types::ValueRef::Null => Value::Null,
            rusqlite::types::ValueRef::Integer(i) => {
                if matches!(key.as_str(), "cancel_requested" | "expanded") {
                    json!(i != 0)
                } else {
                    json!(i)
                }
            }
            rusqlite::types::ValueRef::Real(v) => json!(v),
            rusqlite::types::ValueRef::Text(v) => {
                let value = String::from_utf8_lossy(v);
                if key == "code_evidence_json" {
                    serde_json::from_str::<Value>(&value)
                        .and_then(|value| match value {
                            Value::Object(_) => Ok(value),
                            _ => Err(serde_json::Error::io(std::io::Error::new(
                                std::io::ErrorKind::InvalidData,
                                "code_evidence_json must be a JSON object",
                            ))),
                        })
                        .map_err(|error| {
                            rusqlite::Error::FromSqlConversionFailure(
                                i,
                                rusqlite::types::Type::Text,
                                Box::new(error),
                            )
                        })?
                } else if matches!(
                    key.as_str(),
                    "capabilities"
                        | "workers"
                        | "inventory"
                        | "operations"
                        | "lineage"
                        | "artifacts"
                ) {
                    serde_json::from_str(&value).unwrap_or_else(|_| json!(value))
                } else {
                    json!(value)
                }
            }
            rusqlite::types::ValueRef::Blob(b) => json!(hex(b)),
        };
        map.insert(key, value);
    }
    Ok(Value::Object(map))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_and_client_token_does_not_echo() {
        let tmp = tempfile::tempdir().unwrap();
        let s = Store::open(tmp.path()).unwrap();
        s.set_setting("client_token_hash", &hash("0123456789abcdef"))
            .unwrap();
        assert!(s.authenticate_client("0123456789abcdef"));
        s.audit(None, "test", "opened", &json!({})).unwrap();
        assert!(s.verify_audit().unwrap());
        drop(s);
        assert!(Store::open(tmp.path())
            .unwrap()
            .authenticate_client("0123456789abcdef"));
    }

    #[test]
    fn v14_ticket_history_gains_only_a_bounded_integer_priority() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let store = Store::open(tmp.path()).unwrap();
            store.conn().execute_batch("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('legacy-project','legacy','legacy-root','read_only',1,'2026-01-01T00:00:00Z','{}'); INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('legacy-grant','legacy-project','legacy-node','default','legacy-installation','[\"read\"]',1,'original-grant-digest','2026-01-01T00:00:00Z'); INSERT INTO tickets(id,project_id,objective,kind,relative_path,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) VALUES('legacy-ticket','legacy-project','unchanged objective','read_summary','README.md','succeeded','legacy-grant','original-grant-digest','legacy-node','legacy-installation','default',2,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'); ALTER TABLE tickets DROP COLUMN priority; PRAGMA user_version=14;").unwrap();
        }
        let store = Store::open(tmp.path()).unwrap();
        assert_eq!(
            store
                .conn()
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            15
        );
        let ticket = store.get("tickets", "legacy-ticket").unwrap().unwrap();
        assert_eq!(ticket["priority"], 0);
        assert_eq!(ticket["objective"], "unchanged objective");
        assert_eq!(
            store.get("grants", "legacy-grant").unwrap().unwrap()["digest"],
            "original-grant-digest"
        );
        let columns = store.query("SELECT name,type,\"notnull\",dflt_value FROM pragma_table_info('tickets') WHERE name='priority'", []).unwrap();
        assert_eq!(
            columns,
            vec![json!({"name":"priority","type":"INTEGER","notnull":1,"dflt_value":"0"})]
        );
        for invalid in [-101, 101] {
            let error = store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,status,grant_id,grant_digest,node_id,installation_id,worker_id,created_at,updated_at,priority) SELECT 'invalid-' || ?1,project_id,objective,kind,relative_path,status,grant_id,grant_digest,node_id,installation_id,worker_id,created_at,updated_at,?1 FROM tickets WHERE id='legacy-ticket'", [invalid]).unwrap_err();
            assert!(
                error.to_string().contains("CHECK constraint failed"),
                "{error}"
            );
        }
        assert_eq!(store.list("tickets").unwrap().len(), 1);
        drop(store);
        let reopened = Store::open(tmp.path()).unwrap();
        assert_eq!(
            reopened.get("tickets", "legacy-ticket").unwrap().unwrap()["priority"],
            0
        );
    }

    #[test]
    fn future_schema_remains_an_explicit_error() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let store = Store::open(tmp.path()).unwrap();
            store.conn().execute("PRAGMA user_version=16", []).unwrap();
        }
        let error = match Store::open(tmp.path()) {
            Ok(_) => panic!("future database schema must not be accepted"),
            Err(error) => error.to_string(),
        };
        assert!(error.contains("found 16, supported 15"), "{error}");
    }

    #[test]
    fn fresh_store_has_optional_code_evidence_without_backfill() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let version: i64 = store
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 15);
        let columns = store
            .query("SELECT name FROM pragma_table_info('artifacts')", [])
            .unwrap();
        assert!(columns
            .iter()
            .any(|column| column["name"] == "code_evidence_json"));
    }

    #[test]
    fn v13_upgrade_preserves_legacy_authority_and_artifact_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let artifact_id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        let bytes = b"existing bounded artifact bytes";
        {
            let store = Store::open(tmp.path()).unwrap();
            let at = crate::now();
            store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('legacy-project','legacy','legacy-root','read_only',1,?1,'{}')",[&at]).unwrap();
            store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('legacy-grant','legacy-project','legacy-node','default','legacy-install','[\"read\"]',1,'grant-digest',?1)",[&at]).unwrap();
            store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,created_at,updated_at) VALUES('legacy-ticket','legacy-project','legacy','read_summary','README.md',NULL,'succeeded','legacy-grant','grant-digest','legacy-node','legacy-install','default',1,?1,?1)",[&at]).unwrap();
            store.conn().execute("INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at,code_evidence_json) VALUES(?1,'legacy-ticket','legacy-assignment','legacy-node','old.txt','text/plain',?2,?3,?4,?5,'[]',?6,'{\"never_backfill\":true}')",params![artifact_id,bytes.len(),crate::sha256(bytes),format!("{artifact_id}.artifact"),format!("loom://artifact/{artifact_id}"),at]).unwrap();
            fs::write(
                tmp.path()
                    .join("artifacts")
                    .join(format!("{artifact_id}.artifact")),
                bytes,
            )
            .unwrap();
            store
                .audit(
                    Some("legacy-ticket"),
                    "migration-test",
                    "legacy",
                    &json!({"unchanged":true}),
                )
                .unwrap();
            store
                .conn()
                .execute("ALTER TABLE artifacts DROP COLUMN code_evidence_json", [])
                .unwrap();
            store.conn().execute("PRAGMA user_version=13", []).unwrap();
        }
        let store = Store::open(tmp.path()).unwrap();
        let version: i64 = store
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 15);
        assert_eq!(
            store.get("tickets", "legacy-ticket").unwrap().unwrap()["grant_id"],
            "legacy-grant"
        );
        assert_eq!(
            store.get("grants", "legacy-grant").unwrap().unwrap()["digest"],
            "grant-digest"
        );
        let artifact = store.get("artifacts", artifact_id).unwrap().unwrap();
        assert_eq!(artifact["sha256"], crate::sha256(bytes));
        assert_eq!(artifact["origin_node_id"], "legacy-node");
        assert_eq!(artifact["code_evidence_json"], Value::Null);
        assert_eq!(
            fs::read(
                tmp.path()
                    .join("artifacts")
                    .join(format!("{artifact_id}.artifact"))
            )
            .unwrap(),
            bytes
        );
        assert!(store.verify_audit().unwrap());
    }

    #[test]
    fn code_evidence_read_is_object_or_an_explicit_storage_error() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Store::open(tmp.path()).unwrap();
        let object = store.query("SELECT * FROM artifacts LIMIT 0", []).unwrap();
        assert!(object.is_empty());
        let projected: Value =
            serde_json::from_str("'invalid'").unwrap_or_else(|_| json!("not used"));
        assert_eq!(projected, "not used");
        store
            .conn()
            .execute("CREATE TEMP TABLE code_evidence_read(value TEXT)", [])
            .unwrap();
        store.conn().execute("INSERT INTO code_evidence_read VALUES('{\"kind\":\"change\"}'),('[]'),('not-json')", []).unwrap();
        let rows = store.query(
            "SELECT value AS code_evidence_json FROM code_evidence_read",
            [],
        );
        assert!(
            rows.is_err(),
            "invalid JSON cannot become an implicit public string"
        );
        let valid = store
            .query(
                "SELECT value AS code_evidence_json FROM code_evidence_read LIMIT 1",
                [],
            )
            .unwrap();
        assert_eq!(valid[0]["code_evidence_json"], json!({"kind":"change"}));
    }

    #[test]
    fn experimental_v9_upgrade_adds_nullable_assignment_digest() {
        let tmp = tempfile::tempdir().unwrap();
        {
            let store = Store::open(tmp.path()).unwrap();
            store.conn().execute("INSERT INTO models(id,name,revision,location,placement_policy,status,created_at,updated_at) VALUES('legacy','fixture','v1','local_only','place_model','registered','old','old')", []).unwrap();
            store
                .conn()
                .execute("ALTER TABLE models DROP COLUMN source_assignment_id", [])
                .unwrap();
            store.conn().execute("PRAGMA user_version=9", []).unwrap();
            drop(store);
        }
        let store = Store::open(tmp.path()).unwrap();
        let version: i64 = store
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 15);
        let models = store
            .query(
                "SELECT id,assignment_digest,source_assignment_id FROM models",
                [],
            )
            .unwrap();
        assert_eq!(models[0]["id"], "legacy");
        assert_eq!(models[0]["assignment_digest"], Value::Null);
        assert_eq!(models[0]["source_assignment_id"], Value::Null);
        assert!(Store::open(tmp.path()).is_ok());
    }

    #[test]
    fn upgrades_existing_v3_records_without_replacing_authority() {
        let tmp = tempfile::tempdir().unwrap();
        let artifact_id = uuid::Uuid::new_v4().to_string();
        let body = br#"{"schema":"loom.testing.legacy"}"#;
        let digest = hash(std::str::from_utf8(body).unwrap());
        {
            let store = Store::open(tmp.path()).unwrap();
            store.conn().execute_batch("DROP TABLE document_pipeline_stages; DROP TABLE document_pipeline_runs; PRAGMA user_version=3;").unwrap();
            store.conn().execute(
                "INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project-legacy','Legacy','grain-legacy','read_write',1,'2026-01-01T00:00:00Z','[]')", []).unwrap();
            store.conn().execute(
                "INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,revoked_at,digest,created_at) VALUES('grant-legacy','project-legacy','node-old','worker-a','installation-old','[\"read\"]',1,NULL,'grant-digest','2026-01-01T00:00:00Z')", []).unwrap();
            store.conn().execute(
                "INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES('tkt-legacy','project-legacy','Legacy objective','read_summary','docs/input.txt','original','succeeded','grant-legacy','grant-digest','node-old','installation-old','worker-a',1,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", []).unwrap();
            store.conn().execute(
                "INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at) VALUES(?1,'tkt-legacy','asg-legacy','node-old','legacy.json','application/json',?2,?3,?4,?5,'[]','2026-01-01T00:00:00Z')",
                params![artifact_id.clone(), body.len(), digest, format!("{artifact_id}.artifact"), format!("loom://artifact/{artifact_id}")],
            ).unwrap();
            std::fs::write(
                tmp.path()
                    .join("artifacts")
                    .join(format!("{artifact_id}.artifact")),
                body,
            )
            .unwrap();
            store
                .audit(
                    None,
                    "migration_test",
                    "write-original-ticket",
                    &json!({"artifact_id":artifact_id}),
                )
                .unwrap();
            let version: i64 = store
                .conn()
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(version, 3);
        }
        let reopened = Store::open(tmp.path()).unwrap();
        let version: i64 = reopened
            .conn()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 15);
        let artifact = reopened.get("artifacts", &artifact_id).unwrap().unwrap();
        assert_eq!(artifact["ticket_id"], "tkt-legacy");
        assert_eq!(artifact["sha256"], digest);
        assert_eq!(artifact["origin_node_id"], "node-old");
        let ticket = reopened.get("tickets", "tkt-legacy").unwrap().unwrap();
        assert_eq!(ticket["grant_id"], "grant-legacy");
        assert_eq!(ticket["status"], "succeeded");
        assert_eq!(ticket["priority"], 0);
        assert!(reopened.verify_audit().unwrap());
        assert_eq!(
            std::fs::read(
                tmp.path()
                    .join("artifacts")
                    .join(format!("{artifact_id}.artifact"))
            )
            .unwrap(),
            body
        );
        let count: i64 = reopened
            .conn()
            .query_row("SELECT COUNT(*) FROM direct_offers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let observations: i64 = reopened
            .conn()
            .query_row("SELECT COUNT(*) FROM model_observations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(observations, 0);
        let replay_tables: i64 = reopened
            .conn()
            .query_row("SELECT COUNT(*) FROM skill_replays", [], |r| r.get(0))
            .unwrap();
        assert_eq!(replay_tables, 0);
        let install_plans: i64 = reopened
            .conn()
            .query_row("SELECT COUNT(*) FROM install_plans", [], |r| r.get(0))
            .unwrap();
        assert_eq!(install_plans, 0);
        let skills: i64 = reopened
            .conn()
            .query_row("SELECT COUNT(*) FROM skills", [], |r| r.get(0))
            .unwrap();
        assert_eq!(skills, 0);
    }
}
