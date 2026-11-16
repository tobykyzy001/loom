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
        if current > 5 {
            anyhow::bail!(
                "database schema is from a newer Loom release (found {current}, supported 5)"
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
            CREATE TABLE artifacts(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES tickets(id),assignment_id TEXT NOT NULL,origin_node_id TEXT NOT NULL,name TEXT NOT NULL,media_type TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,storage_name TEXT NOT NULL,location TEXT NOT NULL,lineage TEXT NOT NULL,created_at TEXT NOT NULL);
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
            "projects" | "grants" | "nodes" | "tickets" | "assignments" | "artifacts" | "memories"
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
                if matches!(
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
        assert_eq!(version, 5);
        let artifact = reopened.get("artifacts", &artifact_id).unwrap().unwrap();
        assert_eq!(artifact["ticket_id"], "tkt-legacy");
        assert_eq!(artifact["sha256"], digest);
        assert_eq!(artifact["origin_node_id"], "node-old");
        let ticket = reopened.get("tickets", "tkt-legacy").unwrap().unwrap();
        assert_eq!(ticket["grant_id"], "grant-legacy");
        assert_eq!(ticket["status"], "succeeded");
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
    }
}
