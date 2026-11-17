//! Bounded SourceInstance/Thread/Trigger intake. Source identity is not execution authority.
use crate::api::{ApiError, ApiResult};
use crate::store::{self, row_value, Store};
use crate::{id, now};
use axum::http::StatusCode;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const INSTANCE_SCHEMA: &str = "loom.source-instance.v1";
const EVENT_SCHEMA: &str = "loom.source-event.v1";
const PAGE_SCHEMA: &str = "loom.source-page.v1";
const OWNER: &str = "authenticated_client";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterSource {
    schema: Option<String>,
    source_key: String,
    kind: Option<String>,
    label: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AppendEvent {
    source_id: String,
    thread_id: String,
    event_id: String,
    content: String,
    schema: Option<String>,
    kind: Option<String>,
    occurred_at: Option<String>,
    ticket_id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceListQuery {
    pub source_cursor: Option<String>,
    pub limit: Option<usize>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewQuery {
    source_id: Option<String>,
    thread_id: Option<String>,
    cursor: Option<String>,
    after_sequence: Option<i64>,
    limit: Option<usize>,
}
fn opaque(raw: &str, label: &'static str) -> ApiResult<String> {
    if raw.is_empty()
        || raw.len() > 160
        || !raw
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.:@-".contains(c))
    {
        return Err(ApiError::bad(format!(
            "{label} must be a bounded, non-empty opaque identifier"
        )));
    }
    Ok(raw.to_owned())
}
fn text(value: Option<String>) -> ApiResult<Option<String>> {
    if let Some(value) = value {
        if value.trim().is_empty() || value.len() > 160 || value.chars().any(char::is_control) {
            return Err(ApiError::bad(
                "Optional source labels must be nonempty, bounded text without control characters",
            ));
        }
        Ok(Some(value))
    } else {
        Ok(None)
    }
}
#[derive(Serialize)]
struct NormalizedRegistration<'a> {
    schema: &'a str,
    source_key: &'a str,
    kind: &'a str,
    label: Option<String>,
}
#[derive(Serialize)]
struct NormalizedEvent {
    schema: &'static str,
    kind: &'static str,
    source_id: String,
    thread_id: String,
    event_id: String,
    content: String,
    ticket_id: Option<String>,
    occurred_at: Option<String>,
}
fn occurrence(raw: Option<String>) -> ApiResult<Option<String>> {
    raw.map(|value| {
        let parsed = chrono::DateTime::parse_from_rfc3339(&value).map_err(|_| {
            ApiError::bad("occurred_at must be an RFC3339 timestamp with an explicit offset")
        })?;
        Ok(parsed
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true))
    })
    .transpose()
}
pub fn register(store: &mut Store, request: RegisterSource) -> ApiResult<Value> {
    let source_key = opaque(&request.source_key, "source_key")?;
    let kind = request.kind.unwrap_or_else(|| "web".to_owned());
    if kind != "web" {
        return Err(ApiError::bad(
            "Only the explicit web SourceInstance is supported by this boundary",
        ));
    }
    let inferred_schema = request.schema.unwrap_or_else(|| INSTANCE_SCHEMA.to_owned());
    if inferred_schema != INSTANCE_SCHEMA {
        return Err(ApiError::bad("Unsupported source-instance schema"));
    }
    let label = text(request.label)?;
    let definition = NormalizedRegistration {
        schema: INSTANCE_SCHEMA,
        source_key: &source_key,
        kind: &kind,
        label,
    };
    let definition_json = serde_json::to_string(&definition)
        .map_err(|_| ApiError::bad("Source definition cannot be encoded"))?;
    let digest = store::hash(&definition_json);
    let tx = store.conn_mut().transaction()?;
    if let Some(row) = tx
        .query_row(
            "SELECT * FROM source_instances WHERE owner_key=?1 AND source_key=?2",
            params![OWNER, source_key],
            row_value,
        )
        .optional()?
    {
        if row["definition_digest"] != digest {
            return Err(ApiError::conflict("source_definition_conflict", "An existing source_key cannot be rebound to different source identity or properties"));
        }
        return Ok(
            json!({"source":row,"duplicate":true,"task_created":false,"permission_granted":false}),
        );
    }
    let source_id = id("src");
    let at = now();
    let result = (|| -> rusqlite::Result<()> {
        tx.execute("INSERT INTO source_instances(id,owner_key,source_key,kind,label,definition_digest,last_sequence,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,0,?7,?7)",
            params![source_id, OWNER, source_key, kind, definition.label, digest, at])?;
        Ok(())
    })();
    if let Err(error) = result {
        // Never turn arbitrary uniqueness/foreign-key errors into permission or duplicate success.
        if matches!(error, rusqlite::Error::SqliteFailure(ref code, _) if code.code == rusqlite::ErrorCode::ConstraintViolation)
        {
            drop(tx);
            let original = store
                .query(
                    "SELECT * FROM source_instances WHERE owner_key=?1 AND source_key=?2",
                    params![OWNER, source_key],
                )?
                .into_iter()
                .next()
                .ok_or_else(|| {
                    ApiError::new(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "source_store_error",
                        "Source registration did not preserve a committed source",
                    )
                })?;
            if original["definition_digest"] == digest {
                return Ok(
                    json!({"source":original,"duplicate":true,"task_created":false,"permission_granted":false}),
                );
            }
            return Err(ApiError::conflict(
                "source_definition_conflict",
                "Source identity or immutable definition differs from the existing source_key",
            ));
        }
        return Err(error.into());
    }
    tx.commit()?;
    let source = store
        .query(
            "SELECT * FROM source_instances WHERE id=?1 AND owner_key=?2",
            [&source_id, OWNER],
        )?
        .pop()
        .ok_or_else(|| ApiError::missing("Registered source was not readable"))?;
    store.audit(
        None,
        "client",
        "source.registered",
        &json!({"source_id":source_id,"digest":digest,"owner":OWNER}),
    )?;
    Ok(json!({"source":source,"duplicate":false,"task_created":false,"permission_granted":false}))
}

fn event_value(query: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id":query.get::<_,String>(0)?, "source_id":query.get::<_,String>(1)?, "thread_id":query.get::<_,String>(2)?,
        "external_event_id":query.get::<_,String>(3)?, "kind":query.get::<_,String>(4)?, "content":query.get::<_,String>(5)?,
        "payload_digest":query.get::<_,String>(6)?, "ticket_id":query.get::<_,Option<String>>(7)?, "occurred_at":query.get::<_,Option<String>>(8)?,
        "received_at":query.get::<_,String>(9)?, "source_sequence":query.get::<_,i64>(10)?, "thread_sequence":query.get::<_,i64>(11)?,
        "client_thread_id":query.get::<_,String>(12)?,
    }))
}
const EVENT_COLUMNS: &str = "id,source_id,thread_id,external_event_id,kind,content,payload_digest,ticket_id,occurred_at,received_at,source_sequence,thread_sequence";
const EVENT_READ_COLUMNS: &str = "id,source_id,thread_id,external_event_id,kind,content,payload_digest,ticket_id,occurred_at,received_at,source_sequence,thread_sequence,(SELECT t.client_thread_id FROM source_threads t WHERE t.id=source_events.thread_id AND t.source_id=source_events.source_id) AS client_thread_id";
fn fetch_event(
    tx: &rusqlite::Transaction<'_>,
    source: &str,
    event_id: &str,
) -> ApiResult<Option<Value>> {
    tx.query_row(
        &format!(
            "SELECT {EVENT_READ_COLUMNS} FROM source_events WHERE source_id=?1 AND external_event_id=?2"
        ),
        params![source, event_id],
        event_value,
    )
    .optional()
    .map_err(Into::into)
}
fn receipt(event: Value, duplicate: bool) -> Value {
    let mut value = event;
    value["duplicate"] = json!(duplicate);
    value["task_created"] = json!(false);
    value["permission_granted"] = json!(false);
    value["delivery_stage"] = json!("recorded");
    value
}

pub fn ingest(store: &mut Store, request: AppendEvent) -> ApiResult<Value> {
    let source_id = opaque(&request.source_id, "source_id")?;
    let thread_id = opaque(&request.thread_id, "thread_id")?;
    let external_event_id = opaque(&request.event_id, "event_id")?;
    let kind = request.kind.unwrap_or_else(|| "user_message".to_owned());
    if kind != "user_message" {
        return Err(ApiError::bad(
            "Only user_message events are recorded by this first source boundary",
        ));
    }
    if request.schema.unwrap_or_else(|| EVENT_SCHEMA.to_owned()) != EVENT_SCHEMA {
        return Err(ApiError::bad("Unsupported source-event schema"));
    }
    if request.content.trim().is_empty()
        || request.content.len() > 16_000
        || request.content.contains('\0')
    {
        return Err(ApiError::bad(
            "Source message content must be bounded nonblank text with no NUL bytes",
        ));
    }
    let ticket_id = request
        .ticket_id
        .as_deref()
        .map(|id| opaque(id, "ticket_id"))
        .transpose()?;
    let normalized = NormalizedEvent {
        schema: EVENT_SCHEMA,
        kind: "user_message",
        source_id,
        thread_id,
        event_id: external_event_id,
        content: request.content,
        ticket_id,
        occurred_at: occurrence(request.occurred_at)?,
    };
    let digest = store::hash(
        &serde_json::to_string(&normalized)
            .map_err(|_| ApiError::bad("Source event cannot be encoded"))?,
    );
    let tx = store.conn_mut().transaction()?;
    if tx
        .query_row(
            "SELECT 1 FROM source_instances WHERE id=?1 AND owner_key=?2",
            params![normalized.source_id, OWNER],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_none()
    {
        return Err(ApiError::missing(
            "SourceInstance was not found for the authenticated client",
        ));
    }
    // Ownership is checked before an idempotency hit or duplicate-key information is exposed.
    if let Some(original) = fetch_event(&tx, &normalized.source_id, &normalized.event_id)? {
        if original["payload_digest"] != digest {
            return Err(ApiError::conflict(
                "source_event_conflict",
                "This source event ID already identifies different immutable content",
            ));
        }
        return Ok(receipt(original, true));
    }
    if let Some(ticket) = &normalized.ticket_id {
        let exists = tx
            .query_row("SELECT 1 FROM tickets WHERE id=?1", [ticket], |row| {
                row.get::<_, i64>(0)
            })
            .optional()?;
        if exists.is_none() {
            return Err(ApiError::missing(
                "The referenced Ticket does not exist for this client workspace",
            ));
        }
    }
    let at = now();
    let internal_thread = id("thread");
    tx.execute("INSERT OR IGNORE INTO source_threads(id,source_id,client_thread_id,last_sequence,created_at,updated_at) VALUES(?1,?2,?3,0,?4,?4)",
        params![internal_thread, normalized.source_id, normalized.thread_id, at])?;
    let thread: AssemblyThread = tx.query_row(
        "SELECT id,last_sequence FROM source_threads WHERE source_id=?1 AND client_thread_id=?2",
        params![normalized.source_id, normalized.thread_id],
        |row| {
            Ok(AssemblyThread {
                id: row.get(0)?,
                sequence: row.get(1)?,
            })
        },
    )?;
    let source_sequence: i64 = tx.query_row(
        "SELECT last_sequence FROM source_instances WHERE id=?1 AND owner_key=?2",
        params![normalized.source_id, OWNER],
        |row| row.get(0),
    )?;
    let sequence = source_sequence.checked_add(1).ok_or_else(|| {
        ApiError::conflict(
            "source_sequence_exhausted",
            "Source sequence cannot be advanced without overflow",
        )
    })?;
    let thread_sequence = thread.sequence.checked_add(1).ok_or_else(|| {
        ApiError::conflict(
            "thread_sequence_exhausted",
            "Thread sequence cannot be advanced without overflow",
        )
    })?;
    let event_id = id("sre");
    tx.execute(&format!("INSERT INTO source_events({EVENT_COLUMNS}) VALUES(?1,?2,?3,?4,'user_message',?5,?6,?7,?8,?9,?10,?11)"),
        params![event_id, normalized.source_id, thread.id, normalized.event_id, normalized.content, digest,
            normalized.ticket_id, normalized.occurred_at, at, sequence, thread_sequence])?;
    tx.execute(
        "UPDATE source_instances SET last_sequence=?1,updated_at=?2 WHERE id=?3 AND owner_key=?4",
        params![sequence, at, normalized.source_id, OWNER],
    )?;
    tx.execute(
        "UPDATE source_threads SET last_sequence=?1,updated_at=?2 WHERE id=?3",
        params![thread_sequence, at, thread.id],
    )?;
    tx.execute("INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id,source_event_id) VALUES(?1,?2,'user','concierge','conversation',?3,NULL,'private',?4,?5,?6)",
        params![id("message"), normalized.ticket_id, normalized.content, at,
            format!("{}:{}", normalized.source_id, normalized.event_id), event_id])?;
    tx.commit()?;
    let event = store
        .query(
            &format!("SELECT {EVENT_READ_COLUMNS} FROM source_events WHERE id=?1"),
            [&event_id],
        )?
        .pop()
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "source_record_missing",
                "Committed source event is not readable",
            )
        })?;
    store.audit(normalized.ticket_id.as_deref(), "client", "source.event.received", &json!({
        "source_id":normalized.source_id,"external_event_id":normalized.event_id,"ticket_id":normalized.ticket_id,"payload_digest":digest,
    }))?;
    Ok(receipt(event, false))
}
struct AssemblyThread {
    id: String,
    sequence: i64,
}

pub fn list(store: &Store, query: SourceListQuery) -> ApiResult<Value> {
    let limit = match query.limit {
        Some(1..=100) => query.limit.unwrap(),
        None => 50,
        _ => return Err(ApiError::bad("Source list size must be between 1 and 100")),
    };
    if let Some(cursor) = &query.source_cursor {
        let cursor = opaque(cursor, "source_cursor")?;
        let present = store.query(
            "SELECT 1 FROM source_instances WHERE id=?1 AND owner_key=?2",
            params![cursor, OWNER],
        )?;
        if present.is_empty() {
            return Err(ApiError::missing(
                "Source list cursor does not belong to this client namespace",
            ));
        }
    }
    let mut sources = store.query("SELECT * FROM source_instances WHERE owner_key=?1 AND (?2 IS NULL OR id<?2) ORDER BY id DESC LIMIT ?3",
        params![OWNER, query.source_cursor, limit + 1])?;
    let has_more = sources.len() > limit;
    sources.truncate(limit);
    let next_cursor = if has_more {
        sources
            .last()
            .and_then(|row| row["id"].as_str().map(ToOwned::to_owned))
    } else {
        None
    };
    Ok(json!({
        "schema":"loom.source-list.v1", "sources":sources, "owner":OWNER,
        "has_more":has_more, "next_cursor":next_cursor, "limit":limit,
    }))
}

pub fn preview(store: &mut Store, query: PreviewQuery) -> ApiResult<Value> {
    let limit = match query.limit {
        Some(1..=200) => query.limit.unwrap(),
        None => 50,
        _ => return Err(ApiError::bad("Source page size must be between 1 and 200")),
    };
    let before = query.after_sequence.unwrap_or(0);
    if before < 0 {
        return Err(ApiError::bad("Source sequence must not be negative"));
    }
    let tx = store.conn_mut().transaction()?;
    let (source_id, client_thread, after_sequence) = if let Some(cursor) = &query.cursor {
        let stored = tx.query_row("SELECT source_id,thread_id,after_sequence FROM source_event_cursors WHERE id=?1 AND owner_key=?2 AND schema=?3", params![cursor,OWNER,PAGE_SCHEMA], |row| Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,row.get::<_,i64>(2)?))).optional()?
            .ok_or_else(|| ApiError::missing("Source preview cursor is invalid, expired or belongs to a different source or thread"))?;
        if query.source_id.is_some() || query.thread_id.is_some() || query.after_sequence.is_some()
        {
            return Err(ApiError::conflict("preview_cursor_bound", "A cursor already binds the exact source, thread and ordering; do not replace them with another selection"));
        }
        let (source, thread) = tx.query_row(
            "SELECT source_id,client_thread_id FROM source_threads WHERE id=?1",
            [&stored.1],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )?;
        if source != stored.0 {
            return Err(ApiError::conflict(
                "preview_cursor_bound",
                "Cursor source and thread no longer match",
            ));
        }
        (source, thread, stored.2)
    } else {
        let source = query
            .source_id
            .as_deref()
            .map(|it| opaque(it, "source_id"))
            .transpose()?
            .ok_or_else(|| {
                ApiError::bad("An exact source_id is required (or use a bound preview cursor)")
            })?;
        let thread = query
            .thread_id
            .as_deref()
            .map(|it| opaque(it, "thread_id"))
            .transpose()?
            .ok_or_else(|| {
                ApiError::bad(
                    "An exact thread_id is required; source reads do not merge unrelated threads",
                )
            })?;
        if tx
            .query_row(
                "SELECT 1 FROM source_instances WHERE id=?1 AND owner_key=?2",
                params![source, OWNER],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_none()
        {
            return Err(ApiError::missing(
                "SourceInstance was not found for this client",
            ));
        }
        (source, thread, before)
    };
    let thread = tx
        .query_row(
            "SELECT * FROM source_threads WHERE source_id=?1 AND client_thread_id=?2",
            params![source_id, client_thread],
            row_value,
        )
        .optional()?
        .ok_or_else(|| ApiError::missing("This exact source thread does not exist"))?;
    let internal_thread: String = thread["id"].as_str().unwrap_or_default().to_owned();
    if let Some(cursor) = &query.cursor {
        let expected = tx.query_row("SELECT 1 FROM source_event_cursors WHERE id=?1 AND owner_key=?2 AND source_id=?3 AND thread_id=?4 AND after_sequence=?5 AND schema=?6",
            params![cursor, OWNER, source_id, internal_thread, after_sequence, PAGE_SCHEMA], |row| row.get::<_,i64>(0)).optional()?;
        if expected.is_none() {
            return Err(ApiError::conflict(
                "preview_cursor_bound",
                "Cursor does not match this exact owner, source, thread and sequence",
            ));
        }
    }
    let mut rows = tx.prepare(&format!("SELECT {EVENT_READ_COLUMNS} FROM source_events WHERE source_id=?1 AND thread_id=?2 AND source_sequence>?3 ORDER BY source_sequence,id LIMIT ?4"))?
        .query_map(params![source_id,internal_thread,after_sequence,limit+1], event_value)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = rows.len() > limit;
    rows.truncate(limit);
    let next_sequence = rows
        .last()
        .and_then(|row| row["source_sequence"].as_i64())
        .unwrap_or(after_sequence);
    let cursor = if has_more {
        let cursor = id("scp");
        tx.execute("INSERT INTO source_event_cursors(id,owner_key,source_id,thread_id,after_sequence,schema,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![cursor,OWNER,source_id,internal_thread,next_sequence,PAGE_SCHEMA,now()])?;
        Some(cursor)
    } else {
        None
    };
    tx.commit()?;
    let source_cursor: i64 = store.conn().query_row(
        "SELECT last_sequence FROM source_instances WHERE id=?1 AND owner_key=?2",
        params![source_id, OWNER],
        |row| row.get(0),
    )?;
    Ok(
        json!({"schema":PAGE_SCHEMA,"source_id":source_id,"thread":thread,"events":rows,"next_cursor":cursor,
        "last_sequence":next_sequence,"source_cursor":source_cursor,"has_more":has_more,"permission_granted":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn arbitrary_owner_or_task_fields_do_not_enter_source_requests() {
        for body in [
            json!({"source_key":"local","owner":"another-owner"}),
            json!({"source_key":"local","grant_id":"grant"}),
        ] {
            assert!(serde_json::from_value::<RegisterSource>(body).is_err());
        }
        assert!(serde_json::from_value::<AppendEvent>(json!({"source_id":"src","thread_id":"thread","event_id":"evt","content":"a","received_at":"2026-01-01T00:00:00Z"})).is_err());
    }
    #[test]
    fn equivalent_rfc3339_timestamps_normalize_without_changing_content() {
        let canonical = occurrence(Some("2026-01-01T01:00:00+01:00".into())).unwrap();
        assert_eq!(canonical.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert!(occurrence(Some("not-a-date".into())).is_err());
    }

    #[test]
    fn populated_v11_history_survives_the_source_migration_without_fabricated_links() {
        let directory = tempfile::tempdir().unwrap();
        let time = "2026-01-01T00:00:00Z";
        {
            let store = Store::open(directory.path()).unwrap();
            store.conn().execute_batch(
                "DROP TABLE source_event_cursors;DROP TABLE source_events;DROP TABLE source_threads;DROP TABLE source_instances;
                 ALTER TABLE messages RENAME TO legacy_messages;
                 CREATE TABLE messages(id TEXT PRIMARY KEY,ticket_id TEXT,sender TEXT NOT NULL,recipient TEXT,kind TEXT NOT NULL,content TEXT NOT NULL,session_ref TEXT,visibility TEXT NOT NULL,created_at TEXT NOT NULL,request_id TEXT,UNIQUE(ticket_id,request_id));
                 INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,visibility,created_at,request_id)
                 SELECT id,ticket_id,sender,recipient,kind,content,visibility,created_at,request_id FROM legacy_messages;
                 DROP TABLE legacy_messages;PRAGMA user_version=11;",
            ).unwrap();
            store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('legacy-project','fixture','/fixture','read_only',1,?1,'{}')", [time]).unwrap();
            store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('legacy-grant','legacy-project','legacy-node','default','legacy-installation','[\"read\"]',1,'original-digest',?1)", [time]).unwrap();
            store.conn().execute("INSERT INTO tickets(id,project_id,objective,kind,relative_path,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES('legacy-ticket','legacy-project','Original objective','read_summary','input.txt','running','legacy-grant','original-digest','legacy-node','legacy-installation','default',1,0,?1,?1)", [time]).unwrap();
            store.conn().execute("INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES('legacy-assignment','legacy-ticket','legacy-node','default',1,'legacy-lease',1,?1,?1)", [time]).unwrap();
            store.conn().execute("INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at) VALUES('artifact-legacy','legacy-ticket','legacy-assignment','legacy-node','input.txt','text/plain',1,'legacy-hash','stored','fixture','[]',?1)", [time]).unwrap();
            store.conn().execute("INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id) VALUES('legacy-message','legacy-ticket','worker','concierge','session_link','original message',NULL,'summary',?1,'legacy-message-request')", [time]).unwrap();
        }
        let upgraded = Store::open(directory.path()).unwrap();
        assert_eq!(
            upgraded
                .conn()
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            12
        );
        assert_eq!(
            upgraded.get("grants", "legacy-grant").unwrap().unwrap()["digest"],
            "original-digest"
        );
        assert_eq!(
            upgraded.get("tickets", "legacy-ticket").unwrap().unwrap()["objective"],
            "Original objective"
        );
        assert_eq!(
            upgraded
                .get("assignments", "legacy-assignment")
                .unwrap()
                .unwrap()["lease_epoch"],
            1
        );
        assert_eq!(
            upgraded
                .get("artifacts", "artifact-legacy")
                .unwrap()
                .unwrap()["sha256"],
            "legacy-hash"
        );
        let messages = upgraded.query("SELECT * FROM messages", []).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "original message");
        assert_eq!(messages[0]["source_event_id"], Value::Null);
        assert!(upgraded
            .query("SELECT * FROM source_events", [])
            .unwrap()
            .is_empty());
        assert!(upgraded
            .query("SELECT * FROM source_event_cursors", [])
            .unwrap()
            .is_empty());
        drop(upgraded);
        let reopened = Store::open(directory.path())
            .expect("current v12 must reopen without a future-version refusal");
        assert_eq!(
            reopened.get("tickets", "legacy-ticket").unwrap().unwrap()["status"],
            "running"
        );
        let old_messages = reopened
            .query("SELECT * FROM messages WHERE id='legacy-message'", [])
            .unwrap();
        assert_eq!(old_messages.len(), 1);
        assert_eq!(old_messages[0]["source_event_id"], Value::Null);
    }

    #[test]
    fn legacy_snapshot_without_messages_can_receive_and_reopen_new_events() {
        let directory = tempfile::tempdir().unwrap();
        {
            let store = Store::open(directory.path()).unwrap();
            store
                .conn()
                .execute_batch("DROP TABLE messages;PRAGMA user_version=6;")
                .unwrap();
        }
        {
            let mut upgraded = Store::open(directory.path()).unwrap();
            let has_messages: i64 = upgraded
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='messages'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(has_messages, 1);
            assert!(upgraded
                .query("SELECT * FROM messages", [])
                .unwrap()
                .is_empty());
            let source = register(
                &mut upgraded,
                serde_json::from_value(json!({"source_key":"legacy-v6-input"})).unwrap(),
            )
            .unwrap();
            let event = ingest(
                &mut upgraded,
                serde_json::from_value(json!({
                    "source_id":source["source"]["id"], "thread_id":"input", "event_id":"first",
                    "content":"event after an older snapshot has been upgraded"
                }))
                .unwrap(),
            )
            .unwrap();
            assert_eq!(event["source_sequence"], 1);
            let new_messages = upgraded.query("SELECT * FROM messages", []).unwrap();
            assert_eq!(new_messages.len(), 1);
            assert_eq!(new_messages[0]["source_event_id"], event["id"]);
        }
        let reopened = Store::open(directory.path()).unwrap();
        let events = reopened.query("SELECT * FROM source_events", []).unwrap();
        let messages = reopened.query("SELECT * FROM messages", []).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["source_event_id"], events[0]["id"]);
    }

    #[test]
    fn source_listing_is_bounded_and_owner_scopes_pagination() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(dir.path()).unwrap();
        let mut ids = Vec::new();
        for key in 0..105 {
            let created = register(
                &mut store,
                serde_json::from_value(json!({"source_key":format!("fixture-source-{key:03}")}))
                    .unwrap(),
            )
            .unwrap();
            ids.push(created["source"]["id"].as_str().unwrap().to_owned());
        }
        let first = list(
            &store,
            SourceListQuery {
                source_cursor: None,
                limit: Some(100),
            },
        )
        .unwrap();
        assert_eq!(first["sources"].as_array().unwrap().len(), 100);
        assert_eq!(first["has_more"], true);
        let cursor = first["next_cursor"].as_str().unwrap().to_owned();
        assert!(ids.contains(&cursor));
        let next = list(
            &store,
            SourceListQuery {
                source_cursor: Some(cursor),
                limit: Some(100),
            },
        )
        .unwrap();
        assert_eq!(next["sources"].as_array().unwrap().len(), 5);
        assert_eq!(next["has_more"], false);
        assert!(list(
            &store,
            SourceListQuery {
                source_cursor: Some("does-not-exist".into()),
                limit: Some(100)
            }
        )
        .is_err());
        assert!(list(
            &store,
            SourceListQuery {
                source_cursor: None,
                limit: Some(101)
            }
        )
        .is_err());
    }
}
