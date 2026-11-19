//! HTTP handlers parse strictly versioned DTOs and enforce identity, scope,
//! immutable artifact lineage and Lease fencing. All writes stay in SQLite.
use crate::*;
use axum::{
    extract::State as AppState,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Read;

const MAX_INLINE_ARTIFACT_BYTES: usize = 8 * 1024 * 1024;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    // Existing Axum Body reader keeps this production-route regression dependency-free.
    use std::{
        path::Path,
        sync::{Arc, Mutex},
    };
    use tower::ServiceExt;
    async fn artifact_response_with_query(
        app: &Router,
        ticket: &str,
        artifact: &str,
        query: &str,
    ) -> (StatusCode, Value) {
        let response = app
            .clone()
            .oneshot(
                axum::extract::Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/api/v1/tickets/{ticket}/artifacts/{artifact}{query}"
                    ))
                    .header(
                        header::AUTHORIZATION,
                        "Bearer artifact-reader-test-token-12345",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        (status, body)
    }

    async fn artifact_response(app: &Router, ticket: &str, artifact: &str) -> (StatusCode, Value) {
        artifact_response_with_query(app, ticket, artifact, "").await
    }

    #[tokio::test]
    async fn artifact_read_binds_scope_path_integrity_and_utf8() {
        const TOKEN: &str = "artifact-reader-test-token-12345";
        const ARTIFACT_ID: &str = "11111111-1111-4111-8111-111111111111";
        const BINARY_ID: &str = "22222222-2222-4222-8222-222222222222";
        const OVERSIZED_ID: &str = "44444444-4444-4444-8444-444444444444";
        const GOOD: &[u8] = "owned artifact text\nwith exact UTF-8 bytes: ✓ 中文\n".as_bytes();
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(directory.path()).unwrap();
        store
            .set_setting("client_token_hash", &crate::store::hash(TOKEN))
            .unwrap();
        // Directly seeded reader rows/files are deliberately not claims that a
        // producer, worker, upload or successful task execution occurred.
        store.conn().execute_batch(
            "INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','Artifact reader fixture','/owned/artifact-reader','read_only',1,'2026-01-01T00:00:00Z','{}');
             INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('grant','project','node','worker','installation','[\"read\"]',1,'grant-digest','2026-01-01T00:00:00Z');
             INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES
               ('ticket','project','Reader fixture','read_summary','README.md',NULL,'pending','grant','grant-digest','node','installation','worker',0,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
               ('other-ticket','project','Other reader fixture','read_summary','OTHER.md',NULL,'pending','grant','grant-digest','node','installation','worker',0,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');",
        ).unwrap();
        let seed_artifact = |id: &str, bytes: &[u8], name: &str| {
            store.conn().execute(
                "INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at) VALUES(?1,'ticket','reader-fixture','node',?2,'text/plain',?3,?4,?5,?6,'[]','2026-01-01T00:00:00Z')",
                params![id,name,bytes.len() as i64,sha256(bytes),format!("{id}.artifact"),format!("loom://artifact/{id}")],
            ).unwrap();
            std::fs::write(
                store.root.join("artifacts").join(format!("{id}.artifact")),
                bytes,
            )
            .unwrap();
        };
        seed_artifact(ARTIFACT_ID, GOOD, "owned.txt");
        seed_artifact(BINARY_ID, &[0xff, 0xfe, 0x00], "binary-fixture.txt");
        let oversized = vec![0xa5; MAX_INLINE_ARTIFACT_BYTES + 1];
        seed_artifact(OVERSIZED_ID, &[0xa5], "oversized.bin");
        std::fs::write(
            store
                .root
                .join("artifacts")
                .join(format!("{OVERSIZED_ID}.artifact")),
            &oversized,
        )
        .unwrap();
        store
            .conn()
            .execute(
                "UPDATE artifacts SET size_bytes=?2,sha256=?3 WHERE id=?1",
                params![
                    OVERSIZED_ID,
                    MAX_INLINE_ARTIFACT_BYTES as i64,
                    sha256(&oversized)
                ],
            )
            .unwrap();
        // The physical file is one byte larger than its declared cap-sized
        // record, with a matching digest for all actual bytes.
        let state = Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: TOKEN.into(),
            bootstrap_token_written: false,
        });
        let app = router(state.clone());
        let path = state
            .lock()
            .unwrap()
            .root
            .join("artifacts")
            .join(format!("{ARTIFACT_ID}.artifact"));
        assert!(path.is_file());

        let (status, body) = artifact_response(&app, "ticket", ARTIFACT_ID).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        for (key, expected) in [
            ("id", Value::from(ARTIFACT_ID)),
            ("ticket_id", Value::from("ticket")),
            ("assignment_id", Value::from("reader-fixture")),
            ("origin_node_id", Value::from("node")),
            ("name", Value::from("owned.txt")),
            ("media_type", Value::from("text/plain")),
            (
                "storage_name",
                Value::from(format!("{ARTIFACT_ID}.artifact")),
            ),
            (
                "location",
                Value::from(format!("loom://artifact/{ARTIFACT_ID}")),
            ),
            ("sha256", Value::from(sha256(GOOD))),
        ] {
            assert_eq!(body["artifact"][key], expected, "{key}");
        }
        assert_eq!(body["artifact"]["size_bytes"], GOOD.len());
        assert_eq!(body["size_bytes"], GOOD.len());
        assert_eq!(body["content"], String::from_utf8(GOOD.to_vec()).unwrap());
        assert_eq!(body["content"].as_str().unwrap().as_bytes(), GOOD);
        assert_eq!(body["encoding"], "utf8");
        assert_eq!(body["truncated"], false);
        assert_eq!(body["artifact"]["code_evidence"], Value::Null);
        assert!(body["artifact"].get("code_evidence_json").is_none());

        for query in ["", "?encoding=utf8"] {
            let (status, body) =
                artifact_response_with_query(&app, "ticket", ARTIFACT_ID, query).await;
            assert_eq!(status, StatusCode::OK, "{query}: {body}");
            assert_eq!(body["encoding"], "utf8");
            assert_eq!(body["size_bytes"], GOOD.len());
            assert_eq!(body["content"].as_str().unwrap().as_bytes(), GOOD);
            let (status, base64) =
                artifact_response_with_query(&app, "ticket", ARTIFACT_ID, "?encoding=base64").await;
            assert_eq!(status, StatusCode::OK, "{base64}");
            assert_eq!(base64["encoding"], "base64");
            assert_eq!(base64["truncated"], false);
            assert_eq!(base64["size_bytes"], GOOD.len());
            assert_eq!(base64["artifact"]["sha256"], sha256(GOOD));
            assert_eq!(base64["artifact"]["size_bytes"], GOOD.len());
            assert_eq!(
                STANDARD
                    .decode(base64["content"].as_str().unwrap())
                    .unwrap(),
                GOOD
            );
        }
        let (status, missing) =
            artifact_response(&app, "ticket", "33333333-3333-4333-8333-333333333333").await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{missing}");
        assert_eq!(missing["error"]["code"], "not_found");

        let (status, body) = artifact_response(&app, "other-ticket", ARTIFACT_ID).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"]["code"], "artifact_scope");
        assert!(body.get("content").is_none());
        assert!(!body.to_string().contains("owned artifact text"));
        let (status, body) =
            artifact_response_with_query(&app, "other-ticket", ARTIFACT_ID, "?encoding=base64")
                .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"]["code"], "artifact_scope");
        assert!(body.get("content").is_none());
        assert!(!body.to_string().contains("owned artifact text"));

        let location_error = |body: &Value| {
            assert_eq!(body["error"]["code"], "artifact_location", "{body}");
            assert!(!body
                .to_string()
                .contains(directory.path().to_string_lossy().as_ref()));
        };
        let update_metadata = |field: &str, value: Value| {
            let value = match value {
                Value::String(value) => rusqlite::types::Value::Text(value),
                Value::Number(value) => value.as_i64().map_or_else(
                    || rusqlite::types::Value::Real(value.as_f64().unwrap()),
                    rusqlite::types::Value::Integer,
                ),
                _ => unreachable!("fixture only persists scalar metadata"),
            };
            state
                .lock()
                .unwrap()
                .conn()
                .execute(
                    &format!("UPDATE artifacts SET {field}=?1 WHERE id=?2"),
                    params![value, ARTIFACT_ID],
                )
                .unwrap();
        };
        // The outside file has exactly the recorded bytes/digest: this case
        // fails only if storage_name escapes the owned artifacts namespace.
        std::fs::write(directory.path().join("outside-owned.txt"), GOOD).unwrap();
        update_metadata("storage_name", Value::from("../outside-owned.txt"));
        let (status, body) = artifact_response(&app, "ticket", ARTIFACT_ID).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        location_error(&body);
        let (status, body) =
            artifact_response_with_query(&app, "ticket", ARTIFACT_ID, "?encoding=base64").await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        location_error(&body);
        assert!(body.get("content").is_none());
        for invalid_location in [
            "",
            ".",
            "..",
            "nested/name.artifact",
            "folder\\name.artifact",
            "/tmp/name.artifact",
            "legacy.artifact",
        ] {
            update_metadata("storage_name", Value::from(invalid_location));
            let (status, body) = artifact_response(&app, "ticket", ARTIFACT_ID).await;
            assert_eq!(status, StatusCode::CONFLICT, "{invalid_location}: {body}");
            location_error(&body);
        }
        update_metadata("storage_name", Value::from(7));
        let (status, body) = artifact_response(&app, "ticket", ARTIFACT_ID).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        location_error(&body);
        update_metadata(
            "storage_name",
            Value::from(format!("{ARTIFACT_ID}.artifact")),
        );

        std::fs::write(&path, b"tampered while preserving the filename").unwrap();
        let (status, body) = artifact_response(&app, "ticket", ARTIFACT_ID).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "artifact_integrity");
        assert!(body.get("content").is_none());
        let (status, body) =
            artifact_response_with_query(&app, "ticket", ARTIFACT_ID, "?encoding=base64").await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "artifact_integrity");
        assert!(body.get("content").is_none());
        update_metadata("sha256", Value::from(7));
        let (status, body) = artifact_response(&app, "ticket", ARTIFACT_ID).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "artifact_integrity");
        update_metadata("sha256", Value::from(7.5));
        let (status, body) = artifact_response(&app, "ticket", ARTIFACT_ID).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "artifact_integrity");
        update_metadata("sha256", Value::from(sha256(GOOD)));
        for invalid_size in [-1, MAX_INLINE_ARTIFACT_BYTES as i64 + 1] {
            update_metadata("size_bytes", Value::from(invalid_size));
            for query in ["", "?encoding=base64"] {
                let (status, body) =
                    artifact_response_with_query(&app, "ticket", ARTIFACT_ID, query).await;
                assert_eq!(
                    status,
                    StatusCode::CONFLICT,
                    "{invalid_size} {query}: {body}"
                );
                assert_eq!(body["error"]["code"], "artifact_integrity");
                assert!(body.get("content").is_none());
                assert!(body["error"]["message"].as_str().unwrap().len() < 160);
            }
        }
        update_metadata("size_bytes", Value::from(GOOD.len()));
        update_metadata("size_bytes", Value::from(GOOD.len() - 1));
        let (status, body) = artifact_response(&app, "ticket", ARTIFACT_ID).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "artifact_integrity");
        assert!(body.get("content").is_none());
        update_metadata("size_bytes", Value::from(GOOD.len()));
        std::fs::write(&path, GOOD).unwrap();
        std::fs::remove_file(&path).unwrap();
        let (status, body) = artifact_response(&app, "ticket", ARTIFACT_ID).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "artifact_storage_unavailable");
        assert!(body.get("content").is_none());
        std::fs::write(&path, GOOD).unwrap();
        let (status, _) = artifact_response(&app, "ticket", ARTIFACT_ID).await;
        assert_eq!(status, StatusCode::OK);

        let (status, body) = artifact_response(&app, "ticket", BINARY_ID).await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "artifact_encoding");
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("plain text"));
        assert!(body.get("content").is_none());
        assert!(!body.to_string().contains('�'));
        let (status, body) =
            artifact_response_with_query(&app, "ticket", BINARY_ID, "?encoding=utf8").await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["error"]["code"], "artifact_encoding");
        assert!(body.get("content").is_none());
        let (status, body) =
            artifact_response_with_query(&app, "ticket", BINARY_ID, "?encoding=base64").await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["content"], "//4A");
        assert_eq!(body["encoding"], "base64");
        assert_eq!(body["truncated"], false);
        assert_eq!(body["size_bytes"], 3);
        assert_eq!(body["artifact"]["size_bytes"], 3);
        assert_eq!(body["artifact"]["sha256"], sha256([0xff, 0xfe, 0x00]));
        assert_eq!(
            STANDARD.decode(body["content"].as_str().unwrap()).unwrap(),
            [0xff, 0xfe, 0x00]
        );

        for query in [
            "?encoding=latin1-sensitive",
            "?encoding=",
            "?encoding=UTF8",
            "?encoding=base64&unknown=value",
            "?unknown=value",
            "?encoding=utf8&encoding=base64",
            "?encoding=base64&encoding=base64",
        ] {
            let (status, body) =
                artifact_response_with_query(&app, "ticket", BINARY_ID, query).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{query}: {body}");
            assert_eq!(body["error"]["code"], "invalid_request");
            assert!(body.get("content").is_none());
            assert!(body["error"]["message"].as_str().unwrap().len() < 160);
            assert!(!body.to_string().contains("sensitive"));
            assert_eq!(
                state.lock().unwrap().detail("ticket").unwrap()["status"],
                "pending"
            );
        }
        for query in ["", "?encoding=base64"] {
            let (status, body) =
                artifact_response_with_query(&app, "ticket", OVERSIZED_ID, query).await;
            assert_eq!(status, StatusCode::CONFLICT, "{query}: {body}");
            assert_eq!(body["error"]["code"], "artifact_too_large");
            assert!(body.get("content").is_none());
            assert!(body["error"]["message"].as_str().unwrap().len() < 160);
        }
        assert_eq!(
            state.lock().unwrap().detail("ticket").unwrap()["status"],
            "pending"
        );

        #[cfg(unix)]
        {
            // This link targets the matching outside bytes, so it independently
            // checks the regular-file guard on the supported local macOS path.
            std::fs::remove_file(&path).unwrap();
            std::os::unix::fs::symlink(directory.path().join("outside-owned.txt"), &path).unwrap();
            let (status, body) = artifact_response(&app, "ticket", ARTIFACT_ID).await;
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            location_error(&body);
            std::fs::remove_file(&path).unwrap();
        }
        assert_eq!(
            state
                .lock()
                .unwrap()
                .query("SELECT id FROM artifacts", [])
                .unwrap()
                .len(),
            3
        );
    }

    #[tokio::test]
    async fn binding_audit_failure_does_not_leave_an_approved_binding() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let store = crate::store::Store::open(directory.path().join("db")).unwrap();
        let root_text = root.to_string_lossy().to_string();
        store.conn().execute(
            "INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','Binding audit fixture',?1,'read_write',1,'2026-01-01T00:00:00Z','{}')",
            [&root_text],
        ).unwrap();
        let inventory = json!({"project_roots":{"project":root_text}});
        store.conn().execute(
            "INSERT INTO nodes(id,installation_id,public_key,token_hash,status,revoked_at,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node','installation','fixture-public-key','fixture-token-hash','registered',NULL,'[]','[{\"worker_id\":\"default\"}]',?1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
            [inventory.to_string()],
        ).unwrap();
        // Same physical connection that the handler will subsequently open/write.
        // This is a persistent server-visible failure, not a TEMP trigger on another DB handle.
        store.conn().execute_batch(
            "CREATE TRIGGER reject_binding_audit_for_unit BEFORE INSERT ON audits WHEN NEW.action='project.binding.approved' BEGIN SELECT RAISE(ABORT,'binding audit failure fixture'); END;",
        ).unwrap();
        let state = Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: "binding-fixture-token".into(),
            bootstrap_token_written: false,
        });
        let body = json!({"project_id":"project","node_id":"node","worker_id":"default","root_scope":root_text});
        let error = create_project_binding(AppState(state.clone()), Json(body.clone()))
            .await
            .unwrap_err();
        assert!(!error.to_string().is_empty());
        let bindings = state
            .lock()
            .unwrap()
            .query("SELECT count(*) AS count FROM project_bindings", [])
            .unwrap();
        let audits = state
            .lock()
            .unwrap()
            .query(
                "SELECT count(*) AS count FROM audits WHERE action='project.binding.approved'",
                [],
            )
            .unwrap();
        assert_eq!(
            bindings[0]["count"], 0,
            "Failed binding audit cannot leave a usable binding behind"
        );
        assert_eq!(audits[0]["count"], 0);

        state
            .lock()
            .unwrap()
            .conn()
            .execute_batch("DROP TRIGGER reject_binding_audit_for_unit")
            .unwrap();
        let approved = create_project_binding(AppState(state.clone()), Json(body))
            .await
            .unwrap();
        assert_eq!(approved.0["installation_id"], "installation");
        let after = state
            .lock()
            .unwrap()
            .query("SELECT count(*) AS count FROM project_bindings", [])
            .unwrap();
        assert_eq!(after[0]["count"], 1);
    }

    const REVOCATION_TOKEN: &str = "test-client-token-123456789012345";

    fn revocation_test_state() -> (tempfile::TempDir, Arc<State>) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("owned-project");
        std::fs::create_dir(&root).unwrap();
        let store = crate::store::Store::open(directory.path().join("db")).unwrap();
        store
            .set_setting("client_token_hash", &crate::store::hash(REVOCATION_TOKEN))
            .unwrap();
        // These are coordinator admission fixture rows, not proof that a LocalNode,
        // Agent, producer execution, Report, Artifact, or external Effect occurred.
        store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','owned',?1,'read_write',1,'2026-01-01T00:00:00Z','{}')", [root.to_string_lossy()]).unwrap();
        store
            .conn()
            .execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,revoked_at,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node','installation','fixture-public-key','fixture-token-hash','registered',NULL,'{}','[]','{}','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')", [])
            .unwrap();
        store
            .conn()
            .execute("INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding','project','node','installation','default',?1,'binding-proof','2026-01-01T00:00:00Z')", [root.to_string_lossy()])
            .unwrap();
        store.conn().execute_batch(
            "INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant','project','node','default','installation','[\"write\"]',1,'original-digest','2026-01-01T00:00:00Z','binding');
             INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES('ticket','project','Bounded original work','edit_file','src/calc.js','original task input','running','grant','original-digest','node','installation','default',1,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
             INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,acknowledged_at,created_at,cancelled_at,last_report_at) VALUES('assignment','ticket','node','default',1,'lease',1,'2100-01-01T00:00:00+00:00',NULL,'2026-01-01T00:00:00Z',NULL,NULL);",
        ).unwrap();
        let state = Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: REVOCATION_TOKEN.into(),
            bootstrap_token_written: false,
        });
        (directory, state)
    }

    async fn response_json(response: Response) -> (StatusCode, Value) {
        let status = response.status();
        let body = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        (status, body)
    }

    fn revocation_audits(store: &crate::store::Store, action: &str) -> Vec<Value> {
        store
            .query("SELECT * FROM audits WHERE action=?1", [action])
            .unwrap()
    }

    fn assert_node_revocation_history_unchanged(
        store: &crate::store::Store,
        expected: (Value, Value, Value, Value, Vec<Value>),
    ) {
        assert_eq!(
            store.query("SELECT * FROM nodes", []).unwrap()[0],
            expected.0
        );
        assert_eq!(
            store.get("assignments", "assignment").unwrap().unwrap(),
            expected.1
        );
        assert_eq!(store.get("grants", "grant").unwrap().unwrap(), expected.2);
        assert_eq!(store.get("tickets", "ticket").unwrap().unwrap(), expected.3);
        assert_eq!(revocation_audits(store, "node.revoked"), expected.4);
    }

    #[tokio::test]
    async fn revoke_route_records_current_fence_and_audit() {
        let (_directory, state) = revocation_test_state();
        let app = router(state.clone());
        let call = || {
            post_json(
                &app,
                "/api/v1/grants/grant/revoke".into(),
                REVOCATION_TOKEN,
                json!({}),
            )
        };
        let initial = crate::maintenance::assignment_for_poll(&mut state.lock().unwrap(), "node")
            .unwrap()
            .unwrap();
        assert_eq!(initial["id"], "assignment");
        assert_eq!(initial["purpose"], "execute");
        assert_eq!(initial["grant_status"], true);
        assert_eq!(initial["grant_version"], 1);
        state
            .lock()
            .unwrap()
            .conn()
            .execute(
                "UPDATE assignments SET acknowledged_at='2026-01-01T00:01:00Z' WHERE id='assignment'",
                [],
            )
            .unwrap();

        let (status, first) = response_json(call().await).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["duplicate"], false);
        assert_eq!(first["grant_version"], 2);
        assert_eq!(
            first["effects"],
            "running_execution_outcome_unknown_until_reconciled"
        );
        let snapshot = {
            let store = state.lock().unwrap();
            (
                store.get("grants", "grant").unwrap().unwrap(),
                store.get("tickets", "ticket").unwrap().unwrap(),
                store.get("assignments", "assignment").unwrap().unwrap(),
                revocation_audits(&store, "grant.revoked"),
            )
        };
        assert_eq!(snapshot.0["revoked_at"], first["revoked_at"]);
        assert_eq!(snapshot.0["digest"], "original-digest");
        assert_eq!(snapshot.2["lease_expires_at"], first["revoked_at"]);
        assert_eq!(snapshot.1["status"], "reconciling");
        assert_eq!(snapshot.3.len(), 1);

        let (status, second) = response_json(call().await).await;
        assert_eq!(status, StatusCode::OK, "{second}");
        assert_eq!(second["duplicate"], true);
        assert_eq!(second["grant_version"], 2);
        assert_eq!(second["revoked_at"], first["revoked_at"]);
        assert_eq!(second["effects"], first["effects"]);
        let stop = crate::maintenance::assignment_for_poll(&mut state.lock().unwrap(), "node")
            .unwrap()
            .unwrap();
        {
            let store = state.lock().unwrap();
            assert_eq!(store.get("grants", "grant").unwrap().unwrap(), snapshot.0);
            assert_eq!(store.get("tickets", "ticket").unwrap().unwrap(), snapshot.1);
            assert_eq!(
                store.get("assignments", "assignment").unwrap().unwrap(),
                snapshot.2
            );
            assert_eq!(revocation_audits(&store, "grant.revoked"), snapshot.3);
            assert!(store.verify_audit().unwrap());
            for table in ["reports", "artifacts", "effects"] {
                assert_eq!(
                    store.query(&format!("SELECT * FROM {table}"), []).unwrap(),
                    Vec::<Value>::new()
                );
            }
        }
        for key in [
            "id",
            "ticket_id",
            "lease_id",
            "lease_epoch",
            "attempt",
            "objective",
            "content",
            "operation",
            "grant_digest",
            "grant_version",
            "resource",
            "grant",
        ] {
            if key != "grant" {
                assert_eq!(stop[key], initial[key], "{key}");
            }
        }
        let mut projected_grant = snapshot.0.clone();
        projected_grant["project_root"] = initial["grant"]["project_root"].clone();
        assert_eq!(stop["grant"], projected_grant);
        assert_eq!(stop["purpose"], "reconcile");
        assert_eq!(stop["grant_status"], false);
        assert_eq!(stop["grant_version"], 1);
        assert_eq!(stop["grant"]["version"], 2);
        assert_eq!(stop["grant"]["digest"], "original-digest");
        assert_eq!(stop["lease_expires_at"], snapshot.2["lease_expires_at"]);
        assert_eq!(stop["cancel_requested"], false);
        assert_eq!(
            stop["grant"]["project_root"],
            initial["grant"]["project_root"]
        );
        assert_eq!(snapshot.2["cancelled_at"], Value::Null);
        assert_eq!(snapshot.2["last_report_at"], Value::Null);

        // A persisted nonstandard version stays immutable and explicitly does not
        // satisfy maintenance.rs's stricter creation-v1 -> revoked-v2 admission gate.
        state
            .lock()
            .unwrap()
            .conn()
            .execute("UPDATE grants SET version=7 WHERE id='grant'", [])
            .unwrap();
        assert!(
            crate::maintenance::assignment_for_poll(&mut state.lock().unwrap(), "node")
                .unwrap()
                .is_none()
        );
        let (status, legacy) = response_json(call().await).await;
        assert_eq!(status, StatusCode::OK, "{legacy}");
        assert_eq!(legacy["duplicate"], true);
        assert_eq!(legacy["grant_version"], 7);
        assert_eq!(legacy["revoked_at"], first["revoked_at"]);
        {
            let store = state.lock().unwrap();
            assert_eq!(store.get("grants", "grant").unwrap().unwrap()["version"], 7);
            assert_eq!(
                store.get("assignments", "assignment").unwrap().unwrap(),
                snapshot.2
            );
            assert_eq!(revocation_audits(&store, "grant.revoked"), snapshot.3);
            for sequence in 0..28 {
                store
                    .audit(
                        None,
                        "fixture",
                        "fixture.read-marker",
                        &json!({"sequence":sequence}),
                    )
                    .unwrap();
            }
        }
        let unknown = response_json(
            post_json(
                &app,
                "/api/v1/grants/missing/revoke".into(),
                REVOCATION_TOKEN,
                json!({}),
            )
            .await,
        )
        .await;
        assert_eq!(unknown.0, StatusCode::NOT_FOUND, "{:?}", unknown.1);
        assert_eq!(unknown.1["error"]["code"], "not_found");
        assert_eq!(
            state
                .lock()
                .unwrap()
                .query("SELECT * FROM audits", [])
                .unwrap()
                .len(),
            29
        );

        let read = app
            .clone()
            .oneshot(
                axum::extract::Request::builder()
                    .method("GET")
                    .uri("/api/v1/audit")
                    .header(header::AUTHORIZATION, format!("Bearer {REVOCATION_TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let (status, body) = response_json(read).await;
        assert_eq!(status, StatusCode::OK);
        let audits = body["audit"].as_array().unwrap();
        assert_eq!(
            audits.len(),
            29,
            "Global audit projection must retain records beyond the oldest 24 entries"
        );
        assert_eq!(
            audits
                .iter()
                .filter(|record| record["action"] == "grant.revoked")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn revoked_node_replay_preserves_timestamp_lease_and_single_audit() {
        let (_directory, state) = revocation_test_state();
        let app = router(state.clone());
        let call = || {
            post_json(
                &app,
                "/api/v1/nodes/node/revoke".into(),
                REVOCATION_TOKEN,
                json!({}),
            )
        };
        let original_lease = state
            .lock()
            .unwrap()
            .get("assignments", "assignment")
            .unwrap()
            .unwrap()["lease_expires_at"]
            .clone();
        let (status, first) = response_json(call().await).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["duplicate"], false);
        assert_eq!(first["node_id"], "node");
        assert_eq!(
            first["task_outcome"],
            "Unknown active effects enter reconciliation"
        );
        let snapshot = {
            let store = state.lock().unwrap();
            (
                store.query("SELECT * FROM nodes", []).unwrap()[0].clone(),
                store.get("assignments", "assignment").unwrap().unwrap(),
                store.get("grants", "grant").unwrap().unwrap(),
                store.get("tickets", "ticket").unwrap().unwrap(),
                revocation_audits(&store, "node.revoked"),
            )
        };
        assert_eq!(snapshot.0["status"], "revoked");
        assert_eq!(snapshot.0["revoked_at"], first["revoked_at"]);
        assert_ne!(snapshot.1["lease_expires_at"], original_lease);
        assert_eq!(snapshot.1["lease_expires_at"], first["revoked_at"]);
        assert_eq!(snapshot.4.len(), 1);

        let (status, second) = response_json(call().await).await;
        assert_eq!(status, StatusCode::OK, "{second}");
        assert_eq!(second["duplicate"], true);
        assert_eq!(second["revoked_at"], first["revoked_at"]);
        assert_eq!(second["task_outcome"], first["task_outcome"]);
        {
            let store = state.lock().unwrap();
            assert_eq!(
                store.query("SELECT * FROM nodes", []).unwrap()[0],
                snapshot.0
            );
            assert_eq!(
                store.get("assignments", "assignment").unwrap().unwrap(),
                snapshot.1
            );
            assert_eq!(store.get("grants", "grant").unwrap().unwrap(), snapshot.2);
            assert_eq!(store.get("tickets", "ticket").unwrap().unwrap(), snapshot.3);
            assert_eq!(revocation_audits(&store, "node.revoked"), snapshot.4);
        }

        let (status, missing) = response_json(
            post_json(
                &app,
                "/api/v1/nodes/missing/revoke".into(),
                REVOCATION_TOKEN,
                json!({}),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{missing}");

        state
            .lock()
            .unwrap()
            .conn()
            .execute("UPDATE nodes SET revoked_at=NULL WHERE id='node'", [])
            .unwrap();
        let (status, inconsistent) = response_json(call().await).await;
        assert_eq!(status, StatusCode::CONFLICT, "{inconsistent}");
        assert_eq!(
            inconsistent["error"]["code"],
            "revocation_state_inconsistent"
        );
        {
            let store = state.lock().unwrap();
            assert!(store.query("SELECT * FROM nodes", []).unwrap()[0]["revoked_at"].is_null());
            assert_eq!(
                store.get("assignments", "assignment").unwrap().unwrap(),
                snapshot.1
            );
            assert_eq!(revocation_audits(&store, "node.revoked"), snapshot.4);
        }

        for (status, timestamp) in [
            ("inconsistent-reopened", json!("2026-02-01T00:00:00Z")),
            ("inconsistent-nonstring", json!(1)),
        ] {
            let sqlite_timestamp = match timestamp {
                Value::String(value) => rusqlite::types::Value::Text(value),
                Value::Number(value) => rusqlite::types::Value::Integer(value.as_i64().unwrap()),
                _ => unreachable!(
                    "the mismatch fixtures only contain a text RFC3339 timestamp or integer"
                ),
            };
            state
                .lock()
                .unwrap()
                .conn()
                .execute(
                    "UPDATE nodes SET status=?1,revoked_at=?2 WHERE id='node'",
                    params![status, sqlite_timestamp],
                )
                .unwrap();
            let before = {
                let store = state.lock().unwrap();
                (
                    store.query("SELECT * FROM nodes", []).unwrap()[0].clone(),
                    store.get("assignments", "assignment").unwrap().unwrap(),
                    store.get("grants", "grant").unwrap().unwrap(),
                    store.get("tickets", "ticket").unwrap().unwrap(),
                    revocation_audits(&store, "node.revoked"),
                )
            };
            let (response_status, response_body) = response_json(call().await).await;
            assert_eq!(response_status, StatusCode::CONFLICT, "{response_body}");
            assert_eq!(
                response_body["error"]["code"],
                "revocation_state_inconsistent"
            );
            {
                // This synchronous lock scope finishes entirely before the next await,
                // rather than moving a guard through the repeated request loop.
                let store = state.lock().unwrap();
                assert_node_revocation_history_unchanged(&store, before);
            }
        }
    }

    #[tokio::test]
    async fn acknowledgement_and_audit_commit_atomically() {
        const NODE_TOKEN: &str = "acknowledgement-node-token-123456";
        let (directory, state) = revocation_test_state();
        state
            .lock()
            .unwrap()
            .conn()
            .execute(
                "UPDATE nodes SET token_hash=?1 WHERE id='node' AND installation_id='installation'",
                [crate::store::hash(NODE_TOKEN)],
            )
            .unwrap();
        let before = state
            .lock()
            .unwrap()
            .get("assignments", "assignment")
            .unwrap()
            .unwrap();
        assert!(before["acknowledged_at"].is_null());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(server_state)).await.unwrap();
        });
        let call = || {
            reqwest::Client::new()
                .post(format!("http://{address}/api/v1/nodes/acknowledge"))
                .bearer_auth(NODE_TOKEN)
                .json(&json!({
                    "protocol":"loom.node.v1", "node_id":"node",
                    "installation_id":"installation", "request_id":id("acknowledgement-test"),
                    "ticket_id":"ticket", "assignment_id":"assignment", "lease_epoch":1,
                    "accepted":true, "reason":"", "cancel_requested":false,
                    "cancellation":false
                }))
        };

        // This seeded Assignment and controlled SQL fault test authenticated RPC
        // and record consistency only; neither produced an executor or DSH effect.
        state
            .lock()
            .unwrap()
            .conn()
            .execute_batch(
                "CREATE TEMP TRIGGER deny_acknowledgement_audit BEFORE INSERT ON audits
                 WHEN NEW.action='assignment.acknowledged'
                 BEGIN SELECT RAISE(ABORT,'fixture denies acknowledgement audit'); END;",
            )
            .unwrap();
        let response = call().send().await.unwrap();
        let status = response.status();
        let denied = response.json::<Value>().await.unwrap();
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{denied}");
        assert_eq!(denied["error"]["code"], "storage_error");
        assert!(denied["error"].get("backtrace").is_none());
        assert!(!denied
            .to_string()
            .contains(directory.path().to_string_lossy().as_ref()));
        assert!(!denied.to_string().contains(NODE_TOKEN));
        {
            let store = state.lock().unwrap();
            assert_eq!(
                store.get("assignments", "assignment").unwrap().unwrap(),
                before,
                "a failed acknowledgement audit must roll back the assignment too"
            );
            assert!(revocation_audits(&store, "assignment.acknowledged").is_empty());
        }

        state
            .lock()
            .unwrap()
            .conn()
            .execute("DROP TRIGGER deny_acknowledgement_audit", [])
            .unwrap();
        let response = call().send().await.unwrap();
        let status = response.status();
        let accepted = response.json::<Value>().await.unwrap();
        assert_eq!(status, StatusCode::OK, "{accepted}");
        assert_eq!(accepted["accepted"], true);
        let (first_assignment, first_timestamp, first_audits) = {
            let store = state.lock().unwrap();
            let assignment = store.get("assignments", "assignment").unwrap().unwrap();
            let acknowledged_at = assignment["acknowledged_at"].as_str().unwrap().to_owned();
            assert_eq!(accepted["acknowledged_at"], acknowledged_at);
            assert!(
                parse_time(&acknowledged_at).unwrap()
                    > chrono::Utc::now() - chrono::Duration::minutes(1)
            );
            assert_ne!(acknowledged_at, "2026-01-01T00:00:00Z");
            let audits = revocation_audits(&store, "assignment.acknowledged");
            assert_eq!(audits.len(), 1);
            assert_eq!(audits[0]["ticket_id"], "ticket");
            assert_eq!(audits[0]["actor"], "node");
            let evidence: Value =
                serde_json::from_str(audits[0]["evidence"].as_str().unwrap()).unwrap();
            assert_eq!(evidence["event_type"], "assignment.acknowledged");
            assert_eq!(evidence["actor"], "node");
            assert_eq!(evidence["evidence"]["assignment_id"], "assignment");
            assert_eq!(evidence["evidence"]["delivered_is_not_read"], true);
            assert!(!evidence.to_string().contains(NODE_TOKEN));
            assert!(store.verify_audit().unwrap());
            (assignment, acknowledged_at, audits)
        };

        // A fresh opaque request_id does not create another admission for the
        // same still-valid Assignment. It must reread the exact original one.
        let response = call().send().await.unwrap();
        let duplicate = response.json::<Value>().await.unwrap();
        assert_eq!(duplicate["accepted"], true);
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(duplicate["acknowledged_at"], first_timestamp);
        assert_eq!(duplicate["delivered_is_not_read"], true);
        assert_eq!(duplicate["report_or_execution_completed"], false);
        {
            let store = state.lock().unwrap();
            assert_eq!(
                store.get("assignments", "assignment").unwrap().unwrap(),
                first_assignment,
                "A repeated ordinary admission does not modify the durable assignment"
            );
            assert_eq!(
                revocation_audits(&store, "assignment.acknowledged"),
                first_audits
            );
            assert!(store.verify_audit().unwrap());
            // A timestamp with no matching functional audit is not proof of a
            // past admission and cannot be replayed as an accepted message.
            store
                .conn()
                .execute(
                    "DELETE FROM audits WHERE action='assignment.acknowledged'",
                    [],
                )
                .unwrap();
        }
        let response = call().send().await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let inconsistent = response.json::<Value>().await.unwrap();
        assert_eq!(
            inconsistent["error"]["code"],
            "acknowledgement_inconsistent"
        );
        assert!(!inconsistent.to_string().contains(NODE_TOKEN));
        {
            let store = state.lock().unwrap();
            assert_eq!(
                store.get("assignments", "assignment").unwrap().unwrap(),
                first_assignment,
                "Rejected ambiguous history must not mint a replacement timestamp or audit"
            );
            assert!(revocation_audits(&store, "assignment.acknowledged").is_empty());
        }
        // Non-null malformed values are not a missing first acknowledgement.
        // Neither may be overwritten with a newly minted coherent-looking timestamp.
        // The TEXT affinity stores the SQL numeric literal 17 as text "17";
        // it is still not a valid RFC timestamp and must remain unchanged.
        for (literal, expected) in [
            ("'not-a-timestamp'", Value::String("not-a-timestamp".into())),
            ("17", Value::String("17".into())),
        ] {
            let corrupt = {
                let store = state.lock().unwrap();
                store.conn().execute(
                    &format!("UPDATE assignments SET acknowledged_at={literal} WHERE id='assignment'"),
                    [],
                ).unwrap();
                store.get("assignments", "assignment").unwrap().unwrap()
            };
            let response = call().send().await.unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
            let error = response.json::<Value>().await.unwrap();
            assert_eq!(error["error"]["code"], "acknowledgement_inconsistent");
            let store = state.lock().unwrap();
            assert_eq!(
                store.get("assignments", "assignment").unwrap().unwrap(),
                corrupt,
                "Malformed stored time must be preserved, not repaired into a false first receipt"
            );
            assert_eq!(corrupt["acknowledged_at"], expected);
            assert!(revocation_audits(&store, "assignment.acknowledged").is_empty());
            assert!(!error.to_string().contains(NODE_TOKEN));
        }
        {
            // A missing time alongside a lone audit is the other incomplete
            // state, not authority to create a new timestamp on replay.
            let store = state.lock().unwrap();
            store
                .conn()
                .execute(
                    "UPDATE assignments SET acknowledged_at=NULL WHERE id='assignment'",
                    [],
                )
                .unwrap();
            store
                .audit(
                    Some("ticket"),
                    "node",
                    "assignment.acknowledged",
                    &json!({"assignment_id":"assignment","delivered_is_not_read":true}),
                )
                .unwrap();
        }
        let response = call().send().await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            response.json::<Value>().await.unwrap()["error"]["code"],
            "acknowledgement_inconsistent"
        );
        let store = state.lock().unwrap();
        assert!(
            store.get("assignments", "assignment").unwrap().unwrap()["acknowledged_at"].is_null()
        );
        assert_eq!(
            revocation_audits(&store, "assignment.acknowledged").len(),
            1
        );
        server.abort();
    }

    #[tokio::test]
    async fn first_grant_revocation_rolls_back_when_its_audit_write_fails() {
        let (_directory, state) = revocation_test_state();
        let app = router(state.clone());
        let before = {
            let store = state.lock().unwrap();
            (
                store.get("grants", "grant").unwrap().unwrap(),
                store.get("tickets", "ticket").unwrap().unwrap(),
                store.get("assignments", "assignment").unwrap().unwrap(),
            )
        };
        state
            .lock()
            .unwrap()
            .conn()
            .execute_batch(
                "CREATE TEMP TRIGGER deny_grant_revocation_audit BEFORE INSERT ON audits
             WHEN NEW.action='grant.revoked'
             BEGIN SELECT RAISE(ABORT,'fixture denies revocation audit'); END;",
            )
            .unwrap();
        let denied = response_json(
            post_json(
                &app,
                "/api/v1/grants/grant/revoke".into(),
                REVOCATION_TOKEN,
                json!({}),
            )
            .await,
        )
        .await;
        assert_eq!(
            denied.0,
            StatusCode::INTERNAL_SERVER_ERROR,
            "{:?}",
            denied.1
        );
        {
            let store = state.lock().unwrap();
            assert_eq!(store.get("grants", "grant").unwrap().unwrap(), before.0);
            assert_eq!(store.get("tickets", "ticket").unwrap().unwrap(), before.1);
            assert_eq!(
                store.get("assignments", "assignment").unwrap().unwrap(),
                before.2
            );
            assert_eq!(revocation_audits(&store, "grant.revoked").len(), 0);
        }
        state
            .lock()
            .unwrap()
            .conn()
            .execute("DROP TRIGGER deny_grant_revocation_audit", [])
            .unwrap();
        let (status, first) = response_json(
            post_json(
                &app,
                "/api/v1/grants/grant/revoke".into(),
                REVOCATION_TOKEN,
                json!({}),
            )
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["duplicate"], false);
        let store = state.lock().unwrap();
        assert_eq!(store.get("grants", "grant").unwrap().unwrap()["version"], 2);
        assert_eq!(revocation_audits(&store, "grant.revoked").len(), 1);
        assert!(store.verify_audit().unwrap());
    }

    const EVENT_NODE_TOKEN: &str = "event-node-token-123456789012345";

    fn event_test_state(directory: &Path) -> Arc<State> {
        let store = crate::store::Store::open(directory).unwrap();
        if store
            .query("SELECT id FROM nodes WHERE id='node'", [])
            .unwrap()
            .is_empty()
        {
            store
                .conn()
            .execute_batch(&format!(
                "INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at) VALUES('node','installation','event-fixture-public-key','{}','online','{{}}','[]','{{}}','2026-01-01T00:00:00Z');
                 INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','event fixture','/event-fixture','read_write',1,'2026-01-01T00:00:00Z','{{}}');
                 INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('grant','project','node','worker','installation','[\"read\"]',1,'digest','2026-01-01T00:00:00Z');
                 INSERT INTO tickets(id,project_id,objective,kind,relative_path,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES
                   ('ticket','project','first event','read_summary','README.md','running','grant','digest','node','installation','worker',1,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
                   ('ticket-two','project','second event','read_summary','README.md','running','grant','digest','node','installation','worker',3,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
                 INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES
                   ('assignment','ticket','node','worker',1,'lease',1,'2100-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
                   ('assignment-two','ticket-two','node','worker',3,'lease-two',3,'2100-01-01T00:00:00Z','2026-01-01T00:00:00Z');",
                crate::store::hash(EVENT_NODE_TOKEN)
                ))
                .unwrap();
        }
        Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: EVENT_NODE_TOKEN.into(),
            bootstrap_token_written: false,
        })
    }

    fn event_body() -> Value {
        json!({
            "protocol":"loom.node.v1", "node_id":"node", "installation_id":"installation",
            "request_id":"event-request", "ticket_id":"ticket", "assignment_id":"assignment",
            "lease_epoch":1, "activity":"Original visible progress", "kind":"activity",
            "sender":"worker", "session_ref":{"session_id":"session","observed_seq":3},
            "metadata":{"nested":[1,{"z":true,"a":null}]}
        })
    }

    async fn event_request(app: &Router, body: &Value) -> (StatusCode, Value) {
        event_request_with_token(app, body, EVENT_NODE_TOKEN).await
    }

    async fn event_request_with_token(
        app: &Router,
        body: &Value,
        token: &str,
    ) -> (StatusCode, Value) {
        response_json(post_json(app, "/api/v1/nodes/events".into(), token, body.clone()).await)
            .await
    }

    fn event_fixture_counts(store: &crate::store::Store, request_id: &str) -> (usize, usize) {
        (
            store
                .query("SELECT * FROM messages WHERE request_id=?1", [request_id])
                .unwrap()
                .len(),
            store
                .query(
                    "SELECT * FROM requests WHERE node_id='node' AND route='events' AND request_id=?1",
                    [request_id],
                )
                .unwrap()
                .len(),
        )
    }

    #[tokio::test]
    async fn event_receipt_preserves_canonical_replay_across_restart() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("receipt-db");
        let state = event_test_state(&database);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server_state = state.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, router(server_state)).await.unwrap();
        });
        let app = router(state.clone());
        let (status, first) = event_request(&app, &event_body()).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["accepted"], true);
        assert_eq!(first["duplicate"], false);
        assert_eq!(first["node_id"], "node");
        let (original, receipt_before) = {
            let store = state.lock().unwrap();
            (
                store
                    .query("SELECT * FROM messages WHERE request_id='event-request'", [])
                    .unwrap(),
                store
                    .query("SELECT * FROM requests WHERE route='events' AND request_id='event-request'", [])
                    .unwrap(),
            )
        };
        assert_eq!(original.len(), 1);
        assert_eq!(receipt_before.len(), 1);
        assert_eq!(first["message_id"], original[0]["id"]);
        assert!(!serde_json::to_string(&receipt_before)
            .unwrap()
            .contains(EVENT_NODE_TOKEN));

        // Generated by actual JS LoomNodeClient.prototype.logicalDigest for
        // event_body: hash(canonical({logical_fields:body_without_request_id})).
        // The protected logical_fields wrapper is part of the wire contract.
        assert_eq!(
            receipt_before[0]["payload_digest"],
            "800bf40b7a22b3fe9845640b3ef59adf6aef2e4200f566b87f48101c1e8274e8"
        );

        // Raw JSON formatting and object order are irrelevant, but array order is not.
        let replay_raw = r#"{
          "metadata":{"nested":[1,{"a":null,"z":true}]},
          "session_ref":{"observed_seq":3,"session_id":"session"},
          "sender":"worker", "kind":"activity", "activity":"Original visible progress",
          "lease_epoch":1, "assignment_id":"assignment", "ticket_id":"ticket",
          "request_id":"event-request", "installation_id":"installation",
          "node_id":"node", "protocol":"loom.node.v1"
        }"#;
        let response = reqwest::Client::new()
            .post(format!("http://{address}/api/v1/nodes/events"))
            .bearer_auth(EVENT_NODE_TOKEN)
            .header(header::CONTENT_TYPE, "application/json")
            .body(replay_raw)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let duplicate = response.json::<Value>().await.unwrap();
        assert_eq!(duplicate["accepted"], true);
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(duplicate["message_id"], first["message_id"]);

        let replay: Value = serde_json::from_str(replay_raw).unwrap();
        let (status, duplicate) = event_request(&app, &replay).await;
        assert_eq!(status, StatusCode::OK, "{duplicate}");
        assert_eq!(duplicate["accepted"], true);
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(duplicate["message_id"], first["message_id"]);

        server.abort();
        let reopened = event_test_state(&database);
        let app = router(reopened.clone());
        let (status, duplicate) = event_request(&app, &replay).await;
        assert_eq!(status, StatusCode::OK, "{duplicate}");
        assert_eq!(duplicate["duplicate"], true);
        assert_eq!(duplicate["message_id"], first["message_id"]);
        {
            let store = reopened.lock().unwrap();
            assert_eq!(event_fixture_counts(&store, "event-request"), (1, 1));
            assert_eq!(
                store
                    .query(
                        "SELECT * FROM messages WHERE request_id='event-request'",
                        []
                    )
                    .unwrap(),
                original
            );
            assert_eq!(
                store
                    .query("SELECT * FROM requests WHERE route='events' AND request_id='event-request'", [])
                    .unwrap(),
                receipt_before
            );
        }
        let mut reordered = replay;
        reordered["metadata"]["nested"] = json!([{"a":null,"z":true}, 1]);
        let (status, conflict) = event_request(&app, &reordered).await;
        assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
        assert_eq!(conflict["error"]["code"], "idempotency_conflict");
    }

    #[tokio::test]
    async fn event_receipt_replay_is_not_corrupted_by_another_node_request_id() {
        const OTHER_TOKEN: &str = "event-other-token-123456789012345";
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("node-replay-db");
        let state = event_test_state(&database);
        state
            .lock()
            .unwrap()
            .conn()
            .execute_batch(&format!(
                "INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at) VALUES('node-two','installation-two','other-fixture-public-key','{}','online','{{}}','[]','{{}}','2026-01-01T00:00:00Z');
                 INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('grant-two','project','node-two','worker','installation-two','[\"read\"]',1,'digest-two','2026-01-01T00:00:00Z');
                 INSERT INTO tickets(id,project_id,objective,kind,relative_path,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES('ticket-other','project','other event','read_summary','README.md','running','grant-two','digest-two','node-two','installation-two','worker',1,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
                 INSERT INTO assignments(id,ticket_id,node_id,worker_id,attempt,lease_id,lease_epoch,lease_expires_at,created_at) VALUES('assignment-other','ticket-other','node-two','worker',1,'lease-other',1,'2100-01-01T00:00:00Z','2026-01-01T00:00:00Z');",
                crate::store::hash(OTHER_TOKEN)
            ))
            .unwrap();
        let app = router(state);
        let first = event_request(&app, &event_body()).await;
        let mut other = event_body();
        other["node_id"] = json!("node-two");
        other["installation_id"] = json!("installation-two");
        other["ticket_id"] = json!("ticket-other");
        other["assignment_id"] = json!("assignment-other");
        other["activity"] = json!("Independent other Node event");
        assert_eq!(
            event_request_with_token(&app, &other, OTHER_TOKEN).await.0,
            StatusCode::OK
        );
        drop(app);
        let reopened = event_test_state(&database);
        let app = router(reopened);
        let (status, replay) = event_request(&app, &event_body()).await;
        assert_eq!(status, StatusCode::OK, "{replay}");
        assert_eq!(replay["duplicate"], true);
        assert_eq!(replay["message_id"], first.1["message_id"]);
        let (status, other_replay) = event_request_with_token(&app, &other, OTHER_TOKEN).await;
        assert_eq!(status, StatusCode::OK, "{other_replay}");
        assert_eq!(other_replay["duplicate"], true);
    }

    #[tokio::test]
    async fn event_receipt_conflicts_without_mutating_original_or_current_gate() {
        let directory = tempfile::tempdir().unwrap();
        let state = event_test_state(directory.path());
        let app = router(state.clone());
        assert_eq!(event_request(&app, &event_body()).await.0, StatusCode::OK);
        let original = {
            let store = state.lock().unwrap();
            store
                .query(
                    "SELECT * FROM messages WHERE request_id='event-request'",
                    [],
                )
                .unwrap()
        };
        let variants = [
            ("activity", json!("Changed content")),
            (
                "content",
                json!("Fallback content changes the complete body"),
            ),
            ("kind", json!("heartbeat")),
            ("sender", json!("assistant")),
            (
                "session_ref",
                json!({"session_id":"other","observed_seq":3}),
            ),
            ("assignment_id", json!("assignment-two")),
            ("ticket_id", json!("ticket-two")),
            ("lease_epoch", json!(3)),
            ("source_verified", json!(true)),
            ("unrelated_extra_field", json!(false)),
        ];
        for (field, value) in variants {
            let mut changed = event_body();
            if matches!(field, "assignment_id" | "ticket_id" | "lease_epoch") {
                // The second legal Assignment has a different current epoch;
                // reusing the same opaque ID must still hit the Node receipt gate.
                changed["ticket_id"] = json!("ticket-two");
                changed["assignment_id"] = json!("assignment-two");
                changed["lease_epoch"] = json!(3);
            }
            changed[field] = value;
            let (status, body) = event_request(&app, &changed).await;
            assert_eq!(status, StatusCode::CONFLICT, "{field}: {body}");
            assert_eq!(body["error"]["code"], "idempotency_conflict", "{field}");
            let store = state.lock().unwrap();
            assert_eq!(event_fixture_counts(&store, "event-request"), (1, 1));
            assert_eq!(
                store
                    .query(
                        "SELECT * FROM messages WHERE request_id='event-request'",
                        []
                    )
                    .unwrap(),
                original,
                "{field}"
            );
        }
        let mut stale = event_body();
        stale["lease_epoch"] = json!(99);
        let (status, body) = event_request(&app, &stale).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["error"]["code"], "stale_lease");
    }

    #[tokio::test]
    async fn event_legacy_collision_is_proved_and_source_namespace_stays_separate() {
        let directory = tempfile::tempdir().unwrap();
        let state = event_test_state(directory.path());
        let app = router(state.clone());
        {
            let store = state.lock().unwrap();
            store.conn().execute(
                "INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id) VALUES('legacy','ticket','worker','concierge','activity','Original visible progress',' { \"observed_seq\":3, \"session_id\":\"session\" } ','summary','2026-01-01T00:00:00Z','legacy-request')",
                [],
            ).unwrap();
            // Same scalar request_id on a different Ticket proves source_event_id
            // rather than the (ticket_id,request_id) key separates those histories.
            store.conn().execute_batch(
                "INSERT INTO source_instances(id,owner_key,source_key,kind,definition_digest,created_at,updated_at) VALUES('source','legacy-source','key','webhook','digest','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
                 INSERT INTO source_threads(id,source_id,client_thread_id,last_sequence,created_at,updated_at) VALUES('thread','source','client',0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
                 INSERT INTO source_events(id,source_id,thread_id,external_event_id,kind,content,payload_digest,received_at,source_sequence,thread_sequence) VALUES('source-event','source','thread','legacy','user_message','Legacy source collision','digest','2026-01-01T00:00:00Z',1,1);
                 INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,visibility,created_at,request_id,source_event_id) VALUES('source-message','ticket-two','user','concierge','conversation','Legacy source collision','private','2026-01-01T00:00:00Z','legacy:collision','source-event');",
            ).unwrap();
        }
        let mut legacy = event_body();
        legacy["request_id"] = json!("legacy-request");
        let (status, replay) = event_request(&app, &legacy).await;
        assert_eq!(status, StatusCode::OK, "{replay}");
        assert_eq!(replay["duplicate"], true);
        assert_eq!(replay["message_id"], "legacy");
        assert_eq!(
            event_fixture_counts(&state.lock().unwrap(), "legacy-request"),
            (1, 0)
        );

        state.lock().unwrap().conn().execute(
            "UPDATE messages SET session_ref='{\"session_id\":\"different\",\"observed_seq\":3}' WHERE id='legacy'",
            [],
        ).unwrap();
        let (status, conflict) = event_request(&app, &legacy).await;
        assert_eq!(status, StatusCode::CONFLICT, "{conflict}");
        assert_eq!(conflict["error"]["code"], "idempotency_conflict");

        let mut independent = event_body();
        independent["request_id"] = json!("legacy:collision");
        let (status, accepted) = event_request(&app, &independent).await;
        assert_eq!(status, StatusCode::OK, "{accepted}");
        assert_eq!(accepted["duplicate"], false);
        let store = state.lock().unwrap();
        assert_eq!(event_fixture_counts(&store, "legacy:collision"), (2, 1));
        assert_eq!(
            store
                .query(
                    "SELECT source_event_id FROM messages WHERE id='source-message'",
                    []
                )
                .unwrap()[0]["source_event_id"],
            "source-event"
        );
    }

    #[tokio::test]
    async fn event_receipt_replays_the_validated_normalized_session_projection() {
        let directory = tempfile::tempdir().unwrap();
        let state = event_test_state(directory.path());
        let artifact_id = "22222222-2222-4222-8222-222222222222";
        let session_id = "11111111-1111-4111-8111-111111111111";
        let pipeline_id = "33333333-3333-4333-8333-333333333333";
        let artifact_bytes = b"source";
        let artifact_digest = crate::sha256(artifact_bytes);
        let parent_session = json!({
            "harness":"dsh", "session_id":session_id, "protocol":"dsh-session-log",
            "host_api":"bounded-fixture-host", "observed_seq":1,
        });
        {
            let store = state.lock().unwrap();
            // A known already-produced bounded document source, not a claimed
            // live DSH Agent. Only owned fixture rows and source bytes are used.
            store.conn().execute(
                "UPDATE tickets SET kind='edit_file',relative_path='docs/derived.txt' WHERE id='ticket'",
                [],
            ).unwrap();
            store
                .conn()
                .execute(
                    "UPDATE grants SET operations='[\"read\",\"write\"]' WHERE id='grant'",
                    [],
                )
                .unwrap();
            store.conn().execute(
                "INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at)
                 VALUES('parent-grant','project','node','worker','installation','[\"read\"]',1,'parent-digest','2026-01-01T00:00:00Z')",
                [],
            ).unwrap();
            store.conn().execute(
                "INSERT INTO tickets(id,project_id,objective,kind,relative_path,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at)
                 VALUES('parent-ticket','project','Read the bounded parent source','read_summary','docs/source.txt','succeeded','parent-grant','parent-digest','node','installation','worker',1,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')",
                [],
            ).unwrap();
            let at = crate::now();
            store.conn().execute(
                "INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at)
                 VALUES(?1,'parent-ticket','parent-assignment','node','bounded-source.txt','text/plain',?2,?3,?4,?5,'[]',?6)",
                params![artifact_id,artifact_bytes.len() as i64,artifact_digest,format!("{artifact_id}.artifact"),format!("loom://artifact/{artifact_id}"),at],
            ).unwrap();
            std::fs::create_dir_all(store.root.join("artifacts")).unwrap();
            std::fs::write(
                store
                    .root
                    .join("artifacts")
                    .join(format!("{artifact_id}.artifact")),
                artifact_bytes,
            )
            .unwrap();
            let definition = json!({
                "schema":crate::pipeline::SCHEMA,"version":1,"pipeline_id":pipeline_id,
                "project_id":"project","name":"Bounded normalized receipt fixture",
                "read":{"stage_id":"read","kind":"read_summary","grant_id":"parent-grant","relative_path":"docs/source.txt"},
                "edit":{"stage_id":"edit","kind":"edit_file","grant_id":"grant","relative_path":"docs/derived.txt","depends_on":["read"],"transform":"trim"},
            });
            store.conn().execute(
                "INSERT INTO document_pipeline_runs(id,project_id,name,definition_json,definition_digest,created_at,updated_at)
                 VALUES(?1,'project','Bounded normalized receipt fixture',?2,?3,?4,?4)",
                params![pipeline_id,definition.to_string(),crate::store::hash(&definition.to_string()),at],
            ).unwrap();
            for (stage, ticket, grant, checkpoint) in [
                ("read", "parent-ticket", "parent-grant", "succeeded"),
                ("edit", "ticket", "grant", "pending"),
            ] {
                store.conn().execute(
                    "INSERT INTO document_pipeline_stages(pipeline_id,stage_id,ticket_id,raw_grant_id,checkpoint_state,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?6)",
                    params![pipeline_id,stage,ticket,grant,checkpoint,at],
                ).unwrap();
            }
            store.conn().execute(
                "INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id)
                 VALUES('parent-public-session','parent-ticket','worker','concierge','session_link','Known bounded parent Session',?1,'summary',?2,'parent-session-request')",
                params![parent_session.to_string(),at],
            ).unwrap();
        }
        let mut event = event_body();
        event["request_id"] = json!("normalized-replay");
        event["activity"] = json!("One source-derived process link");
        event["kind"] = json!("session_link");
        event["session_ref"] = json!({
            "harness":"caller-supplied-presentation", "protocol":"dsh-session-log",
            "host_api":"bounded-fixture-child", "session_id":session_id, "observed_seq":1,
            "delegated_from":{
                "type":"artifact_ref", "artifact_id":artifact_id, "ticket_id":"parent-ticket",
                "origin_node_id":"node", "sha256":artifact_digest,
                "location":format!("loom://artifact/{artifact_id}"), "parents":[],
                "session":parent_session, "source_verified":false,
            },
        });
        let app = router(state.clone());
        let (status, first) = event_request(&app, &event).await;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["accepted"], true);
        assert!(first.get("stored_session_ref").is_none());
        let child_id = first["message_id"].as_str().unwrap().to_owned();
        let (message, receipt) = {
            let store = state.lock().unwrap();
            let message = store
                .query("SELECT * FROM messages WHERE id=?1", [child_id.as_str()])
                .unwrap()
                .remove(0);
            let session: Value =
                serde_json::from_str(message["session_ref"].as_str().unwrap()).unwrap();
            let relation = &session["delegated_from"];
            assert_eq!(session["harness"], "dsh");
            assert_eq!(relation["source_verified"], true);
            assert_eq!(
                relation["validated_by"],
                "current_assignment_and_pipeline_relation"
            );
            let receipt = &store.query("SELECT * FROM requests WHERE route='events' AND request_id='normalized-replay'", []).unwrap()[0];
            let persisted: Value =
                serde_json::from_str(receipt["response"].as_str().unwrap()).unwrap();
            assert_eq!(persisted["stored_session_ref"], session);
            (message, receipt.clone())
        };
        // The immutable capture no longer needs a second lookup of the parent
        // Session row. This fixture deletion does not delete the already accepted
        // child event and is not a simulated provider/session acknowledgement.
        state
            .lock()
            .unwrap()
            .conn()
            .execute(
                "DELETE FROM messages WHERE ticket_id='parent-ticket' AND kind='session_link'",
                [],
            )
            .unwrap();
        let (status, replay) = event_request(&app, &event).await;
        assert_eq!(status, StatusCode::OK, "{replay}");
        assert_eq!(replay["duplicate"], true);
        assert_eq!(replay["message_id"], child_id);
        assert!(replay.get("stored_session_ref").is_none());
        {
            let store = state.lock().unwrap();
            assert_eq!(event_fixture_counts(&store, "normalized-replay"), (1, 1));
            assert_eq!(
                store
                    .query("SELECT * FROM messages WHERE id=?1", [child_id.as_str()])
                    .unwrap()
                    .remove(0),
                message
            );
            assert_eq!(receipt, store.query("SELECT * FROM requests WHERE route='events' AND request_id='normalized-replay'", []).unwrap()[0]);
            assert_eq!(
                store.query("SELECT COUNT(*) AS n FROM grants", []).unwrap()[0]["n"],
                2
            );
            assert_eq!(
                store
                    .query("SELECT COUNT(*) AS n FROM reports", [])
                    .unwrap()[0]["n"],
                0
            );
            assert_eq!(
                store
                    .query("SELECT COUNT(*) AS n FROM effects", [])
                    .unwrap()[0]["n"],
                0
            );
            assert_eq!(
                store
                    .query("SELECT COUNT(*) AS n FROM artifacts", [])
                    .unwrap()[0]["n"],
                1
            );
        }
    }

    #[tokio::test]
    async fn event_receipt_integrity_and_transaction_rollback_are_not_fake_duplicates() {
        let directory = tempfile::tempdir().unwrap();
        let state = event_test_state(directory.path());
        let app = router(state.clone());
        assert_eq!(event_request(&app, &event_body()).await.0, StatusCode::OK);
        let original = state
            .lock()
            .unwrap()
            .query("SELECT * FROM requests WHERE route='events'", [])
            .unwrap();
        // Even otherwise identical text/session metadata does not allow this
        // receipt to point at a message carrying a different request identity.
        let mut sibling = event_body();
        sibling["request_id"] = json!("sibling-event-request");
        assert_eq!(event_request(&app, &sibling).await.0, StatusCode::OK);
        let sibling_message = state
            .lock()
            .unwrap()
            .query(
                "SELECT * FROM messages WHERE request_id='sibling-event-request'",
                [],
            )
            .unwrap()[0]
            .clone();
        {
            let store = state.lock().unwrap();
            let mut wrong_pointer: Value =
                serde_json::from_str(original[0]["response"].as_str().unwrap()).unwrap();
            wrong_pointer["message_id"] = json!(sibling_message["id"]);
            store.conn().execute(
                "UPDATE requests SET response=?1 WHERE route='events' AND request_id='event-request'",
                [wrong_pointer.to_string()],
            ).unwrap();
        }
        let (status, wrong_link) = event_request(&app, &event_body()).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{wrong_link}");
        assert_eq!(wrong_link["error"]["code"], "receipt_corrupt");
        assert_eq!(
            event_fixture_counts(&state.lock().unwrap(), "event-request"),
            (1, 1)
        );
        assert_eq!(
            event_fixture_counts(&state.lock().unwrap(), "sibling-event-request"),
            (1, 1)
        );
        state.lock().unwrap().conn().execute(
            "UPDATE requests SET response='not JSON' WHERE route='events' AND request_id='event-request'",
            [],
        ).unwrap();
        let (status, corrupt) = event_request(&app, &event_body()).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{corrupt}");
        assert_eq!(corrupt["error"]["code"], "receipt_corrupt");
        assert_eq!(
            event_fixture_counts(&state.lock().unwrap(), "event-request"),
            (1, 1)
        );

        state.lock().unwrap().conn().execute(
            "UPDATE requests SET response=?1 WHERE route='events' AND request_id='event-request'",
            [original[0]["response"].as_str().unwrap()],
        ).unwrap();
        state
            .lock()
            .unwrap()
            .conn()
            .execute("DELETE FROM messages WHERE request_id='event-request'", [])
            .unwrap();
        let (status, missing) = event_request(&app, &event_body()).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{missing}");
        assert_eq!(missing["error"]["code"], "receipt_corrupt");
        assert_eq!(
            event_fixture_counts(&state.lock().unwrap(), "event-request"),
            (0, 1)
        );

        // A controlled receipt write failure must roll back its just-created message.
        let mut fresh = event_body();
        fresh["request_id"] = json!("atomic-first-call");
        state.lock().unwrap().conn().execute_batch(
            "CREATE TEMP TRIGGER deny_event_receipt BEFORE INSERT ON requests
             WHEN NEW.route='events' BEGIN SELECT RAISE(ABORT,'fixture denies event receipt'); END;",
        ).unwrap();
        let (status, failed) = event_request(&app, &fresh).await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{failed}");
        assert_eq!(failed["error"]["code"], "storage_error");
        assert_eq!(
            event_fixture_counts(&state.lock().unwrap(), "atomic-first-call"),
            (0, 0)
        );
        state
            .lock()
            .unwrap()
            .conn()
            .execute("DROP TRIGGER deny_event_receipt", [])
            .unwrap();
        assert_eq!(event_request(&app, &fresh).await.0, StatusCode::OK);
        assert_eq!(
            event_fixture_counts(&state.lock().unwrap(), "atomic-first-call"),
            (1, 1)
        );
    }

    async fn post_json(app: &Router, uri: String, token: &str, body: Value) -> Response {
        app.clone()
            .oneshot(
                axum::extract::Request::builder()
                    .method("POST")
                    .uri(uri)
                    .header(header::AUTHORIZATION, format!("Bearer {token}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    fn priority_test_state(online: bool) -> (tempfile::TempDir, Arc<State>, &'static str) {
        const TOKEN: &str = "ticket-priority-test-token-12345";
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir(&root).unwrap();
        let store = crate::store::Store::open(directory.path().join("db")).unwrap();
        store
            .set_setting("client_token_hash", &crate::store::hash(TOKEN))
            .unwrap();
        let now = crate::now();
        store
            .conn()
            .execute(
                "INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','Priority fixture',?1,'read_only',1,?2,'{}')",
                params![root.to_string_lossy(), now],
            )
            .unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding','project','node','installation','default',?1,'binding-digest',?2)",
                params![root.to_string_lossy(), now],
            )
            .unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant','project','node','default','installation','[\"read\"]',1,'grant-digest',?1,'binding')",
                [&now],
            )
            .unwrap();
        let heartbeat = if online {
            now.as_str()
        } else {
            "2026-01-01T00:00:00Z"
        };
        store
            .conn()
            .execute(
                "INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node','installation','public','token',?1,?2,?3,?4,?5,?5)",
                params![
                    if online { "online" } else { "registered" },
                    json!([{"ticket_kind":"read_summary","permission":"read"}]).to_string(),
                    json!([{"worker_id":"default","status":"online"}]).to_string(),
                    json!({"project_roots":{"project":root}}).to_string(),
                    heartbeat,
                ],
            )
            .unwrap();
        let state = Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: TOKEN.into(),
            bootstrap_token_written: false,
        });
        (directory, state, TOKEN)
    }

    fn priority_ticket(priority: Option<Value>) -> Value {
        let mut ticket = json!({
            "project_id":"project", "objective":"ordinary priority fixture",
            "kind":"read_summary", "relative_path":"README.md",
            "grant_id":"grant", "node_id":"node", "worker_id":"default"
        });
        if let Some(priority) = priority {
            ticket["priority"] = priority;
        }
        ticket
    }

    #[tokio::test]
    async fn ordinary_ticket_priority_is_strict_and_persisted_through_real_http() {
        let (_directory, state, token) = priority_test_state(true);
        let app = router(state.clone());
        for invalid in [
            json!(null),
            json!(true),
            json!("80"),
            json!(1.5),
            json!(101),
            json!(-101),
        ] {
            let before = state.lock().unwrap().list("tickets").unwrap().len();
            let response = post_json(
                &app,
                "/api/v1/tickets".into(),
                token,
                priority_ticket(Some(invalid.clone())),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{invalid}");
            assert_eq!(state.lock().unwrap().list("tickets").unwrap().len(), before);
        }
        let unauthenticated = app
            .clone()
            .oneshot(
                axum::extract::Request::builder()
                    .method("POST")
                    .uri("/api/v1/tickets")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(priority_ticket(Some(json!(80))).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthenticated.status(), StatusCode::UNAUTHORIZED);
        for priority in [80, -100, 100, 0] {
            let response = post_json(
                &app,
                "/api/v1/tickets".into(),
                token,
                priority_ticket(Some(json!(priority))),
            )
            .await;
            let (status, body) = response_json(response).await;
            assert_eq!(status, StatusCode::OK, "{priority}: {body}");
            assert_eq!(body["priority"], priority);
            assert_eq!(
                state
                    .lock()
                    .unwrap()
                    .detail(body["id"].as_str().unwrap())
                    .unwrap()["priority"],
                priority
            );
        }
        let response =
            post_json(&app, "/api/v1/tickets".into(), token, priority_ticket(None)).await;
        let (status, body) = response_json(response).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["priority"], 0);
        assert_eq!(
            state.lock().unwrap().list("grants").unwrap()[0]["operations"],
            json!(["read"])
        );
        assert_eq!(state.lock().unwrap().list("tickets").unwrap().len(), 5);
    }

    #[tokio::test]
    async fn source_ticket_rejects_any_priority_without_touching_frozen_provenance() {
        let (_directory, state, token) = priority_test_state(true);
        let app = router(state.clone());
        let source = crate::source_events::register(
            &mut state.lock().unwrap(),
            serde_json::from_value(json!({"source_key":"priority-source"})).unwrap(),
        )
        .unwrap();
        let source_id = source["source"]["id"].as_str().unwrap();
        for (index, priority) in [json!(80), json!(0), json!(-100)].into_iter().enumerate() {
            let event_id = format!("source-priority-{index}");
            let event = crate::source_events::ingest(
                &mut state.lock().unwrap(),
                serde_json::from_value(json!({"source_id":source_id,"thread_id":"read","event_id":event_id,"content":"Source prompt cannot tune scheduling"})).unwrap(),
            )
            .unwrap();
            let response = post_json(
                &app,
                "/api/v1/tickets".into(),
                token,
                json!({
                    "project_id":"project", "objective":"Source prompt cannot tune scheduling",
                    "kind":"read_summary", "relative_path":"README.md", "grant_id":"grant",
                    "node_id":"node", "worker_id":"default", "source_event_id":event["id"],
                    "priority":priority
                }),
            )
            .await;
            let (status, body) = response_json(response).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{priority}: {body}");
            assert_eq!(body["error"]["code"], "source_task_scope");
            let event = crate::source_events::lookup_client_event(
                &state.lock().unwrap(),
                event["id"].as_str().unwrap(),
            )
            .unwrap();
            assert_eq!(event["task_ticket_id"], Value::Null);
            assert_eq!(event["task_spec"], Value::Null);
        }
        assert_eq!(state.lock().unwrap().list("tickets").unwrap().len(), 0);
    }

    #[tokio::test]
    async fn waiting_approval_retains_signed_priority_until_explicit_approval() {
        let (_directory, state, token) = priority_test_state(false);
        let app = router(state.clone());
        let response = post_json(
            &app,
            "/api/v1/tickets".into(),
            token,
            priority_ticket(Some(json!(-70))),
        )
        .await;
        let (status, body) = response_json(response).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["status"], "waiting_approval");
        assert_eq!(body["priority"], -70);
        let ticket_id = body["id"].as_str().unwrap().to_owned();
        let stored = state.lock().unwrap().detail(&ticket_id).unwrap();
        assert_eq!(stored["priority"], -70);
        assert!(stored["assignments"].as_array().unwrap().is_empty());
        let waiting = state.lock().unwrap().audits(Some(&ticket_id)).unwrap();
        let evidence: Value =
            serde_json::from_str(waiting[0]["evidence"].as_str().unwrap()).unwrap();
        assert_eq!(evidence["evidence"]["priority"], -70);
        let grant_before = state
            .lock()
            .unwrap()
            .get("grants", "grant")
            .unwrap()
            .unwrap();
        let approved = post_json(
            &app,
            format!("/api/v1/tickets/{ticket_id}/approval"),
            token,
            json!({"decision":"approve","approval_id":"priority-approval","reason":"Explicitly authorize this already saved Ticket"}),
        )
        .await;
        let (status, approved) = response_json(approved).await;
        assert_eq!(status, StatusCode::OK, "{approved}");
        assert_eq!(approved["priority"], -70);
        assert_eq!(approved["assignments"].as_array().unwrap().len(), 1);
        assert_eq!(
            state
                .lock()
                .unwrap()
                .get("grants", "grant")
                .unwrap()
                .unwrap(),
            grant_before
        );
    }

    #[tokio::test]
    async fn public_retry_refuses_waiting_ticket_but_exact_approval_issues_first_attempt() {
        const TOKEN: &str = "test-client-token-123456789012345";
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(directory.path()).unwrap();
        store
            .set_setting("client_token_hash", &crate::store::hash(TOKEN))
            .unwrap();
        store.conn().execute_batch("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','Approval fixture','/owned/approval-fixture','read_write',1,'2026-01-01T00:00:00Z','{\"revision\":\"approval-revision\"}'); INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding','project','node','installation','worker','/owned/approval-fixture','binding-digest','2026-01-01T00:00:00Z'); INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant','project','node','worker','installation','[\"read\"]',1,'grant-digest','2026-01-01T00:00:00Z','binding'); INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES('ticket','project','Waiting for explicit approval','read_summary','README.md','Original request','waiting_approval','grant','grant-digest','node','installation','worker',0,0,'2026-01-01T00:01:00Z','2026-01-01T00:01:00Z');").unwrap();
        let state = Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: TOKEN.into(),
            bootstrap_token_written: false,
        });
        let app = router(state.clone());
        let original = state.lock().unwrap().detail("ticket").unwrap();
        let grants = state.lock().unwrap().list("grants").unwrap();
        let bindings = state
            .lock()
            .unwrap()
            .query("SELECT * FROM project_bindings", [])
            .unwrap();

        let direct = post_json(
            &app,
            "/api/v1/tickets/ticket/retry".into(),
            TOKEN,
            json!({}),
        )
        .await;
        assert_eq!(direct.status(), StatusCode::BAD_REQUEST);
        {
            let store = state.lock().unwrap();
            assert_eq!(store.detail("ticket").unwrap(), original);
            assert!(store.audits(Some("ticket")).unwrap().is_empty());
        }

        let approved = post_json(
            &app,
            "/api/v1/tickets/ticket/approval".into(),
            TOKEN,
            json!({"decision":"approve","approval_id":"approval-1","reason":"Authorized fixture execution"}),
        )
        .await;
        assert_eq!(approved.status(), StatusCode::OK);
        let response: Value = serde_json::from_slice(
            &axum::body::to_bytes(approved.into_body(), 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(response["status"], "running");
        assert_eq!(response["attempt"], 1);
        assert_eq!(response["grant_id"], original["grant_id"]);
        assert_eq!(response["grant_digest"], original["grant_digest"]);
        for field in [
            "id",
            "project_id",
            "objective",
            "kind",
            "relative_path",
            "content",
            "node_id",
            "installation_id",
            "worker_id",
            "cancel_requested",
            "created_at",
        ] {
            assert_eq!(response[field], original[field]);
        }
        let assignments = response["assignments"].as_array().unwrap();
        assert_eq!(assignments.len(), 1);
        assert_eq!(assignments[0]["attempt"], 1);
        assert_eq!(assignments[0]["lease_epoch"], 1);
        assert_eq!(assignments[0]["node_id"], original["node_id"]);
        assert_eq!(assignments[0]["worker_id"], original["worker_id"]);
        {
            let store = state.lock().unwrap();
            assert_eq!(store.list("grants").unwrap(), grants);
            assert_eq!(
                store.query("SELECT * FROM project_bindings", []).unwrap(),
                bindings
            );
            let audits = store.audits(Some("ticket")).unwrap();
            assert_eq!(audits.len(), 2);
            assert_eq!(audits[0]["action"], "assignment.retried");
            assert_eq!(audits[1]["action"], "task.approval_granted");
            for audit in &audits {
                let evidence: Value =
                    serde_json::from_str(audit["evidence"].as_str().unwrap()).unwrap();
                if audit["action"] == "assignment.retried" {
                    assert_eq!(evidence["evidence"]["assignment_id"], assignments[0]["id"]);
                    assert_eq!(evidence["evidence"]["lease_id"], assignments[0]["lease_id"]);
                    assert_eq!(evidence["evidence"]["lease_epoch"], 1);
                } else {
                    assert_eq!(evidence["evidence"]["approval_id"], "approval-1");
                    assert_eq!(
                        evidence["evidence"]["reason"],
                        "Authorized fixture execution"
                    );
                    assert_eq!(evidence["evidence"]["decision"], "approve");
                    assert_eq!(evidence["evidence"]["grant_created"], false);
                }
            }
            assert!(store.verify_audit().unwrap());
        }

        let repeated = post_json(
            &app,
            "/api/v1/tickets/ticket/approval".into(),
            TOKEN,
            json!({"decision":"approve","approval_id":"approval-2","reason":"Repeated decision cannot issue again"}),
        )
        .await;
        assert_eq!(repeated.status(), StatusCode::CONFLICT);
        let store = state.lock().unwrap();
        assert_eq!(
            store.detail("ticket").unwrap()["assignments"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(store.audits(Some("ticket")).unwrap().len(), 2);
    }

    #[tokio::test]
    async fn approval_reason_is_normalized_bounded_and_rejection_can_precede_one_real_approval() {
        const TOKEN: &str = "test-client-token-123456789012345";
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(directory.path()).unwrap();
        store
            .set_setting("client_token_hash", &crate::store::hash(TOKEN))
            .unwrap();
        store.conn().execute_batch("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','Approval fixture','/owned/approval-fixture','read_write',1,'2026-01-01T00:00:00Z','{\"revision\":\"approval-revision\"}'); INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding','project','node','installation','worker','/owned/approval-fixture','binding-digest','2026-01-01T00:00:00Z'); INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant','project','node','worker','installation','[\"read\"]',1,'grant-digest','2026-01-01T00:00:00Z','binding'); INSERT INTO tickets(id,project_id,objective,kind,relative_path,content,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES('ticket','project','Waiting for explicit approval','read_summary','README.md','Original request','waiting_approval','grant','grant-digest','node','installation','worker',0,0,'2026-01-01T00:01:00Z','2026-01-01T00:01:00Z');").unwrap();
        let state = Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: TOKEN.into(),
            bootstrap_token_written: false,
        });
        let app = router(state.clone());
        let before = state.lock().unwrap().detail("ticket").unwrap();
        let before_audits = state.lock().unwrap().audits(None).unwrap();
        for decision in ["approve", "reject"] {
            for reason in [
                Value::Null,
                json!("   \t\n"),
                json!("r".repeat(1001)),
                json!(42),
            ] {
                let response = post_json(
                    &app,
                    "/api/v1/tickets/ticket/approval".into(),
                    TOKEN,
                    json!({"decision":decision,"approval_id":"reason-validation","reason":reason}),
                )
                .await;
                assert_eq!(response.status(), StatusCode::BAD_REQUEST);
                assert_eq!(state.lock().unwrap().detail("ticket").unwrap(), before);
                assert_eq!(state.lock().unwrap().audits(None).unwrap(), before_audits);
            }
        }
        let boundary = post_json(
            &app,
            "/api/v1/tickets/ticket/approval".into(),
            TOKEN,
            json!({"decision":"reject","approval_id":"boundary-hold","reason":"r".repeat(1000)}),
        )
        .await;
        assert_eq!(boundary.status(), StatusCode::OK);
        let rejected: Value = serde_json::from_slice(
            &axum::body::to_bytes(boundary.into_body(), 1024 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(rejected["status"], "waiting_approval");
        assert_eq!(rejected["cancel_requested"], false);
        assert_eq!(rejected["assignments"].as_array().unwrap().len(), 0);
        {
            let store = state.lock().unwrap();
            let audits = store.audits(Some("ticket")).unwrap();
            assert_eq!(audits.len(), 1);
            assert_eq!(audits[0]["action"], "task.approval_rejected");
            assert_eq!(audits[0]["actor"], "client");
            assert_eq!(audits[0]["ticket_id"], "ticket");
            let envelope: Value =
                serde_json::from_str(audits[0]["evidence"].as_str().unwrap()).unwrap();
            assert_eq!(envelope["evidence"]["reason"], "r".repeat(1000));
            assert_eq!(envelope["evidence"]["approval_id"], "boundary-hold");
            assert_eq!(envelope["evidence"]["decision"], "reject");
            assert_eq!(envelope["evidence"]["assignment_created"], false);
        }
        let approved = post_json(
            &app,
            "/api/v1/tickets/ticket/approval".into(),
            TOKEN,
            json!({"decision":"approve","approval_id":"approval-after-hold","reason":"  Approved after preserving a separate rejection <reason>  "}),
        )
        .await;
        assert_eq!(approved.status(), StatusCode::OK);
        let repeated = post_json(
            &app,
            "/api/v1/tickets/ticket/approval".into(),
            TOKEN,
            json!({"decision":"reject","approval_id":"not-id-replay","reason":"This is an inadmissible later state, not a replay"}),
        )
        .await;
        assert_eq!(repeated.status(), StatusCode::CONFLICT);
        let store = state.lock().unwrap();
        let detail = store.detail("ticket").unwrap();
        assert_eq!(detail["assignments"].as_array().unwrap().len(), 1);
        assert_eq!(detail["attempt"], 1);
        let audits = store.audits(Some("ticket")).unwrap();
        assert_eq!(audits.len(), 3);
        let granted: Value = serde_json::from_str(audits[2]["evidence"].as_str().unwrap()).unwrap();
        assert_eq!(
            granted["evidence"]["reason"],
            "Approved after preserving a separate rejection <reason>"
        );
        assert_eq!(granted["evidence"]["approval_id"], "approval-after-hold");
        assert!(store.verify_audit().unwrap());
    }

    async fn assert_route_error_preserves_ticket_and_audit(
        app: &Router,
        state: &State,
        uri: String,
        token: &str,
        body: Value,
    ) {
        let before = state.lock().unwrap().detail("ticket").unwrap();
        let audits = state.lock().unwrap().audits(None).unwrap();
        let response = post_json(app, uri, token, body).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let store = state.lock().unwrap();
        assert_eq!(store.detail("ticket").unwrap(), before);
        assert_eq!(store.audits(None).unwrap(), audits);
        assert!(store
            .audits(Some("ticket"))
            .unwrap()
            .iter()
            .all(|entry| entry["action"] != "ticket.retried"));
    }

    #[tokio::test]
    async fn succeeded_or_already_issued_public_retry_never_audits_a_no_op_as_retried() {
        const TOKEN: &str = "test-client-token-123456789012345";
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(directory.path()).unwrap();
        store
            .set_setting("client_token_hash", &crate::store::hash(TOKEN))
            .unwrap();
        store.conn().execute_batch("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','Approval fixture','/owned/retry-fixture','read_write',1,'2026-01-01T00:00:00Z','{}'); INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at) VALUES('grant','project','node','worker','installation','[\"read\"]',1,'grant-digest','2026-01-01T00:00:00Z'); INSERT INTO tickets(id,project_id,objective,kind,relative_path,status,grant_id,grant_digest,node_id,installation_id,worker_id,attempt,cancel_requested,created_at,updated_at) VALUES('ticket','project','Succeeded historical work','read_summary','README.md','succeeded','grant','grant-digest','node','installation','worker',1,0,'2026-01-01T00:01:00Z','2026-01-01T00:01:00Z');").unwrap();
        let state = Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: TOKEN.into(),
            bootstrap_token_written: false,
        });
        let app = router(state.clone());
        assert_route_error_preserves_ticket_and_audit(
            &app,
            &state,
            "/api/v1/tickets/ticket/retry".into(),
            TOKEN,
            json!({}),
        )
        .await;
        assert!(state
            .lock()
            .unwrap()
            .audits(Some("ticket"))
            .unwrap()
            .is_empty());

        state
            .lock()
            .unwrap()
            .conn()
            .execute(
                "UPDATE tickets SET status='waiting_approval',attempt=0 WHERE id='ticket'",
                [],
            )
            .unwrap();
        let approved = post_json(
            &app,
            "/api/v1/tickets/ticket/approval".into(),
            TOKEN,
            json!({"decision":"approve","approval_id":"approval-1","reason":"Authorized fixture execution"}),
        )
        .await;
        assert_eq!(approved.status(), StatusCode::OK);
        assert_route_error_preserves_ticket_and_audit(
            &app,
            &state,
            "/api/v1/tickets/ticket/retry".into(),
            TOKEN,
            json!({}),
        )
        .await;
        let store = state.lock().unwrap();
        assert_eq!(
            store.detail("ticket").unwrap()["assignments"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(store.audits(Some("ticket")).unwrap().len(), 2);
    }

    #[test]
    fn static_serving_only_accepts_bounded_public_directory() {
        assert_eq!(
            public_web_path("assets/index.js"),
            Some(PathBuf::from("assets/index.js"))
        );
        assert_eq!(
            public_web_path("manifest.webmanifest"),
            Some(PathBuf::from("manifest.webmanifest"))
        );
        for input in [
            "../../foo.js",
            ".env",
            "assets/.secret.key",
            "assets/a\\b.js",
            "assets/thing.exe",
        ] {
            assert!(
                public_web_path(input).is_none(),
                "unexpected static path: {input}"
            );
        }
    }
    #[tokio::test]
    async fn messages_can_be_retrieved_by_a_bounded_ticket_id() {
        let directory = tempfile::tempdir().unwrap();
        let db = crate::store::Store::open(directory.path()).unwrap();
        db.set_setting(
            "client_token_hash",
            &crate::store::hash("test-client-token-123456789012345"),
        )
        .unwrap();
        db.conn().execute("INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id) VALUES('global',NULL,'worker','concierge','activity','global',NULL,'summary','2026-01-01T00:00:00Z','global')", []).unwrap();
        db.conn().execute("INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id) VALUES('delegated','tkt_child','worker','concierge','session_link','delegated','{\"artifact_id\":\"source\"}','summary','2026-01-01T00:00:01Z','delegated')", []).unwrap();
        let app = router(Arc::new(State {
            store: Arc::new(Mutex::new(db)),
            bootstrap_token: "test-client-token-123456789012345".into(),
            bootstrap_token_written: false,
        }));
        let response = app
            .oneshot(
                axum::extract::Request::builder()
                    .method("GET")
                    .uri("/api/v1/messages?ticket_id=tkt_child")
                    .header(
                        axum::http::header::AUTHORIZATION,
                        "Bearer test-client-token-123456789012345",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["messages"].as_array().unwrap().len(), 1);
        assert_eq!(value["messages"][0]["id"], "delegated");
    }

    #[tokio::test]
    async fn preferences_report_exact_scope_and_explicit_override() {
        const TOKEN: &str = "test-client-token-123456789012345";
        let directory = tempfile::tempdir().unwrap();
        let project_root = directory.path().join("project");
        std::fs::create_dir(&project_root).unwrap();
        let store = crate::store::Store::open(directory.path().join("db")).unwrap();
        store
            .set_setting("client_token_hash", &crate::store::hash(TOKEN))
            .unwrap();
        assert_eq!(
            store
                .conn()
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            16,
            "preference reads require no schema migration"
        );
        let now = crate::now();
        store
            .conn()
            .execute(
                "INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','fixture',?1,'read_only',1,?2,'{}')",
                params![project_root.to_string_lossy(), now],
            )
            .unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding','project','node','installation','default',?1,'binding-proof',?2)",
                params![project_root.to_string_lossy(), now],
            )
            .unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES('grant','project','node','default','installation','[\"read\"]',1,'digest',?1,'binding')",
                [&now],
            )
            .unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node','installation','public','token','online',?1,?2,?3,?4,?4)",
                params![
                    json!([{"ticket_kind":"read_summary","permission":"read"}]).to_string(),
                    json!([{"worker_id":"default","status":"online"}]).to_string(),
                    json!({"project_roots":{"project":project_root}}).to_string(),
                    now,
                ],
            )
            .unwrap();
        let app = router(Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: TOKEN.into(),
            bootstrap_token_written: false,
        }));
        let request = |method: &str, uri: String, body: Option<Value>| {
            let mut builder = axum::extract::Request::builder()
                .method(method)
                .uri(uri)
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {TOKEN}"));
            if body.is_some() {
                builder = builder.header(axum::http::header::CONTENT_TYPE, "application/json");
            }
            builder
                .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
                .unwrap()
        };
        async fn json(response: axum::response::Response) -> Value {
            assert_eq!(response.status(), 200);
            serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                    .await
                    .unwrap(),
            )
            .unwrap()
        }
        let global = json(
            app.clone()
                .oneshot(request("GET", "/api/v1/preferences".into(), None))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(global["scope"], "global");
        assert_eq!(global["ticket_id"], Value::Null);
        assert_eq!(global["has_override"], false);
        assert_eq!(global["expanded"], false);
        assert_eq!(global["sender_filter"], Value::Null);
        assert_eq!(global.as_object().unwrap().len(), 5);

        let mut tickets = Vec::new();
        for objective in ["first preference fixture", "second preference fixture"] {
            let ticket = json(
                app.clone()
                    .oneshot(request(
                        "POST",
                        "/api/v1/tickets".into(),
                        Some(json!({
                            "project_id":"project", "objective":objective,
                            "kind":"read_summary", "relative_path":"README.md",
                            "grant_id":"grant", "node_id":"node", "worker_id":"default"
                        })),
                    ))
                    .await
                    .unwrap(),
            )
            .await;
            assert_eq!(ticket["kind"], "read_summary");
            tickets.push(ticket["id"].as_str().unwrap().to_owned());
        }
        let [ticket_a, ticket_b] = tickets.try_into().unwrap();
        let get = |ticket: &str| {
            request(
                "GET",
                format!("/api/v1/preferences?ticket_id={ticket}"),
                None,
            )
        };
        let put = |ticket: Option<&str>, expanded: bool, sender_filter: Value| {
            request(
                "PUT",
                format!(
                    "/api/v1/preferences{}",
                    ticket.map_or(String::new(), |ticket| format!("?ticket_id={ticket}"))
                ),
                Some(json!({"expanded":expanded,"sender_filter":sender_filter})),
            )
        };
        let inherited = json(app.clone().oneshot(get(&ticket_a)).await.unwrap()).await;
        assert_eq!(inherited["scope"], "ticket");
        assert_eq!(inherited["ticket_id"], ticket_a);
        assert_eq!(inherited["has_override"], false);
        assert_eq!(inherited["expanded"], false);
        assert_eq!(inherited["sender_filter"], Value::Null);
        assert_eq!(inherited.as_object().unwrap().len(), 5);

        json(
            app.clone()
                .oneshot(put(Some(&ticket_a), false, json!(null)))
                .await
                .unwrap(),
        )
        .await;
        let explicit_false = json(app.clone().oneshot(get(&ticket_a)).await.unwrap()).await;
        assert_eq!(explicit_false["expanded"], false);
        assert_eq!(explicit_false["has_override"], true);
        assert!(explicit_false["updated_at"].is_string());
        json(
            app.clone()
                .oneshot(put(Some(&ticket_a), true, json!("worker")))
                .await
                .unwrap(),
        )
        .await;
        json(
            app.clone()
                .oneshot(put(None, true, json!(null)))
                .await
                .unwrap(),
        )
        .await;
        let explicit_a = json(app.clone().oneshot(get(&ticket_a)).await.unwrap()).await;
        assert_eq!(explicit_a["scope"], "ticket");
        assert_eq!(explicit_a["ticket_id"], ticket_a);
        assert_eq!(explicit_a["expanded"], true);
        assert_eq!(explicit_a["has_override"], true);
        assert_eq!(explicit_a["sender_filter"], "worker");
        let inherited_b = json(app.clone().oneshot(get(&ticket_b)).await.unwrap()).await;
        assert_eq!(inherited_b["ticket_id"], ticket_b);
        assert_eq!(inherited_b["expanded"], true);
        assert_eq!(inherited_b["has_override"], false);
        assert_eq!(inherited_b["sender_filter"], Value::Null);
        assert_eq!(inherited_b.as_object().unwrap().len(), 5);

        json(
            app.clone()
                .oneshot(put(Some(&ticket_b), false, json!(null)))
                .await
                .unwrap(),
        )
        .await;
        let explicit_b = json(app.clone().oneshot(get(&ticket_b)).await.unwrap()).await;
        assert_eq!(explicit_b["expanded"], false);
        assert_eq!(explicit_b["has_override"], true);
        assert_eq!(explicit_b["sender_filter"], Value::Null);
        json(
            app.clone()
                .oneshot(put(None, false, json!(null)))
                .await
                .unwrap(),
        )
        .await;
        json(
            app.clone()
                .oneshot(put(None, true, json!(null)))
                .await
                .unwrap(),
        )
        .await;
        let still_explicit_b = json(app.clone().oneshot(get(&ticket_b)).await.unwrap()).await;
        assert_eq!(still_explicit_b["ticket_id"], ticket_b);
        assert_eq!(still_explicit_b["expanded"], false);
        assert_eq!(still_explicit_b["has_override"], true);
        let unknown_ticket = "tkt_requested_before_ticket_exists";
        let missing = json(app.clone().oneshot(get(unknown_ticket)).await.unwrap()).await;
        assert_eq!(missing["scope"], "ticket");
        assert_eq!(missing["ticket_id"], unknown_ticket);
        assert_eq!(missing["expanded"], true);
        assert_eq!(missing["has_override"], false);
        assert_eq!(missing["sender_filter"], Value::Null);
        assert_eq!(missing.as_object().unwrap().len(), 5);
        for invalid in [
            json!(7),
            json!({"value":"worker"}),
            json!("x".repeat(161)),
            json!("   "),
            json!("worker\n"),
        ] {
            let rejected = app
                .clone()
                .oneshot(put(Some(&ticket_a), true, invalid))
                .await
                .unwrap();
            assert_eq!(rejected.status(), 400);
            let unchanged = json(app.clone().oneshot(get(&ticket_a)).await.unwrap()).await;
            assert_eq!(
                unchanged["sender_filter"], "worker",
                "Invalid filters cannot silently become All or replace the valid ticket choice"
            );
            assert_eq!(unchanged["expanded"], true);
            assert_eq!(unchanged["has_override"], true);
        }
        let global_filter = app
            .clone()
            .oneshot(put(None, true, json!("worker")))
            .await
            .unwrap();
        assert_eq!(global_filter.status(), 400);
        let too_long = "t".repeat(161);
        let rejected = app.oneshot(get(&too_long)).await.unwrap();
        assert_eq!(rejected.status(), 400);
    }

    #[tokio::test]
    async fn hardware_apis_publish_only_the_exact_trusted_projection() {
        const TOKEN: &str = "hardware-projection-test-token-12345";
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(dir.path()).unwrap();
        store
            .set_setting("client_token_hash", &crate::store::hash(TOKEN))
            .unwrap();
        let at = chrono::Utc::now();
        let inventory = json!({
            "hardware":{"os":"macos","arch":"arm64","memory_bytes":999999999u64},
            "hardware_probe":{"source":"controller_probed","inspector":"spoof\r\nsecret","permission_granted":true},
            "resources":[
                {"schema":"loom.inventory.v1","resource":"hardware.memory_bytes","value":999999999u64,"source":"controller_probed","observed_at":at,"freshness":"fresh","confidence":"available","location":"local_only"},
                {"schema":"loom.inventory.v1","resource":"model.adapter","value":"original","source":"host_reported","observed_at":at,"freshness":"fresh","confidence":"unknown","location":"local_only"}
            ]
        });
        for installation in ["installation", "other"] {
            store.conn().execute(
                "INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node',?1,'public','private','online','[]','[{\"worker_id\":\"default\",\"status\":\"online\"}]',?2,?3,?3)",
                params![installation, inventory.to_string(), at.to_rfc3339()],
            ).unwrap();
        }
        let trusted = crate::inventory_probe::TrustedHardwareProbe {
            schema: crate::inventory_probe::LOCAL_HARDWARE_PROBE_SCHEMA.into(),
            node_id: "node".into(),
            installation_id: "installation".into(),
            inspector: "system_profiler".into(),
            observed_at: at,
            facts: vec![crate::inventory::ResourceFact {
                schema: crate::inventory::INVENTORY_SCHEMA.into(),
                resource: "hardware.gpu.model".into(),
                value: Some(crate::inventory::FactValue::Text("actual GPU".into())),
                source: crate::inventory::FactSource::ControllerProbed,
                observed_at: Some(at),
                freshness: crate::inventory::Freshness::Fresh,
                confidence: crate::inventory::FactConfidence::Available,
                location: crate::inventory::LocationPolicy::LocalOnly,
            }],
            issues: vec![],
            source: crate::inventory::FactSource::ControllerProbed,
            permission_granted: false,
        };
        store
            .set_setting(
                &crate::inventory_probe::hardware_key("node", "installation"),
                &serde_json::to_string(&trusted).unwrap(),
            )
            .unwrap();
        let state = Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: TOKEN.into(),
            bootstrap_token_written: false,
        });
        let app = router(state.clone());
        async fn get(app: &Router, uri: &str) -> Value {
            let response = app
                .clone()
                .oneshot(
                    axum::extract::Request::builder()
                        .uri(uri)
                        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                    .await
                    .unwrap(),
            )
            .unwrap()
        }
        let observed_at = serde_json::to_value(at).unwrap();
        let assert_valid = |inventory: &Value| {
            assert_eq!(inventory["identity"]["installation_id"], "installation");
            assert_eq!(inventory["hardware_probe"]["source"], "controller_probed");
            assert_eq!(inventory["hardware_probe"]["observed_at"], observed_at);
            assert_eq!(inventory["hardware_probe"]["permission_granted"], false);
            let facts = inventory["facts"].as_array().unwrap();
            assert!(facts
                .iter()
                .any(|fact| fact["resource"] == "hardware.gpu.model"
                    && fact["source"] == "controller_probed"));
            assert!(facts
                .iter()
                .any(|fact| fact["resource"] == "hardware.memory_bytes"
                    && fact["confidence"] == "unknown"));
            assert!(facts.iter().any(|fact| fact["resource"] == "model.adapter"
                && fact["value"] == "original"
                && fact["source"] == "host_reported"));
            assert!(!facts.iter().any(|fact| fact["value"] == 999999999));
            assert!(!inventory.to_string().contains("spoof\\r\\nsecret"));
        };
        let list = get(&app, "/api/v1/nodes").await;
        let current = list["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["installation_id"] == "installation")
            .unwrap();
        let other = list["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["installation_id"] == "other")
            .unwrap();
        assert_valid(&current["inventory"]);
        assert!(other["inventory"].get("hardware_probe").is_none());
        assert_valid(
            &get(
                &app,
                "/api/v1/nodes/node/inventory?installation_id=installation",
            )
            .await,
        );
        let legacy = get(&app, "/api/v1/inventory").await;
        assert_valid(
            &legacy["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|node| node["installation_id"] == "installation")
                .unwrap()["inventory"],
        );
        let other = get(&app, "/api/v1/nodes/node/inventory?installation_id=other").await;
        assert!(other.get("hardware_probe").is_none());
        assert_eq!(other["facts"][2]["source"], "host_reported");
        state.store.lock().unwrap().conn().execute("UPDATE nodes SET status='offline',last_heartbeat='2026-01-01T00:00:00Z' WHERE installation_id='installation'", []).unwrap();
        let offline = get(
            &app,
            "/api/v1/nodes/node/inventory?installation_id=installation",
        )
        .await;
        assert_eq!(offline["reachability"], "stale");
        assert_eq!(offline["hardware_probe"]["observed_at"], observed_at);
        let memory = offline["facts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|fact| fact["resource"] == "hardware.memory_bytes")
            .unwrap();
        assert_eq!(memory["freshness"], "stale");
        assert_eq!(memory["confidence"], "unknown");
    }

    #[tokio::test]
    async fn model_descriptor_is_a_bounded_read_task_not_model_invocation() {
        const TOKEN: &str = "test-client-token-123456789012345";
        let directory = tempfile::tempdir().unwrap();
        let project_root = directory.path().join("project");
        std::fs::create_dir(&project_root).unwrap();
        let store = crate::store::Store::open(directory.path().join("db")).unwrap();
        store
            .set_setting("client_token_hash", &crate::store::hash(TOKEN))
            .unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES('project','fixture',?1,'read_only',1,?2,'{}')",
                [project_root.to_string_lossy().as_ref(), crate::now().as_str()],
            )
            .unwrap();
        store
            .conn()
            .execute(
                "INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES('binding','project','node-descriptor','install','default',?1,'binding-proof',?2)",
                [project_root.to_string_lossy().as_ref(), crate::now().as_str()],
            )
            .unwrap();
        for (id, operations) in [
            ("read-grant", json!(["read"])),
            ("invoke-grant", json!(["invoke_text"])),
            ("place-grant", json!(["place_model"])),
        ] {
            let coin = json!({"id":id,"project_id":"project","node_id":"node-descriptor","installation_id":"install","worker_id":"default","operations":operations,"version":1,"project_binding_id":"binding"});
            store
                .conn()
                .execute(
                    "INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES(?1,'project','node-descriptor','default','install',?2,1,?3,?4,'binding')",
                    params![id, coin["operations"].to_string(), crate::store::hash(&coin.to_string()), crate::now()],
                )
                .unwrap();
        }
        let now = chrono::Utc::now().to_rfc3339();
        store
            .conn()
            .execute(
                "INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node-descriptor','install','public','token','online',?1,?2,?3,?4,?4)",
                [
                    json!([{"ticket_kind":"model_descriptor","permission":"read"}]).to_string(),
                    json!([{"worker_id":"default","status":"online"}]).to_string(),
                    json!({"project_roots":{"project":project_root}}).to_string(),
                    now,
                ],
            )
            .unwrap();
        let app = router(Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: TOKEN.into(),
            bootstrap_token_written: false,
        }));
        let request = |body: Value| {
            axum::extract::Request::builder()
                .method("POST")
                .uri("/api/v1/tickets")
                .header("content-type", "application/json")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::from(body.to_string()))
                .unwrap()
        };
        for invalid in [
            json!({"project_id":"project","goal":"read model metadata","kind":"model_descriptor"}),
            json!({"project_id":"project","goal":"escape via parent","kind":"model_descriptor","relative_path":"../model.json"}),
            json!({"project_id":"project","goal":"arbitrary root filename","kind":"model_descriptor","relative_path":"weights.json"}),
            json!({"project_id":"project","goal":"write disguised as a read","kind":"model_descriptor","relative_path":"model.json","content":"{}"}),
            json!({"project_id":"project","goal":"override placement","kind":"model_descriptor","relative_path":"model.json","capability":"read_summary"}),
        ] {
            let response = app.clone().oneshot(request(invalid)).await.unwrap();
            assert_eq!(response.status(), 400);
        }
        for incompatible in [
            None,
            Some(json!("invoke-grant")),
            Some(json!("place-grant")),
        ] {
            let mut body = json!({"project_id":"project","goal":"read-only proof not invocation","kind":"model_descriptor","relative_path":"model.json"});
            if let Some(grant) = incompatible.clone() {
                body["grant_id"] = grant;
            }
            let response = app.clone().oneshot(request(body)).await.unwrap();
            if incompatible.is_some() {
                assert_eq!(
                    response.status(),
                    403,
                    "non-read Grant must not describe a model resource"
                );
            } else {
                assert_eq!(response.status(), 200, "auto selection uses the read Grant");
            }
        }
        let automatic = app
            .clone()
            .oneshot(request(json!({"project_id":"project","goal":"read the declared model metadata","kind":"model_descriptor","relative_path":"model.json"})))
            .await
            .unwrap();
        assert_eq!(automatic.status(), 200);
        let automatic = axum::body::to_bytes(automatic.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let automatic: Value = serde_json::from_slice(&automatic).unwrap();
        assert_eq!(automatic["kind"], "model_descriptor");
        assert_eq!(automatic["relative_path"], "model.json");
        assert_eq!(automatic["status"], "running");
        assert_eq!(
            automatic["grant_id"], "read-grant",
            "auto Grant selection must not choose invoke_text"
        );
        assert_eq!(automatic["assignments"].as_array().unwrap().len(), 1);
        let explicit = app
            .clone()
            .oneshot(request(json!({"project_id":"project","goal":"read explicitly granted metadata","kind":"model_descriptor","relative_path":"model.json","grant_id":"read-grant"})))
            .await
            .unwrap();
        assert_eq!(explicit.status(), 200);
        let explicit = axum::body::to_bytes(explicit.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let explicit: Value = serde_json::from_slice(&explicit).unwrap();
        assert_eq!(explicit["kind"], "model_descriptor");
        assert_eq!(explicit["assignments"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn any_delegation_claim_without_a_real_parent_is_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let db = crate::store::Store::open(directory.path()).unwrap();
        let forged = json!({
            "ticket_id": "tkt_child", "kind": "session_link",
            "session_ref": {"delegated_from": {
                "type": "artifact_ref", "artifact_id": uuid::Uuid::new_v4(),
                "ticket_id": "tkt_parent_fake", "origin_node_id": "a".repeat(64),
                "sha256": "b".repeat(64), "location": "loom://artifact/not-the-producer",
                "parents": [], "session": {"session_id":uuid::Uuid::new_v4()}
            }}
        });
        assert!(validated_delegation_relation(&db, &forged).is_err());
        let mut wrong_kind = forged;
        wrong_kind["kind"] = json!("activity");
        assert!(validated_delegation_relation(&db, &wrong_kind).is_err());
    }

    #[tokio::test]
    async fn actual_assets_are_not_false_spa_fallback_and_symlinks_fail_closed() {
        let store = tempfile::tempdir().unwrap();
        let web = store.path().join("web");
        std::fs::create_dir_all(web.join("assets")).unwrap();
        std::fs::write(web.join("index.html"), "<html>app shell</html>").unwrap();
        let expected = "export const installed = true;";
        std::fs::write(web.join("assets/app.js"), expected).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(Path::new("/etc"), web.join("assets/extra")).unwrap();
        let database = crate::store::Store::open(store.path().join("db")).unwrap();
        database
            .set_setting(
                "web_dir",
                web.canonicalize().unwrap().to_string_lossy().as_ref(),
            )
            .unwrap();
        let app = router(Arc::new(State {
            store: Arc::new(Mutex::new(database)),
            bootstrap_token: "only-synthetic-state".to_owned(),
            bootstrap_token_written: false,
        }));
        for (url, want_body) in [
            ("/assets/app.js", expected),
            ("/login", "<html>app shell</html>"),
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::extract::Request::builder()
                        .uri(url)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), 200, "{url}");
            let body = axum::body::to_bytes(response.into_body(), 2 * 1024 * 1024)
                .await
                .unwrap();
            assert_eq!(String::from_utf8_lossy(&body), want_body, "{url}");
        }
        for url in [
            "/assets/does-not-exist.js",
            "/assets/extra/passwd",
            "/api/not-a-route",
        ] {
            let response = app
                .clone()
                .oneshot(
                    axum::extract::Request::builder()
                        .uri(url)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), 404, "{url}");
        }
    }

    #[test]
    fn public_remote_drops_credentials_and_rejects_exotic_values() {
        for (raw, expected) in [
            (
                "https://user:super-secret@example.invalid/team/repo.git",
                "https://example.invalid/team/repo.git",
            ),
            (
                "https://user@EXAMPLE.invalid/team/Repo.git?private_access=arbitrary#credential",
                "https://example.invalid/team/Repo.git",
            ),
            ("http://host.invalid/path", "http://host.invalid/path"),
            (
                "ssh://git@example.invalid:2222/team/repo.git",
                "ssh://git@example.invalid:2222/team/repo.git",
            ),
            (
                "ssh://example.invalid/team/repo.git",
                "ssh://git@example.invalid/team/repo.git",
            ),
            (
                "git@github.com:team/repo.git?token=discarded#also_discarded",
                "ssh://git@github.com/team/repo.git",
            ),
            (
                "git://example.invalid/team/repo.git",
                "git://example.invalid/team/repo.git",
            ),
            ("https://host.invalid", "https://host.invalid/"),
            (
                "https://user:pass@host.invalid/team/repo?%zz",
                "https://host.invalid/team/repo",
            ),
        ] {
            assert_eq!(public_remote(raw).as_deref(), Some(expected), "{raw}");
        }
        for raw in [
            "javascript:alert(1)",
            "file:///tmp/repo.git",
            "/absolute/local/path",
            "user@example.invalid:team/repo.git",
            "git:password@example.invalid:team/repo.git",
            "ssh://private-login@example.invalid/team/repo.git",
            "ssh://git:password@example.invalid/team/repo.git",
            "ssh://git@example.invalid:0/team/repo.git",
            "ssh://git@example.invalid:65536/team/repo.git",
            "ssh://git@example.invalid:abc/team/repo.git",
            "https://example.invalid:443/team/repo.git",
            "https://example.invalid/team/repo name.git",
            "https://example.invalid/team/../private.git",
            "https://example.invalid/team/./repo.git",
            "https://example.invalid//team/repo.git",
            "https://example.invalid/team/repo\\evil.git",
            "https://example.invalid/team/repo;rm.git",
            "https://example.invalid/team/repo*.git",
            "https://example.invalid/team/~user/repo.git",
            "https://example.invalid/team/repo%00.git",
            "https://example.invalid/team/-c.git",
            "https://example.invalid/team/repo[abc].git",
            "https://example.invalid/team/repo\nwhoami.git",
            "https://例子.invalid/team/repo.git",
            "https://example.invalid/team/répo.git",
            "git@host.invalid:repo;command",
            "git@host.invalid:repo:command",
            "git@host.invalid/repo",
        ] {
            assert_eq!(public_remote(raw), None);
        }
        assert_eq!(
            public_remote(&format!("https://example.invalid/{}", "a".repeat(513))),
            None
        );
        assert!(public_remote(&format!("https://example.invalid/{}", "a".repeat(512))).is_some());
    }

    #[test]
    fn actual_git_project_probe_omits_remote_secrets_and_observes_dirty_state() {
        if !git_fixture_available() {
            return;
        }
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        let home = directory.path().join("private-empty-home");
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir(&home).unwrap();
        fixture_git(&root, &home, &["init", "--quiet", "."]);
        std::fs::write(root.join("input.txt"), "bounded fixture\n").unwrap();
        fixture_git(&root, &home, &["add", "--", "input.txt"]);
        fixture_git(
            &root,
            &home,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--quiet",
                "-m",
                "fixture",
            ],
        );
        fixture_git(
            &root,
            &home,
            &[
                "remote",
                "add",
                "origin",
                "https://user:super-secret@example.invalid/team/repo.git",
            ],
        );
        // No raw stderr is captured in the project inventory or diagnostics.
        let value = project_probe(&root).unwrap();
        let serialized = value.to_string();
        for private in ["super-secret", "https://user:", "user:super-secret"] {
            assert!(!serialized.contains(private));
        }
        assert_eq!(
            value["canonical_remote"],
            "https://example.invalid/team/repo.git"
        );
        assert_eq!(value["canonical_remote_status"], "public");
        assert_eq!(value["redacted_remote"], false);
        assert_eq!(value["needs_review"], false);
        assert_eq!(value["dirty"], false);
        assert_eq!(value["credential_location"], Value::Null);
        assert_eq!(value["credential_available"], "unknown");
        assert_eq!(value["credential_lookup_performed"], false);
        assert_eq!(value["source"], "controller_probe");
        assert_eq!(value["location_kind"], "local_working_tree");
        assert!(value["revision"]
            .as_str()
            .is_some_and(|revision| revision.len() == 40
                && revision.bytes().all(|byte| byte.is_ascii_hexdigit())));
        std::fs::write(root.join("input.txt"), "bounded fixture modified\n").unwrap();
        assert_eq!(project_probe(&root).unwrap()["dirty"], true);
        assert!(!root.join(".git/.loom-probe-empty-home").exists());

        fixture_git(
            &root,
            &home,
            &[
                "remote",
                "set-url",
                "origin",
                "https://example.invalid/team/repo.git?access_token=private#also-private",
            ],
        );
        let stripped = project_probe(&root).unwrap();
        assert_eq!(
            stripped["canonical_remote"],
            "https://example.invalid/team/repo.git"
        );
        assert!(!stripped.to_string().contains("private"));
        fixture_git(
            &root,
            &home,
            &[
                "remote",
                "set-url",
                "origin",
                "ssh://private-user@example.invalid/team/repo.git",
            ],
        );
        let redacted = project_probe(&root).unwrap();
        assert_eq!(redacted["canonical_remote"], Value::Null);
        assert_eq!(
            redacted["canonical_remote_status"],
            "unsupported_or_redacted"
        );
        assert_eq!(redacted["redacted_remote"], true);
        assert_eq!(redacted["needs_review"], true);
        assert!(!redacted.to_string().contains("private-user"));
    }

    #[test]
    fn non_git_project_probe_is_documents_without_revision_or_remote() {
        let directory = tempfile::tempdir().unwrap();
        let value = project_probe(directory.path()).unwrap();
        assert_eq!(value["form"], "documents");
        assert_eq!(value["git_available"], false);
        assert_eq!(value["revision"], Value::Null);
        assert_eq!(value["dirty"], Value::Null);
        assert_eq!(value["canonical_remote"], Value::Null);
        assert_eq!(value["canonical_remote_status"], Value::Null);
        assert_eq!(value["redacted_remote"], false);
        assert_eq!(value["needs_review"], false);
    }

    #[tokio::test]
    async fn malformed_heartbeat_status_cannot_refresh_or_overwrite_the_current_registration() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(directory.path()).unwrap();
        const TOKEN: &str = "fixture-node-own-credential-12345";
        store.conn().execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,revoked_at,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node','installation','fixture-public-key',?1,'online',NULL,'[]','[{\"worker_id\":\"default\",\"status\":\"online\"}]','{}',?2,?2)", [crate::store::hash(TOKEN), "2020-01-01T00:00:00Z".to_owned()]).unwrap();
        let state = Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: TOKEN.into(),
            bootstrap_token_written: false,
        });
        let app = router(state.clone());
        async fn post_status(app: &Router, status: Value) -> (StatusCode, Value) {
            let response = app.clone().oneshot(
                axum::extract::Request::builder().method("POST").uri("/api/v1/nodes/heartbeat")
                    .header("authorization", "Bearer fixture-node-own-credential-12345")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&json!({
                        "protocol":"loom.node.v1", "node_id":"node", "installation_id":"installation", "request_id":"heartbeat-fixture",
                        "status":status, "capabilities":[], "workers":[], "inventory":{},
                    })).unwrap())).unwrap(),
            ).await.unwrap();
            let status = response.status();
            let body = serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                    .await
                    .unwrap(),
            )
            .unwrap();
            (status, body)
        }
        let original = state.lock().unwrap().get("nodes", "node").unwrap().unwrap();
        for invalid in [json!("revoked"), json!(null), json!(42), json!(["online"])] {
            let (status, body) = post_status(&app, invalid).await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "HTTP body must be rejected without mutation: {body}"
            );
            assert_eq!(body["error"]["code"], "invalid_request");
            assert_eq!(
                state.lock().unwrap().get("nodes", "node").unwrap(),
                Some(original.clone())
            );
        }
        for intended in ["online", "busy", "degraded", "offline"] {
            let (status, body) = post_status(&app, json!(intended)).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["accepted"], true);
            assert_eq!(
                state.lock().unwrap().get("nodes", "node").unwrap().unwrap()["status"],
                intended
            );
        }
    }

    #[tokio::test]
    async fn duplicated_worker_input_cannot_override_a_registration_or_alias_another_worker() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::Store::open(directory.path()).unwrap();
        const TOKEN: &str = "fixture-worker-credential-12345";
        store.conn().execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,revoked_at,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES('node','installation','fixture-public-key',?1,'online',NULL,'[]','[{\"worker_id\":\"default\",\"status\":\"online\"}]','{}',?2,?2)", [crate::store::hash(TOKEN), "2020-01-01T00:00:00Z".to_owned()]).unwrap();
        let state = Arc::new(State {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token: TOKEN.into(),
            bootstrap_token_written: false,
        });
        let app = router(state.clone());
        async fn post_workers(app: &Router, workers: Value) -> (StatusCode, Value) {
            let response = app.clone().oneshot(
                axum::extract::Request::builder().method("POST").uri("/api/v1/nodes/heartbeat")
                    .header("authorization", "Bearer fixture-worker-credential-12345")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&json!({
                        "protocol":"loom.node.v1", "node_id":"node", "installation_id":"installation", "request_id":"worker-fixture",
                        "status":"online", "capabilities":[], "workers":workers, "inventory":{},
                    })).unwrap())).unwrap(),
            ).await.unwrap();
            let status = response.status();
            let body = serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), 1024 * 1024)
                    .await
                    .unwrap(),
            )
            .unwrap();
            (status, body)
        }
        let original = state.lock().unwrap().get("nodes", "node").unwrap().unwrap();
        for workers in [
            json!([{"worker_id":"default","status":"online"},{"worker_id":"default","status":"offline"}]),
            json!([{"worker_id":"default","id":"another-worker","status":"online"}]),
            json!([{"worker_id":null}]),
            json!([{"status":"online"}]),
            json!(["not-an-object"]),
        ] {
            let (status, body) = post_workers(&app, workers).await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "malformed worker input must be rejected: {body}"
            );
            assert_eq!(body["error"]["code"], "invalid_request");
            assert_eq!(
                state.lock().unwrap().get("nodes", "node").unwrap(),
                Some(original.clone())
            );
        }
        let (status, body) = post_workers(&app, json!([{"id":"default","status":"online","capabilities":[{"ticket_kind":"read_summary","permission":"read"}]}])).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["accepted"], true);
        let lock = state.lock().unwrap();
        let node = lock.get("nodes", "node").unwrap().unwrap();
        let identity = crate::inventory::InstallationIdentity {
            node_id: "node".into(),
            installation_id: "installation".into(),
        };
        let view =
            crate::inventory::trusted_node_view(&lock, &identity, Some(&node), chrono::Utc::now())
                .unwrap();
        assert_eq!(view.workers[0].worker_id, "default");
        assert_eq!(
            view.workers[0].reachability,
            crate::inventory::Reachability::Online
        );
    }

    fn git_fixture_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    fn fixture_git(root: &Path, home: &Path, args: &[&str]) {
        let hooks_path = if cfg!(windows) {
            "core.hooksPath=NUL"
        } else {
            "core.hooksPath=/dev/null"
        };
        let output = std::process::Command::new("git")
            .args([
                "-c",
                "protocol.file.allow=never",
                "-c",
                "protocol.ext.allow=never",
                "-c",
                hooks_path,
                "-c",
                "credential.helper=",
                "-c",
                "init.defaultBranch=fixture",
            ])
            .args(args)
            .current_dir(root)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", home)
            .env("USERPROFILE", home)
            .env("XDG_CONFIG_HOME", home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(output.status.success());
    }
}

use std::{
    // Application state shares one durable authority.
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tower::ServiceExt;
use tower_http::{services::ServeFile, trace::TraceLayer};

#[derive(Clone)]
pub struct State {
    pub store: Arc<Mutex<store::Store>>,
    pub bootstrap_token: String,
    pub bootstrap_token_written: bool,
}
#[derive(Clone, Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(json!({"error":{"code":self.code,"message":self.message}})),
        )
            .into_response()
    }
}
impl ApiError {
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_request", message)
    }
    pub fn denied(code: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }
    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }
    pub fn conflict(code: &str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }
    pub fn missing(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
        }
    }
}
impl From<std::io::Error> for ApiError {
    fn from(_: std::io::Error) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_io_error",
            "Persistent storage operation was not completed.",
        )
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
pub type ApiResult<T> = std::result::Result<T, ApiError>;
impl From<rusqlite::Error> for ApiError {
    fn from(_: rusqlite::Error) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            "Database operation failed; state was not silently changed.",
        )
    }
}
impl std::error::Error for ApiError {}
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        if let Some(error) = error.downcast_ref::<ApiError>() {
            return error.clone();
        }
        let lower = error.to_string();
        if lower.contains("MemoryCandidate version conflict") {
            Self::conflict("candidate_version_conflict", lower)
        } else if lower.contains("not found") {
            Self::missing(lower)
        } else {
            Self::bad(lower)
        }
    }
}
impl From<loom_protocol::ProtocolError> for ApiError {
    fn from(e: loom_protocol::ProtocolError) -> Self {
        ApiError::bad(e.to_string())
    }
}

#[derive(Serialize, Deserialize)]
struct Identity {
    protocol: String,
    node_id: String,
    installation_id: String,
    public_key: String,
}
// The client credential isn't represented by an anonymous enrollment object.
impl State {
    pub fn open(root: impl AsRef<Path>, client_token: Option<&str>) -> Result<Self> {
        fs::create_dir_all(root.as_ref())?;
        let store = store::Store::open(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(root.as_ref(), fs::Permissions::from_mode(0o700))?;
        }
        let marker = root.as_ref().join("bootstrap-client-token");
        let already_initialized = store.setting("client_token_hash").is_some();
        if client_token.is_none() && already_initialized && !marker.exists() {
            bail!("Existing center requires the configured LOOM_CLIENT_TOKEN; recovery must never silently replace its administrator credential")
        }
        let (bootstrap_token, bootstrap_token_written) = match client_token {
            Some(raw) => {
                if raw.len() < 24 {
                    bail!("LOOM_CLIENT_TOKEN must be at least 24 characters")
                }
                store.set_setting("client_token_hash", &store::hash(raw))?;
                fs::remove_file(marker).ok();
                (raw.to_owned(), false)
            }
            None if marker.exists() => (fs::read_to_string(marker)?.trim().to_owned(), false),
            None => {
                let fresh = token();
                store.set_setting("client_token_hash", &store::hash(&fresh))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    let mut file = fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .mode(0o600)
                        .open(&marker)?;
                    use std::io::Write;
                    Write::write_all(&mut file, fresh.as_bytes())?;
                    file.sync_all()?;
                }
                #[cfg(not(unix))]
                fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&marker)?;
                #[cfg(not(unix))]
                fs::write(&marker, &fresh)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600))?;
                }
                (fresh, true)
            }
        };
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            bootstrap_token,
            bootstrap_token_written,
        })
    }
    pub(crate) fn lock(&self) -> ApiResult<std::sync::MutexGuard<'_, store::Store>> {
        self.store.lock().map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "storage_lock",
                "Store lock unavailable",
            )
        })
    }
}
fn bearer(headers: &HeaderMap) -> ApiResult<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|x| x.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|t| t.len() >= 16)
        .ok_or_else(|| ApiError::auth("Valid bearer authentication required"))
}
fn client(state: &State, headers: &HeaderMap) -> ApiResult<()> {
    let expected = state
        .lock()?
        .setting("client_token_hash")
        .ok_or_else(|| ApiError::auth("No administrative client has been initialized"))?;
    if store::same_secret(&expected, &store::hash(bearer(headers)?)) {
        Ok(())
    } else {
        Err(ApiError::auth("Client authentication failed"))
    }
}
// Authentication happens once per signed request in the transport handler.
pub(crate) fn node_authenticate_for_direct_offer(
    state: &State,
    headers: &HeaderMap,
    body: &Value,
) -> ApiResult<()> {
    node(state, headers, body).map(|_| ())
}
fn node(state: &State, headers: &HeaderMap, body: &Value) -> ApiResult<(String, String)> {
    let node = required(body, "node_id", 128)?.to_owned();
    let installation = required(body, "installation_id", 128)?.to_owned();
    if body["protocol"] != "loom.node.v1" {
        return Err(ApiError::new(
            StatusCode::UPGRADE_REQUIRED,
            "protocol_mismatch",
            "Use loom.node.v1; incompatible messages are not reinterpreted.",
        ));
    }
    required(body, "request_id", 160)?;
    if state
        .lock()?
        .authenticate_node(&node, &installation, bearer(headers)?)?
    {
        Ok((node, installation))
    } else {
        Err(ApiError::auth(
            "Node token, installation and revocation state do not permit this request",
        ))
    }
}
fn envelope(body: &Value) -> ApiResult<(String, String, String)> {
    if body["protocol"] != "loom.node.v1" {
        return Err(ApiError::new(
            StatusCode::UPGRADE_REQUIRED,
            "protocol_mismatch",
            "Expected loom.node.v1",
        ));
    }
    Ok((
        required(body, "node_id", 160)?.to_owned(),
        required(body, "installation_id", 160)?.to_owned(),
        required(body, "request_id", 160)?.to_owned(),
    ))
}
fn deserialize<T: serde::de::DeserializeOwned>(body: &Value) -> ApiResult<T> {
    serde_json::from_value(body.clone()).map_err(|e| ApiError::bad(e.to_string()))
}
// Responses use Json wrappers directly to preserve status and error codes.
fn admin_routes(_state: Arc<State>) -> Router<Arc<State>> {
    Router::new()
        .route("/bootstrap", get(bootstrap))
        .route("/projects", get(projects).post(create_project))
        .route("/projects/{id}/probe", post(probe_project))
        .route(
            "/projects/{id}/credential-action",
            post(create_credential_action),
        )
        .route("/project-bindings", post(create_project_binding))
        .route("/placement/evaluate", post(evaluate_placement))
        .route("/nodes/{id}/inventory", get(node_inventory))
        .route("/grants", get(grants).post(create_grant))
        .route("/grants/{id}/revoke", post(revoke_grant))
        .route("/nodes", get(nodes))
        .route("/nodes/{id}/revoke", post(revoke_node))
        .route("/enrollment-codes", post(enrollment))
        .route("/tickets", get(tickets).post(create_ticket))
        .route("/tickets/{id}", get(ticket))
        .route("/tickets/{id}/cancel", post(cancel))
        .route("/tickets/{id}/retry", post(retry))
        .route("/tickets/{id}/approval", post(approval))
        .route("/tickets/{id}/artifacts/{artifact_id}", get(artifact))
        .route("/preferences", get(preference).put(update_preference))
        .route("/memories", get(memories).post(create_memory))
        .route("/memories/{id}", patch(edit_memory).delete(delete_memory))
        .route("/messages", get(messages).post(message))
        .route("/sources", get(list_sources).post(register_source))
        .route(
            "/source-events",
            get(read_source_events).post(receive_source_event),
        )
        .route("/audit", get(audit))
        .route("/audit/verify", get(verify_audit))
        .route("/candidates", get(candidates).post(create_candidate))
        .route("/candidates/{id}", patch(review_candidate))
        .route(
            "/candidates/{id}/replay",
            get(skill_replay).post(skill_replay_start),
        )
        .route("/model-inventory", get(model_inventory))
        .route("/models", get(model_list).post(model_register))
        .route("/models/{id}", get(model_detail))
        .route("/models/{id}/placement-approvals", post(model_approve))
        .route("/models/{id}/place", post(model_place))
        .route("/models/{id}/retire", post(model_retire))
        .route("/pipelines", get(list_pipelines).post(create_pipeline))
        .route("/pipelines/{id}", get(pipeline_detail))
        .route("/pipelines/{id}/run", post(run_pipeline))
        .route("/pipelines/{id}/cancel", post(cancel_pipeline))
        .route(
            "/install-plans",
            get(install_plans).post(create_install_plan),
        )
        .route("/install-plans/{id}", get(install_plan_detail))
        .route("/install-plans/{id}/approve", post(approve_install_plan))
        .route(
            "/install-plans/{id}/rollback-approve",
            post(rollback_install_plan),
        )
        .route("/install-plans/{id}/observe", post(observe_install_plan))
        .route("/inventory", get(inventory))
}

pub fn router(state: Arc<State>) -> Router {
    let business = admin_routes(state.clone()).layer(axum::middleware::from_fn_with_state(
        state.clone(),
        |AppState(state): AppState<Arc<State>>,
         headers: HeaderMap,
         request: axum::extract::Request,
         next: axum::middleware::Next| async move {
            client(&state, &headers)?;
            Ok::<Response, ApiError>(next.run(request).await)
        },
    ));
    Router::new().merge(crate::node_api::routes()).route("/api/v1/health",get(||async{Json(json!({"status":"ok","protocol":"loom.node.v1","api":"api.v1","version":env!("CARGO_PKG_VERSION")}))})).nest("/api/v1",business).fallback(fallback).layer(axum::extract::DefaultBodyLimit::disable()).layer(tower_http::limit::RequestBodyLimitLayer::new(16*1024*1024)).layer(TraceLayer::new_for_http()).with_state(state)
}
fn public_web_path(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.len() > 4096 || !path.is_ascii() {
        return None;
    }
    let mut relative = PathBuf::new();
    for part in path.split('/') {
        if part.is_empty() || part.starts_with('.') || part == ".." || part.contains('\\') {
            return None;
        }
        relative.push(part);
    }
    let allowed = [
        "html",
        "js",
        "mjs",
        "css",
        "svg",
        "png",
        "jpg",
        "jpeg",
        "webp",
        "ico",
        "woff",
        "woff2",
        "json",
        "map",
        "webmanifest",
    ];
    relative
        .extension()?
        .to_str()
        .filter(|extension| allowed.contains(&extension.to_lowercase().as_str()))?;
    Some(relative)
}
async fn serve_web(request: axum::extract::Request, root: PathBuf) -> Response {
    let path = request.uri().path();
    let requested_asset = path.starts_with("/assets/");
    let public_path = public_web_path(path.strip_prefix('/').unwrap_or_default());
    let candidate = if requested_asset || public_path.is_some() {
        public_path.map(|relative| root.join(relative))
    } else {
        Some(root.join("index.html"))
    };
    if let Some(candidate) = candidate {
        if let Ok(real) = std::fs::canonicalize(&candidate) {
            if real.starts_with(&root) {
                if let Ok(meta) = std::fs::symlink_metadata(&real) {
                    if meta.is_file() && meta.len() <= 2 * 1024 * 1024 {
                        return ServeFile::new(real).oneshot(request).await.into_response();
                    }
                }
            }
        }
        if requested_asset {
            return ApiError::missing("Static asset not found").into_response();
        }
    }
    ApiError::missing("Route not found").into_response()
}
async fn fallback(
    AppState(state): AppState<Arc<State>>,
    request: axum::extract::Request,
) -> Response {
    if let Some(web_dir) = state.lock().ok().and_then(|s| s.setting("web_dir")) {
        if !request.uri().path().starts_with("/api/") {
            return serve_web(request, PathBuf::from(web_dir)).await;
        }
    }
    ApiError::missing("Route not found").into_response()
}
pub async fn serve(state: Arc<State>, listen: String, web_dir: Option<PathBuf>) -> Result<()> {
    if let Some(dir) = web_dir {
        let public_root = std::fs::canonicalize(&dir)?;
        if !public_root.is_dir() {
            anyhow::bail!("Web root must be an existing directory");
        }
        state
            .lock()
            .map_err(|_| anyhow::anyhow!("store"))?
            .set_setting("web_dir", &public_root.to_string_lossy())?;
    }
    let listener = tokio::net::TcpListener::bind(&listen).await?;
    tracing::info!(address=%listener.local_addr()?,"Loom coordinator ready");
    axum::serve(listener, router(state)).await?;
    Ok(())
}

async fn bootstrap(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let tickets = store.list("tickets")?;
    Ok(Json(
        json!({"client_api":"loom.client.v1","node_protocol":"loom.node.v1","identity":{"principal":"single-user","device_role":"client"},"tickets":tickets,"preferences":{"expanded":store.setting("global_expanded")==Some("true".into())},"capabilities":{"multi_node":true,"dsh_runtime_adapter":"requires_installed_host_validation","live_llm":false}}),
    ))
}
async fn projects(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let projects = state.lock()?.list("projects")?;
    Ok(Json(json!({"projects":projects})))
}
async fn create_project(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let name = required(&body, "name", 200)?;
    let root = required(&body, "root", 4096)?;
    let mode = body["mode"].as_str().unwrap_or("read_only");
    if !matches!(mode, "read_only" | "read_write") {
        return Err(ApiError::bad("mode must be read_only or read_write"));
    }
    let canonical = std::fs::canonicalize(root).map_err(|_| {
        ApiError::bad("Project must be an existing directory accessible to this coordinator")
    })?;
    if !canonical.is_dir() {
        return Err(ApiError::bad("Project root must be a directory"));
    }
    let id = id("project");
    let p = project_probe(&canonical)?;
    let time = now();
    let store = state.lock()?;
    store.conn().execute("INSERT INTO projects(id,name,root,mode,version,created_at,inventory) VALUES(?1,?2,?3,?4,1,?5,?6)",params![id,name,canonical.to_string_lossy(),mode,time,serde_json::to_string(&p).unwrap()])?;
    store.audit(
        None,
        "client",
        "project.probed",
        &json!({"project_id":id,"mode":mode,"source":"controller_read_only_probe"}),
    )?;
    Ok(Json(
        json!({"project":store.get("projects",&id)?.expect("inserted project")}),
    ))
}
const PROJECT_GIT_STDOUT_LIMIT: usize = 16 * 1024;
const PROJECT_GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// Run only fixed, repository-local Git inspection commands. In particular,
/// never copy stderr into an inventory: Git diagnostics can echo remote URLs.
fn project_git(root: &Path, args: &[&str]) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let isolated_home = root.join(".git/.loom-probe-empty-home");
    let mut command = Command::new("git");
    // Never derive extra configuration or credentials from this directory.
    command
        .env("HOME", &isolated_home)
        .env("USERPROFILE", &isolated_home)
        .env("XDG_CONFIG_HOME", &isolated_home)
        // Discovered repository config supplies revision/remote/change facts;
        // global/system/credential configuration and hook execution do not.
        .args([
            "-c",
            "protocol.file.allow=never",
            "-c",
            "protocol.ext.allow=never",
            "-c",
            if cfg!(windows) {
                "core.hooksPath=NUL"
            } else {
                "core.hooksPath=/dev/null"
            },
            "-c",
            "credential.helper=",
        ])
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_clear()
        .env(
            "PATH",
            std::env::var_os("PATH").unwrap_or_else(|| {
                if cfg!(windows) {
                    "C:\\Windows\\System32".into()
                } else {
                    "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin".into()
                }
            }),
        )
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ASKPASS", if cfg!(windows) { "echo" } else { "false" })
        .env("SSH_ASKPASS", if cfg!(windows) { "echo" } else { "false" })
        .env(
            "GIT_SSH_COMMAND",
            if cfg!(windows) {
                "C:\\Windows\\System32\\cmd.exe /c exit 1"
            } else {
                "/bin/false"
            },
        )
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_DIR", root.join(".git"))
        .env("GIT_WORK_TREE", root)
        .env("LANG", "C")
        .env("LC_ALL", "C");
    #[cfg(windows)]
    if let Some(system_root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", system_root);
    }

    let mut child = command.spawn().ok()?;
    let mut stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let overflow = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let reader_overflow = overflow.clone();
    let stdout_reader = std::thread::spawn(move || {
        let mut captured = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) => return Some(captured),
                Ok(count) => {
                    if captured.len() + count > PROJECT_GIT_STDOUT_LIMIT {
                        reader_overflow.store(true, std::sync::atomic::Ordering::Relaxed);
                    } else if !reader_overflow.load(std::sync::atomic::Ordering::Relaxed) {
                        captured.extend_from_slice(&buffer[..count]);
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return None,
            }
        }
    });
    let deadline = Instant::now() + PROJECT_GIT_TIMEOUT;
    loop {
        let timed_out = Instant::now() >= deadline;
        let overflowed = overflow.load(std::sync::atomic::Ordering::Relaxed);
        if timed_out || overflowed {
            let _ = child.kill();
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() && !timed_out && !overflowed => {
                return stdout_reader
                    .join()
                    .ok()
                    .flatten()
                    .and_then(|bytes| String::from_utf8(bytes).ok())
                    .map(|value| value.trim().to_owned());
            }
            Ok(Some(_)) => {
                let _ = stdout_reader.join();
                return None;
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                return None;
            }
            Ok(None) if timed_out || overflowed => {
                let _ = child.wait();
                let _ = stdout_reader.join();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(2)),
        }
    }
}

/// Convert a raw configured remote into public metadata. It never performs I/O,
/// resolves credentials, or returns rejected input. Query and fragment are
/// always discarded before validation; an unrecognized value becomes unknown.
fn public_remote(raw: &str) -> Option<String> {
    // 512-byte path + bounded scheme/authority; cap the whole input as well so
    // arbitrarily long discarded suffixes are not treated as public metadata.
    if raw.is_empty() || raw.len() > 1536 || !raw.is_ascii() {
        return None;
    }
    if raw.contains(char::is_whitespace) || raw.ends_with(['?', '#']) {
        return None;
    }
    let separator = raw.find(['?', '#']);
    if let Some(separator) = separator {
        let discarded = &raw[separator + 1..];
        // Do not attempt to classify credentials/token spellings. Anything
        // outside a plain printable suffix is unsupported and fully redacted.
        if discarded.is_empty() || discarded.bytes().any(|byte| !(0x20..=0x7e).contains(&byte)) {
            return None;
        }
    }
    let without_secrets = separator.map_or(raw, |index| &raw[..index]);
    if let Some(rest) = without_secrets.strip_prefix("git@") {
        let separator = rest.find(':')?;
        if separator == 0 || rest[..separator].contains(['@', ':', '/']) {
            return None;
        }
        let host = public_host(&rest[..separator])?;
        let path = rest[separator + 1..]
            .strip_prefix('/')
            .unwrap_or(&rest[separator + 1..]);
        return Some(format!("ssh://git@{host}/{}", safe_remote_path(path)?));
    }

    let (scheme, remainder) = without_secrets.split_once("://")?;
    let scheme = match scheme {
        "http" | "https" | "ssh" | "git" => scheme,
        _ => return None,
    };
    if remainder.is_empty() || remainder.starts_with('/') {
        return None;
    }
    let authority_end = remainder.find('/').unwrap_or(remainder.len());
    let authority = &remainder[..authority_end];
    let raw_path = &remainder[authority_end..];
    if authority.is_empty() || authority.contains('@') && scheme == "git" {
        return None;
    }
    let userinfo = authority.rsplit_once('@').map(|(user, _)| user);
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let ssh_user = match scheme {
        "http" | "https" => None, // Deliberately discard all HTTP userinfo.
        "ssh" => match userinfo {
            None | Some("git") => Some("git"),
            _ => return None,
        },
        _ => None,
    };
    if userinfo.is_some() && scheme == "git" {
        return None;
    }
    let (host, port) = public_authority(host_port, scheme == "ssh")?;
    let path = safe_remote_path(raw_path.strip_prefix('/').unwrap_or_default())?;
    let user = ssh_user.map_or("", |_| "git@");
    let port = port.map_or_else(String::new, |value| format!(":{value}"));
    Some(format!("{scheme}://{user}{host}{port}/{path}"))
}

fn public_host(host: &str) -> Option<String> {
    if host.is_empty()
        || host.len() > 253
        || host.starts_with('.')
        || host.ends_with('.')
        || host.contains("..")
        || host.starts_with('[')
        || host.ends_with(']')
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return None;
    }
    (!host.split(['.', '-', '_']).any(str::is_empty)).then(|| host.to_ascii_lowercase())
}

fn public_authority(authority: &str, allow_port: bool) -> Option<(String, Option<u16>)> {
    let (host, port) = match authority.split_once(':') {
        Some((host, port)) if !port.contains(':') => (
            host,
            allow_port
                .then(|| port.parse::<u16>().ok())
                .flatten()
                .filter(|port| *port > 0),
        ),
        Some(_) => return None,
        None => (authority, None),
    };
    if authority.contains(':') && port.is_none() {
        return None;
    }
    Some((public_host(host)?, port))
}

fn safe_remote_path(path: &str) -> Option<&str> {
    if path.is_empty() {
        return Some(path);
    }
    if path.len() > 512 {
        return None;
    }
    if !path.is_ascii()
        || path.bytes().any(|byte| !(0x21..=0x7e).contains(&byte))
        || path.contains("..")
        || path.contains("/./")
        || path.contains("//")
        || path.starts_with("./")
        || path.ends_with("/.")
        || path.starts_with('/')
        || path.ends_with('/')
    {
        return None;
    }
    for component in path.split('/') {
        if component.is_empty()
            || component == "."
            || component.starts_with('-')
            || !component.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'+')
            })
        {
            return None;
        }
    }
    Some(path)
}

fn project_probe(root: &Path) -> Result<Value> {
    let git = root.join(".git").exists();
    let run = |args: &[&str]| project_git(root, args);
    let revision = if git {
        run(&["rev-parse", "HEAD"]).filter(|revision| {
            matches!(revision.len(), 40 | 64)
                && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
    } else {
        None
    };
    let dirty = if git {
        run(&["status", "--porcelain"]).map(|s| !s.is_empty())
    } else {
        None
    };
    let raw_remote = if git {
        run(&["--no-optional-locks", "remote", "get-url", "origin"])
    } else {
        None
    };
    let canonical_remote = raw_remote.as_deref().and_then(public_remote);
    let remote_redacted = raw_remote.is_some() && canonical_remote.is_none();
    let canonical_remote_status = canonical_remote
        .as_ref()
        .map(|_| "public")
        .or(remote_redacted.then_some("unsupported_or_redacted"));
    Ok(json!({
        "form": if git { "working_tree" } else { "documents" },
        "project_kind": "project",
        "canonical_remote": canonical_remote,
        "canonical_remote_status": canonical_remote_status,
        "redacted_remote": remote_redacted,
        "needs_review": remote_redacted,
        "revision": revision,
        "dirty": dirty,
        "git_available": git,
        "location_kind": "local_working_tree",
        "credential_location": null,
        "credential_available": "unknown",
        "credential_lookup_performed": false,
        "source": "controller_probe",
        "probed_at": now(),
        "pending": "No implicit Clone, credentials or access grant created."
    }))
}
async fn create_credential_action(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut store = state.lock()?;
    Ok(Json(crate::credential_ref::create(&mut store, &id, &body)?))
}
async fn probe_project(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let project = store
        .get("projects", &id)?
        .ok_or_else(|| ApiError::bad("project not found"))?;
    let p = project_probe(Path::new(project["root"].as_str().unwrap_or_default()))?;
    store.conn().execute(
        "UPDATE projects SET inventory=?1,version=version+1 WHERE id=?2",
        params![serde_json::to_string(&p).unwrap(), id],
    )?;
    Ok(Json(
        json!({"project":store.get("projects",&id)?,"read_only_probe":true}),
    ))
}
#[allow(dead_code)]
async fn grant_data(kind: &str) -> ApiResult<Value> {
    Ok(json!({"permission":kind}))
}
async fn grants(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({"grants":state.lock()?.list("grants")?})))
}
fn explicit_permissions(body: &Value) -> ApiResult<Vec<&'static str>> {
    let operations = match body.get("operations") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|v| v.as_str().unwrap_or_default())
            .collect::<Vec<_>>(),
        Some(Value::String(value)) => vec![value.as_str()],
        _ => vec![body
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("read_summary")],
    };
    let mut permissions = Vec::new();
    for operation in operations {
        match operation {
            "read"|"read_summary"|"model_descriptor"=>if !permissions.contains(&"read"){permissions.push("read")},
            "write"|"edit_file"=>if !permissions.contains(&"write"){permissions.push("write")},
            "read_write"=>{if !permissions.contains(&"read"){permissions.push("read");}
                if !permissions.contains(&"write"){permissions.push("write");}},
            "invoke_text"=>if !permissions.contains(&"invoke_text"){permissions.push("invoke_text")},
            "place_model"=>if !permissions.contains(&"place_model"){permissions.push("place_model")},
            "credential_inspect" => if !permissions.contains(&"credential_inspect") { permissions.push("credential_inspect") },
            "credential_revoke" => if !permissions.contains(&"credential_revoke") { permissions.push("credential_revoke") },
            _=>return Err(ApiError::bad("Operations require explicit read/read_summary, write/edit_file, read_write, separately granted invoke_text or separate place_model.")),
        }
    }
    if permissions.is_empty() {
        return Err(ApiError::bad("Grant operations must not be empty."));
    }
    Ok(permissions)
}
async fn evaluate_placement(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let project_id = required(&body, "project_id", 160)?.to_owned();
    let capability = required(&body, "capability", 128)?.to_owned();
    let grant_id = required(&body, "grant_id", 160)?.to_owned();
    let project_binding_id = required(&body, "project_binding_id", 160)?.to_owned();
    let request = crate::inventory::PlacementRequest {
        project_id,
        capability,
        worker_id: body["worker_id"].as_str().unwrap_or("default").to_owned(),
        preferred_node_id: body["node_id"].as_str().map(ToOwned::to_owned),
        grant_id,
        project_binding_id,
        evaluated_at: chrono::Utc::now(),
        hardware: if body["hardware"].is_object() {
            Some(crate::inventory::HardwareTarget {
                os: body["hardware"]["os"].as_str().map(str::to_lowercase),
                arch: body["hardware"]["arch"].as_str().map(str::to_lowercase),
                minimum_memory_bytes: body["hardware"]["minimum_memory_bytes"].as_u64(),
            })
        } else {
            None
        },
    };
    let store = state.lock()?;
    let decision = crate::inventory::decide_placement(&store, &request)?;
    Ok(Json(serde_json::to_value(decision).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "inventory_encoding",
            "Cannot encode placement evaluation",
        )
    })?))
}
async fn create_project_binding(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let project = required(&body, "project_id", 160)?;
    let node = required(&body, "node_id", 160)?;
    let worker = body["worker_id"].as_str().unwrap_or("default");
    let worker = loom_protocol::WorkerId::parse(worker)?;
    let worker = worker.as_str();
    let root = required(&body, "root_scope", 4096)?;
    let mut store = state.lock()?;
    let project_data = store
        .get("projects", project)?
        .ok_or_else(|| ApiError::missing("Project is unknown"))?;
    let requested_installation = if body.get("installation_id").is_some() {
        let target = required(&body, "installation_id", 160)?;
        if target.trim().is_empty() {
            return Err(ApiError::bad("installation_id must be nonempty"));
        }
        Some(target)
    } else {
        None
    };
    let records = store.query(
        "SELECT installation_id,revoked_at,workers,inventory FROM nodes WHERE id=?1",
        [node],
    )?;
    if records.is_empty() {
        return Err(ApiError::missing("Node is unknown"));
    }
    let mut installations: Vec<Value> = records
        .into_iter()
        .filter(|record| {
            requested_installation
                .is_none_or(|target| record["installation_id"].as_str() == Some(target))
        })
        .collect();
    if installations.is_empty() {
        return Err(ApiError::missing("Installation is unknown"));
    }
    if installations
        .iter()
        .all(|record| record["revoked_at"] != Value::Null)
    {
        return Err(ApiError::denied(
            "revoked_node",
            "Cannot bind a revoked node",
        ));
    }
    installations.retain(|record| record["revoked_at"].is_null());
    if installations.len() > 1 {
        return Err(ApiError::conflict(
            "exact_installation_required",
            "One Node with multiple usable installations requires an exact installation_id",
        ));
    }
    let node_data = installations
        .pop()
        .ok_or_else(|| ApiError::denied("revoked_node", "Cannot bind an inactive installation"))?;
    let declared = node_data["inventory"]["project_roots"][project].as_str();
    if declared != Some(root) {
        return Err(ApiError::denied(
            "binding_not_declared_by_host",
            "The node must first declare this exact ProjectId-to-root mapping; the client cannot replace it with another location",
        ));
    }
    if node_data["workers"]
        .as_array()
        .is_some_and(|workers| !workers.is_empty())
        && !node_data["workers"].as_array().is_some_and(|workers| {
            workers.iter().any(|entry| {
                entry
                    .get("worker_id")
                    .or_else(|| entry.get("id"))
                    .and_then(Value::as_str)
                    == Some(worker)
            })
        })
    {
        return Err(ApiError::denied(
            "worker_not_registered",
            "Worker scope is not registered by this installation",
        ));
    }
    let installation = node_data["installation_id"].as_str().unwrap_or_default();
    let binding = id("binding");
    let at = now();
    let digest = store::hash(&json!({"project_id":project,"node_id":node,"installation_id":installation,"worker_id":worker,"root_scope":root}).to_string());
    let tx = store
        .conn_mut()
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT INTO project_bindings(id,project_id,node_id,installation_id,worker_id,root_scope,binding_digest,approved_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![binding,project,node,installation,worker,root,digest,at],
    )?;
    store::audit_tx(
        &tx,
        None,
        "client",
        "project.binding.approved",
        &json!({"binding_id":binding,"project_id":project,"node_id":node,"worker_id":worker,"root_digest":store::hash(root),"project_revision":project_data["inventory"]["revision"]}),
    )?;
    tx.commit()?;
    Ok(Json(
        json!({"id":binding,"project_id":project,"node_id":node,"installation_id":installation,"worker_id":worker,"binding_digest":digest}),
    ))
}
async fn create_grant(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let project = required(&body, "project_id", 160)?.to_owned();
    let ops = explicit_permissions(&body)?;
    let node_id = body["node_id"].as_str().unwrap_or("auto").to_owned();
    let worker = body["worker_id"].as_str().unwrap_or("default").to_owned();
    if node_id.len() > 160 || worker.len() > 160 {
        return Err(ApiError::bad("Identity too long"));
    }
    let store = state.lock()?;
    let p = store
        .get("projects", &project)?
        .ok_or_else(|| ApiError::missing("Project is not registered"))?;
    if p["mode"] == "read_only" && ops.contains(&"write") {
        return Err(ApiError::denied(
            "project_scope",
            "A write grant must not exceed a read-only project boundary",
        ));
    }
    if node_id != "auto" && store.get("nodes", &node_id)?.is_none() {
        return Err(ApiError::bad("Target a registered node or auto"));
    }
    let mut bindings = store.query(
        "SELECT * FROM project_bindings WHERE project_id=?1 AND worker_id=?2 AND revoked_at IS NULL",
        params![project, worker],
    )?;
    if node_id != "auto" {
        bindings.retain(|entry| entry["node_id"] == node_id);
    }
    if let Some(requested_binding) = body["project_binding_id"].as_str() {
        bindings.retain(|entry| entry["id"] == requested_binding);
    }
    let binding = match bindings.len() {
        0 => return Err(ApiError::conflict(
            "project_binding_required",
            "Approve an exact ProjectId location on a target Node/Installation/Worker before granting operations",
        )),
        1 => bindings.remove(0),
        _ if !body["project_binding_id"].is_null() => {
            return Err(ApiError::conflict("ambiguous_binding", "The requested binding is not unique within this grant"))
        }
        _ => return Err(ApiError::conflict(
            "binding_explicit",
            "Multiple host locations exist for this project; select an exact binding, do not guess",
        )),
    };
    if binding["node_id"] != node_id && node_id != "auto" {
        return Err(ApiError::denied(
            "binding_scope",
            "Grant location and node identity disagree",
        ));
    }
    let gid = id("grant");
    let time = now();
    let op_json = json!(ops);
    let binding_id = binding["id"].as_str().unwrap_or_default();
    let installation = binding["installation_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let digest = hash_json(
        &json!({"id":gid,"project_id":project,"node_id":node_id,"worker_id":worker,"installation_id":installation,"binding":binding["binding_digest"],"operations":op_json,"version":1}),
    );
    store.conn().execute("INSERT INTO grants(id,project_id,node_id,worker_id,installation_id,operations,version,digest,created_at,project_binding_id) VALUES(?1,?2,?3,?4,?5,?6,1,?7,?8,?9)",params![gid,project,node_id,worker,installation,op_json.to_string(),digest,time,binding_id])?;
    store.audit(
        None,
        "client",
        "grant.created",
        &json!({"grant_id":gid,"operations":op_json,"node_id":node_id,"worker_id":worker}),
    )?;
    Ok(Json(json!({"grant":store.get("grants",&gid)?})))
}
async fn nodes(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let mut nodes = store.list("nodes")?;
    for n in &mut nodes {
        let declared_roots = n["inventory"]["project_roots"].clone();
        let last = n["last_heartbeat"]
            .as_str()
            .and_then(|s| parse_time(s).ok());
        let online = n["revoked_at"].is_null()
            && n["status"] != "offline"
            && last.is_some_and(|at| chrono::Utc::now() - at < chrono::Duration::seconds(60));
        n["online"] = json!(online);
        n["freshness"] = if online {
            json!("fresh")
        } else {
            json!("stale_offline")
        };
        n["source"] = json!("host_heartbeat");
        let installation_id = n["installation_id"].as_str().unwrap_or_default().to_owned();
        let identity = crate::inventory::InstallationIdentity {
            node_id: n["id"].as_str().unwrap_or_default().to_owned(),
            installation_id,
        };
        let view =
            crate::inventory::trusted_node_view(&store, &identity, Some(n), chrono::Utc::now())?;
        n["inventory"] = serde_json::to_value(view).map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "inventory_encoding",
                "Cannot encode node inventory",
            )
        })?;
        if declared_roots.is_object() {
            let canonical_roots: std::collections::BTreeMap<String, String> = declared_roots
                .as_object()
                .into_iter()
                .flatten()
                .filter_map(|(project, root)| Some((project.clone(), root.as_str()?.to_owned())))
                .collect();
            n["inventory"]["project_roots"] = declared_roots;
            // Project creation stores the canonical directory; Host inventory
            // intentionally preserves its exact original declaration. Publish
            // both existing declarations and their independently inspected
            // canonical forms without discarding binding identity or creating a Grant.
            let inspected_roots: serde_json::Map<String, Value> = canonical_roots
                .into_iter()
                .map(|(project, root)| match std::fs::canonicalize(root) {
                    Ok(path) if path.is_dir() => {
                        (project, Value::String(path.to_string_lossy().to_string()))
                    }
                    _ => (project, Value::Null),
                })
                .collect();
            n["inventory"]["canonical_project_roots"] = Value::Object(inspected_roots);
        }
        if let Value::Array(ref mut workers) = n["workers"] {
            for worker in workers.iter_mut() {
                if let Value::Object(ref mut map) = worker {
                    map.retain(|key, _| {
                        [
                            "id",
                            "worker_id",
                            "profile_id",
                            "harness_kind",
                            "status",
                            "capabilities",
                            "supported_effects",
                        ]
                        .contains(&key.as_str())
                    });
                }
            }
        }
        if let Value::Array(ref mut workers) = n["workers"] {
            for worker in workers {
                if let Value::Object(ref mut map) = worker {
                    map.retain(|key, _| {
                        [
                            "id",
                            "worker_id",
                            "profile_id",
                            "harness_kind",
                            "status",
                            "supported_effects",
                            "capabilities",
                        ]
                        .contains(&key.as_str())
                    });
                }
            }
        }
    }
    Ok(Json(json!({"nodes":nodes})))
}
async fn revoke_node(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(node): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let mut store = state.lock()?;
    let current = store
        .get("nodes", &node)?
        .ok_or_else(|| ApiError::missing("Node not found"))?;
    let outcome = "Unknown active effects enter reconciliation";
    if current["revoked_at"].is_string() && current["status"] == "revoked" {
        return Ok(Json(json!({
            "revoked":true,"duplicate":true,"node_id":node,
            "revoked_at":current["revoked_at"],"task_outcome":outcome
        })));
    }
    if (current["status"] == "revoked" && !current["revoked_at"].is_string())
        || (!current["revoked_at"].is_null()
            && (!current["revoked_at"].is_string() || current["status"] != "revoked"))
    {
        return Err(ApiError::conflict(
            "revocation_state_inconsistent",
            "Node revocation timestamp/state is inconsistent with its durable record",
        ));
    }
    let revoked_at = now();
    let tx = store.conn_mut().transaction()?;
    let result = (|| -> rusqlite::Result<()> {
        tx.execute(
            "UPDATE nodes SET revoked_at=?1,status='revoked' WHERE id=?2 AND revoked_at IS NULL AND status<>'revoked'",
            params![revoked_at,node],
        )?;
        tx.execute(
            "UPDATE assignments SET lease_expires_at=?1 WHERE node_id=?2",
            params![revoked_at, node],
        )?;
        store::audit_tx(
            &tx,
            None,
            "client",
            "node.revoked",
            &json!({"node_id":node}),
        )
        .map_err(|error| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                error.to_string(),
            )))
        })?;
        Ok(())
    })();
    result?;
    tx.commit()?;
    Ok(Json(json!({
        "revoked":true,"duplicate":false,"node_id":node,"revoked_at":revoked_at,
        "task_outcome":outcome
    })))
}
async fn revoke_grant(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(grant): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let mut store = state.lock()?;
    let current = store
        .get("grants", &grant)?
        .ok_or_else(|| ApiError::missing("Grant not found"))?;
    let effects = "running_execution_outcome_unknown_until_reconciled";
    if current["revoked_at"].is_string() {
        // Revocation is a durable fact, including legacy versions beyond v2. A
        // replay reports that immutable row without increasing its fence or implying
        // that any version is readmitted by the stricter assignment_for_poll rules.
        return Ok(Json(json!({
            "revoked":true,"duplicate":true,"grant_id":grant,
            "grant_version":current["version"],"revoked_at":current["revoked_at"],"effects":effects
        })));
    }
    let revoked_at = now();
    let tx = store.conn_mut().transaction()?;
    let result = (|| -> rusqlite::Result<(i64, String)> {
        tx.execute(
            "UPDATE grants SET revoked_at=?1,version=version+1 WHERE id=?2 AND revoked_at IS NULL",
            params![revoked_at, grant],
        )?;
        tx.execute(
            "UPDATE assignments SET lease_expires_at=?1 WHERE ticket_id IN(SELECT id FROM tickets WHERE grant_id=?2)",
            params![revoked_at,grant],
        )?;
        tx.execute(
            "UPDATE tickets SET status='reconciling',updated_at=?1 WHERE grant_id=?2 AND status='running'",
            params![revoked_at,grant],
        )?;
        store::audit_tx(
            &tx,
            None,
            "client",
            "grant.revoked",
            &json!({"grant_id":grant,"fencing":"old_leases_expired"}),
        )
        .map_err(|error| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                error.to_string(),
            )))
        })?;
        // Reading actual values inside this transaction prevents the response
        // from assuming v2 if the persisted pre-revocation state was unusual.
        tx.query_row(
            "SELECT version,revoked_at FROM grants WHERE id=?1",
            [&grant],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
    })();
    let (version, persisted_revoked_at) = result?;
    tx.commit()?;
    Ok(Json(json!({
        "revoked":true,"duplicate":false,"grant_id":grant,
        "grant_version":version,"revoked_at":persisted_revoked_at,"effects":effects
    })))
}
async fn enrollment(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let code = format!("enroll_{}", token());
    let expiry = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
    let store = state.lock()?;
    let id = id("enrollment");
    store.conn().execute(
        "INSERT INTO enrollment_codes(id,token_hash,expires_at) VALUES(?1,?2,?3)",
        params![id, store::hash(&code), expiry],
    )?;
    store.audit(
        None,
        "client",
        "enrollment.created",
        &json!({"enrollment_id":id,"expires_at":expiry}),
    )?;
    Ok(Json(
        json!({"code":code,"expires_at":expiry,"single_use":true}),
    ))
}
// The public Ticket route invokes create_ticket with its client auth layer.
pub(crate) async fn challenge(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let _: Identity = deserialize(&body)?;
    if body["protocol"] != "loom.node.v1" {
        return Err(ApiError::bad("protocol"));
    }
    let node_id = required(&body, "node_id", 160)?;
    let installation = required(&body, "installation_id", 160)?;
    let public = required(&body, "public_key", 96)?;
    let _ = public_key_identity(public, node_id, installation)?;
    let nonce = store::hex(crate::random32());
    let challenge = id("challenge");
    let expires = (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339();
    let store = state.lock()?;
    store.conn().execute("INSERT INTO challenges(id,node_id,installation_id,public_key,nonce,expires_at) VALUES(?1,?2,?3,?4,?5,?6)",params![challenge,node_id,installation,public,nonce,expires])?;
    Ok(Json(
        json!({"challenge_id":challenge,"nonce":nonce,"expires_at":expires}),
    ))
}
pub async fn artifact_upload_handler(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    artifact_upload(Json(body), state, headers).await
}
pub(crate) async fn register(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let request: loom_protocol::RegisterNodeRequest =
        serde_json::from_value(body.clone()).map_err(|e| ApiError::bad(e.to_string()))?;
    if request.capabilities.is_empty() {
        return Err(ApiError::bad(
            "Capability declaration required; this is not permission",
        ));
    }
    let _node_type = loom_protocol::NodeId::parse(request.node_id.as_str())?;
    let key = public_key_identity(
        &request.public_key,
        request.node_id.as_str(),
        request.installation_id.as_str(),
    )?;
    let (node, installation, request_id) = envelope(&body)?;
    let mut store = state.lock()?;
    // A signed registration, its enrollment/challenge consumption, Node writes and
    // audit are one outcome. No failed signature or audit may burn enrollment proof
    // or leave an apparently registered, incompletely authorized identity.
    let tx = store
        .conn_mut()
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let existing = tx
        .query_row(
            "SELECT public_key,revoked_at FROM nodes WHERE id=?1 AND installation_id=?2",
            params![node, installation],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    if let Some((old, revoked)) = existing {
        if revoked.is_some() {
            return Err(ApiError::denied(
                "node_revoked",
                "Revoked node may not rotate credentials",
            ));
        }
        let existing_token = tx
            .query_row(
                "SELECT token_hash FROM nodes WHERE id=?1 AND installation_id=?2 AND revoked_at IS NULL",
                params![node, installation],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let presented = bearer(&headers)?;
        if old != request.public_key
            || !existing_token
                .is_some_and(|expected| store::same_secret(&expected, &store::hash(presented)))
        {
            return Err(ApiError::denied(
                "credential_rotation_denied",
                "Valid existing credentials are required to rotate a node session",
            ));
        }
    } else {
        let code = required(&body, "enrollment_code", 128)?;
        let changed = tx.execute("UPDATE enrollment_codes SET used_at=?1 WHERE token_hash=?2 AND used_at IS NULL AND expires_at>?3",params![now(),store::hash(code),now()])?;
        if changed != 1 {
            return Err(ApiError::denied(
                "enrollment_denied",
                "A fresh, single-use enrollment code is required",
            ));
        }
    }
    let (cid,expires,pubkey): (String,String,String)=tx.query_row("SELECT id,expires_at,public_key FROM challenges WHERE node_id=?1 AND installation_id=?2 AND nonce=?3 AND used_at IS NULL",params![node,installation,request.nonce.as_str()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?.ok_or_else(||ApiError::denied("challenge_invalid","Fresh and identity-bound challenge required"))?;
    if pubkey != request.public_key || parse_time(&expires)? <= chrono::Utc::now() {
        return Err(ApiError::denied("challenge_expired", "Expired challenge"));
    }
    // Verify before relabeling the input or returning any credential. Transaction
    // drop rolls back the reserved enrollment and any subsequent storage mutation.
    signature(&key, request.nonce.as_str(), &request.signed_challenge)?;
    let consumed = tx.execute(
        "UPDATE challenges SET used_at=?1 WHERE id=?2 AND node_id=?3 AND installation_id=?4 AND nonce=?5 AND public_key=?6 AND used_at IS NULL",
        params![now(), cid, node, installation, request.nonce.as_str(), request.public_key],
    )?;
    if consumed != 1 {
        return Err(ApiError::denied(
            "challenge_invalid",
            "The exact unused identity-bound challenge is required",
        ));
    }
    let token = token();
    let cap = serde_json::to_string(&request.capabilities).unwrap();
    let workers = json!([{"id":request.worker_id.as_str(),"worker_id":request.worker_id.as_str(),"profile_id":request.profile_id.as_str(),"harness_kind":request.harness_kind.as_str()}]);
    // Registration keeps a compact self-reported worker snapshot; heartbeat supplies live inventory.
    tx.execute("INSERT INTO nodes(id,installation_id,public_key,token_hash,status,capabilities,workers,inventory,registered_at,last_heartbeat) VALUES(?1,?2,?3,?4,'online',?5,?6,?7,?8,?8) ON CONFLICT(id,installation_id) DO UPDATE SET token_hash=excluded.token_hash,status='online',last_heartbeat=excluded.last_heartbeat,workers=excluded.workers,inventory=excluded.inventory,capabilities=excluded.capabilities",params![node,installation,request.public_key,store::hash(&token),cap,serde_json::to_string(&workers).unwrap(),workers.to_string(),now()])?;
    store::audit_tx(
        &tx,
        None,
        "node",
        "node.registered",
        &json!({"node_id":node,"installation_id":installation,"request_id":request_id}),
    )?;
    tx.commit()?;
    Ok(Json(
        json!({"node_id":node,"installation_id":installation,"token":token,"node_token":token,"grant_digest":null,"protocol":"loom.node.v1"}),
    ))
}
#[derive(serde::Deserialize)]
struct InventorySelector {
    installation_id: Option<String>,
}
async fn node_inventory(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(raw_id): axum::extract::Path<String>,
    axum::extract::Query(selector): axum::extract::Query<InventorySelector>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let mut candidates = store.query("SELECT id,installation_id,status,capabilities,workers,inventory,last_heartbeat,revoked_at FROM nodes WHERE id=?1", [&raw_id])?;
    if let Some(installation_id) = selector
        .installation_id
        .as_ref()
        .filter(|value| !value.is_empty())
    {
        candidates
            .retain(|node| node["installation_id"].as_str() == Some(installation_id.as_str()));
    }
    if candidates.len() > 1 {
        return Err(ApiError::conflict(
            "exact_installation_required",
            "Select one exact installation instead of mixing worker/profile inventories",
        ));
    }
    let record = candidates.first();
    let installation_id = record
        .map(|row| {
            row["installation_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
        .or(selector.installation_id)
        .unwrap_or_default();
    let identity = crate::inventory::InstallationIdentity {
        node_id: raw_id,
        installation_id,
    };
    let view = crate::inventory::trusted_node_view(&store, &identity, record, chrono::Utc::now())?;
    Ok(Json(serde_json::to_value(view).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "inventory_encoding",
            "Cannot encode resource inventory",
        )
    })?))
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelInventorySelector {
    node_id: Option<String>,
    installation_id: Option<String>,
    worker_id: Option<String>,
}
fn model_encoding() -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "model_inventory_encoding",
        "Cannot encode model observations",
    )
}
async fn model_inventory(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Query(selector): axum::extract::Query<ModelInventorySelector>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let now = chrono::Utc::now();
    match (selector.node_id, selector.installation_id) {
        (Some(node_id), Some(installation_id)) => {
            let view = crate::model_inventory::inventory(
                &store,
                &node_id,
                &installation_id,
                selector.worker_id.as_deref().unwrap_or("default"),
                now,
            )
            .map_err(|_| model_encoding())?;
            serde_json::to_value(view)
                .map(Json)
                .map_err(|_| model_encoding())
        }
        (None, None) => {
            let mut response =
                crate::model_inventory::all(&store, now).map_err(|_| model_encoding())?;
            if let Some(worker) = selector.worker_id {
                response.observations.retain(|view| {
                    view.worker_id == worker
                        || view.models.is_empty()
                            && view
                                .findings
                                .iter()
                                .any(|finding| finding.state == "worker_mismatch")
                });
                response.models.retain(|model| model.worker_id == worker);
            }
            serde_json::to_value(response)
                .map(Json)
                .map_err(|_| model_encoding())
        }
        _ => Err(ApiError::bad(
            "Select node_id and installation_id together for one exact model observation",
        )),
    }
}
fn validate_heartbeat_workers(body: &Value) -> ApiResult<()> {
    let Some(workers) = body["workers"].as_array() else {
        return Err(ApiError::bad("Heartbeat workers must be an array"));
    };
    let mut identities = std::collections::BTreeSet::new();
    for worker in workers {
        let Some(_) = worker.as_object() else {
            return Err(ApiError::bad("Heartbeat workers must contain objects"));
        };
        if matches!(
            (
                worker.get("worker_id").and_then(Value::as_str),
                worker.get("id").and_then(Value::as_str),
            ),
            (Some(explicit), Some(alias)) if explicit != alias
        ) {
            return Err(ApiError::bad(
                "Worker id and worker_id must agree when both are present",
            ));
        }
        let Some(id) = worker
            .get("worker_id")
            .or_else(|| worker.get("id"))
            .and_then(Value::as_str)
            .filter(|id| {
                !id.trim().is_empty() && id.len() <= 160 && !id.chars().any(char::is_control)
            })
        else {
            return Err(ApiError::bad(
                "Heartbeat worker_id must be a nonempty bounded string",
            ));
        };
        if !identities.insert(id) {
            return Err(ApiError::bad(
                "Heartbeat workers must not duplicate a worker identity",
            ));
        }
    }
    Ok(())
}

pub(crate) async fn heartbeat(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, installation) = node(&state, &headers, &body)?;
    let status = match body.get("status") {
        None => "online",
        Some(Value::String(value))
            if matches!(value.as_str(), "online" | "busy" | "degraded" | "offline") =>
        {
            value.as_str()
        }
        Some(_) => {
            return Err(ApiError::bad(
                "Heartbeat status must be the string online, busy, degraded, or offline",
            ))
        }
    };
    validate_heartbeat_workers(&body)?;
    let capacity = json!(body["capabilities"]);
    let workers = json!(body["workers"]);
    let inventory = body["inventory"].to_string();
    let store = state.lock()?;
    // A token authenticates an exact Node/Installation, not every row sharing
    // its Node ID. Never let another installation's heartbeat replace the
    // inventory, workers, status or liveness that belongs to this one.
    let changed = store.conn().execute("UPDATE nodes SET last_heartbeat=?1,status=?2,inventory=?3,capabilities=?4,workers=?5 WHERE id=?6 AND installation_id=?7 AND revoked_at IS NULL",params![now(),status,inventory,capacity.to_string(),workers.to_string(),node,installation])?;
    if changed != 1 {
        return Err(ApiError::denied(
            "heartbeat_inactive",
            "Heartbeat must belong to an exact active Node installation",
        ));
    }
    Ok(Json(
        json!({"accepted":true,"observed_at":now(),"inventory":"stale_if_heartbeats_exceed_policy"}),
    ))
}
pub(crate) async fn poll(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let wait = body["wait_seconds"].as_u64().unwrap_or(0).min(20);
    for _ in 0..=wait {
        let value = {
            let mut store = state.lock()?;
            crate::maintenance::assignment_for_poll(&mut store, &node)?
        };
        if let Some(assignment) = value {
            return Ok(Json(json!({"assignment":assignment})));
        }
        if wait > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }
    Ok(Json(json!({"assignment":null})))
}
pub(crate) async fn credential_authorize(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, installation) = node(&state, &headers, &body)?;
    let store = state.lock()?;
    let (ticket, _, _) = valid_lease(&store, &body, &node, false)?;
    let record = store
        .get("tickets", &ticket)?
        .ok_or_else(|| ApiError::missing("Credential task Ticket not found"))?;
    if record["kind"] != "credential_ref" || record["installation_id"] != installation {
        return Err(ApiError::denied(
            "credential_scope",
            "Credential authorization belongs to the enrolled Installation",
        ));
    }
    let rows = store.query(
        "SELECT * FROM assignments WHERE id=?1 AND ticket_id=?2 AND node_id=?3",
        params![
            body["assignment_id"].as_str().unwrap_or_default(),
            ticket,
            node
        ],
    )?;
    if rows.len() != 1 {
        return Err(ApiError::denied(
            "assignment_owner",
            "Credential authorization requires one current Assignment",
        ));
    }
    let assignment = rows.into_iter().next().unwrap();
    let authority = crate::credential_ref::authority(&store, &ticket, &assignment)?;
    let response = json!({"authorization":authority});
    store.audit(
        Some(&ticket),
        "node",
        "credential.authorization_checked",
        &json!({
            "assignment_id":body["assignment_id"], "action":authority["action"],
            "grant_version":authority["grant"]["version"], "always_short_lived":true
        }),
    )?;
    Ok(Json(response))
}

pub(crate) async fn acknowledge(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    body: Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let store = state.lock()?;
    let (ticket, assignment, _) = valid_lease(
        &store,
        &body,
        &node,
        body["cancel_requested"].as_bool().unwrap_or(false),
    )?;
    // A valid ordinary retransmission may reread this Assignment's already
    // committed admission. The current Node, Grant, attempt and lease are
    // checked above *before* replay. An opaque request_id is not authorization.
    if !body["cancel_requested"].as_bool().unwrap_or(false) {
        let assignment_record = store
            .get("assignments", &assignment)?
            .ok_or_else(|| ApiError::missing("Assignment not found"))?;
        let audited = store.audits(Some(&ticket))?.into_iter().filter(|entry| {
            if entry["actor"] != "node" || entry["action"] != "assignment.acknowledged" {
                return false;
            }
            let evidence = entry["evidence"].as_str().unwrap_or_default();
            serde_json::from_str::<Value>(evidence).is_ok_and(|envelope| {
                envelope["evidence"]["assignment_id"].as_str() == Some(assignment.as_str())
                    && envelope["evidence"]["delivered_is_not_read"] == true
            })
        });
        let exactly_one_matching_audit = audited.count() == 1;
        let timestamp = assignment_record["acknowledged_at"]
            .as_str()
            .filter(|value| parse_time(value).is_ok());
        match (
            assignment_record["acknowledged_at"].is_null(),
            timestamp,
            exactly_one_matching_audit,
        ) {
            (true, None, false) => {
                // The only ordinary first-admission state: neither timestamp
                // nor a corresponding audit yet exists.
            }
            (false, Some(original), true) => {
                return Ok(Json(json!({
                    "accepted":true,
                    "acknowledged_at":original,
                    "duplicate":true,
                    "delivered_is_not_read":true,
                    "report_or_execution_completed":false
                })));
            }
            _ => {
                return Err(ApiError::conflict(
                    "acknowledgement_inconsistent",
                    "A first acknowledgement needs neither timestamp nor audit; a replay needs one valid original timestamp and exactly one matching audit",
                ));
            }
        }
    }
    let mut store = store;
    let acknowledged_at = now();
    let tx = store.conn_mut().transaction()?;
    let result = (|| -> rusqlite::Result<()> {
        tx.execute(
            "UPDATE assignments SET acknowledged_at=?1 WHERE id=?2 AND ticket_id=?3 AND node_id=?4",
            params![acknowledged_at, assignment, ticket, node],
        )?;
        store::audit_tx(
            &tx,
            Some(&ticket),
            "node",
            "assignment.acknowledged",
            &json!({"assignment_id":assignment,"delivered_is_not_read":true}),
        )
        .map_err(|error| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                error.to_string(),
            )))
        })?;
        Ok(())
    })();
    result?;
    tx.commit()?;
    Ok(Json(
        json!({"accepted":true,"acknowledged_at":acknowledged_at}),
    ))
}
fn event_idempotency_conflict() -> ApiError {
    ApiError::conflict(
        "idempotency_conflict",
        "The same Node event Request ID cannot carry different immutable event data",
    )
}

fn corrupt_event_receipt() -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "receipt_corrupt",
        "Persisted Node event receipt or its message is not readable",
    )
}

fn event_message_matches(row: &Value, expected: &Value, ticket: &str, content: &str) -> bool {
    row["ticket_id"] == ticket
        && row["sender"] == expected["sender"]
        && row["recipient"] == "concierge"
        && row["kind"] == expected["kind"]
        && row["content"] == content
        && row["visibility"] == "summary"
        && row["session_ref"]
            .as_str()
            .and_then(|stored| serde_json::from_str::<Value>(stored).ok())
            .is_some_and(|stored| stored == expected["session_ref"])
}

fn event_receipt(
    tx: &rusqlite::Transaction<'_>,
    node: &str,
    request_id: &str,
) -> ApiResult<Option<Value>> {
    tx.query_row(
        "SELECT payload_digest,response FROM requests WHERE node_id=?1 AND route='events' AND request_id=?2",
        params![node, request_id],
        store::row_value,
    )
    .optional()
    .map_err(ApiError::from)
}

fn event_message(
    tx: &rusqlite::Transaction<'_>,
    message_id: &str,
    request_id: &str,
) -> ApiResult<Option<Value>> {
    tx.query_row(
        "SELECT id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id
         FROM messages WHERE id=?1 AND request_id=?2 AND source_event_id IS NULL",
        params![message_id, request_id],
        store::row_value,
    )
    .optional()
    .map_err(ApiError::from)
}

fn legacy_event_messages(
    tx: &rusqlite::Transaction<'_>,
    ticket: &str,
    request_id: &str,
) -> ApiResult<Vec<Value>> {
    let mut statement = tx.prepare(
        "SELECT id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id
         FROM messages WHERE ticket_id=?1 AND request_id=?2 AND source_event_id IS NULL
         ORDER BY created_at,id",
    )?;
    let rows = statement
        .query_map(params![ticket, request_id], store::row_value)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(crate) async fn event(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let request_id = required(&body, "request_id", 160)?.to_owned();
    let ticket = required(&body, "ticket_id", 160)?.to_owned();
    let assignment = required(&body, "assignment_id", 160)?;
    let content = body["activity"]
        .as_str()
        .or_else(|| body["content"].as_str())
        .filter(|x| x.len() <= 8000 && !x.is_empty())
        .ok_or_else(|| ApiError::bad("A bounded visible event summary is required"))?
        .to_owned();
    let sender = body["sender"].as_str().unwrap_or("worker").to_owned();
    let kind = body["kind"].as_str().unwrap_or("activity").to_owned();
    let mut logical_body = body.clone();
    logical_body
        .as_object_mut()
        .expect("the event is a JSON object after required field validation")
        .remove("request_id");
    let payload_digest = store::hash(
        &loom_protocol::canonical::json(&json!({"logical_fields":logical_body}))
            .map_err(|_| ApiError::bad("Node event body cannot be canonically encoded"))?,
    );
    let mut store = state.lock()?;
    // A receipt does not relax current admission; exact replay reads the retained
    // response only after the same current Lease and Assignment checks as a new event.
    valid_lease(&store, &body, &node, body["kind"] != "session_link")?;
    // Existing receipts and legacy rows compare only their complete historical
    // Session reference. Current parent/source validation belongs to insertion,
    // never to replay of an already immutable accepted event.
    let mut expected = json!({
        "sender":sender, "kind":kind,
        "session_ref":body.get("session_ref").cloned().unwrap_or_else(|| json!({"assignment_id":&assignment})),
    });
    let tx = store
        .conn_mut()
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if let Some(receipt) = event_receipt(&tx, &node, &request_id)? {
        // Parsing is mandatory before any new-insert path. A damaged response
        // must never be mistaken for absence of an already admitted event.
        let mut response: Value = serde_json::from_str(
            receipt["response"]
                .as_str()
                .ok_or_else(corrupt_event_receipt)?,
        )
        .map_err(|_| corrupt_event_receipt())?;
        if receipt["payload_digest"].as_str() != Some(payload_digest.as_str()) {
            return Err(event_idempotency_conflict());
        }
        if !response.is_object()
            || response["accepted"] != true
            || response["node_id"] != node
            || response["message_id"].as_str().is_none()
        {
            return Err(corrupt_event_receipt());
        }
        // A validated delegation may be normalized before the message is
        // persisted. Compare its recorded projection, never a self-asserted
        // body substitute, and do not reconstruct its parent during replay.
        expected["session_ref"] = response
            .get("stored_session_ref")
            .cloned()
            .ok_or_else(corrupt_event_receipt)?;
        let message_id = response["message_id"]
            .as_str()
            .ok_or_else(corrupt_event_receipt)?;
        let message =
            event_message(&tx, message_id, &request_id)?.ok_or_else(corrupt_event_receipt)?;
        if !event_message_matches(&message, &expected, &ticket, &content) {
            return Err(corrupt_event_receipt());
        }
        response
            .as_object_mut()
            .ok_or_else(corrupt_event_receipt)?
            .remove("stored_session_ref");
        response["duplicate"] = json!(true);
        // Drop the transaction explicitly before returning a historical response.
        drop(tx);
        return Ok(Json(response));
    }

    // Before receipts existed, Node messages used only this unique legacy key.
    // SourceEvent messages are excluded because their opaque IDs use another
    // namespace (source_id:event_id). Any other collision must be proved, not
    // silently ignored or allowed to acquire another event identity.
    let messages = legacy_event_messages(&tx, &ticket, &request_id)?;
    if !messages.is_empty() {
        if messages.len() == 1 && event_message_matches(&messages[0], &expected, &ticket, &content)
        {
            let message_id = messages[0]["id"].clone();
            drop(tx);
            return Ok(Json(json!({
                "accepted":true,"duplicate":true,"node_id":node,"message_id":message_id
            })));
        }
        return Err(event_idempotency_conflict());
    }

    drop(tx);
    let expected = if let Some(relation) = validated_delegation_relation(&store, &body)? {
        json!({
            "sender":sender, "kind":kind, "session_ref":{
                "harness":"dsh", "session_id":body["session_ref"]["session_id"],
                "protocol":"dsh-session-log", "host_api":body["session_ref"]["host_api"],
                "observed_seq":body["session_ref"]["observed_seq"], "delegated_from":relation,
            }
        })
    } else {
        expected
    };
    let tx = store
        .conn_mut()
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if event_receipt(&tx, &node, &request_id)?.is_some()
        || !legacy_event_messages(&tx, &ticket, &request_id)?.is_empty()
    {
        return Err(event_idempotency_conflict());
    }
    let message_id = id("message");
    let created_at = now();
    let response = json!({
        "accepted":true,"duplicate":false,"node_id":node,"message_id":message_id
    });
    // This resolved value is server-derived and is not returned as a new
    // worker authority. It is only used to compare an exact historical replay.
    let mut receipt_response = response.clone();
    receipt_response["stored_session_ref"] = expected["session_ref"].clone();
    tx.execute(
        "INSERT INTO messages(id,ticket_id,sender,recipient,kind,content,session_ref,visibility,created_at,request_id) VALUES(?1,?2,?3,'concierge',?4,?5,?6,'summary',?7,?8)",
        params![message_id,ticket,sender,kind,content,expected["session_ref"].to_string(),created_at,request_id],
    )?;
    tx.execute(
        "INSERT INTO requests(node_id,route,request_id,payload_digest,response,created_at) VALUES(?1,'events',?2,?3,?4,?5)",
        params![node,request_id,payload_digest,receipt_response.to_string(),created_at],
    )?;
    tx.commit()?;
    Ok(Json(response))
}

pub(crate) async fn source_input(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let store = state.lock()?;
    valid_lease(&store, &body, &node, false)?;
    // The center reads its assigned immutable relation, never an arbitrary
    // parent/session supplied by a worker or provider. No administrative token
    // is handed to a Node or exposed in its task tool scope.
    Ok(Json(crate::pipeline::delegated_source_proof(
        &store, &body,
    )?))
}

fn validated_delegation_relation(store: &store::Store, body: &Value) -> ApiResult<Option<Value>> {
    let claimed = body["session_ref"]["delegated_from"].clone();
    if claimed.is_null() {
        return Ok(None);
    }
    if body["kind"] != "session_link"
        || !claimed.is_object()
        || claimed["session"]["session_id"].is_null()
    {
        return Err(ApiError::denied(
            "delegation_evidence",
            "Delegation claims require a real Session link and its parent Session",
        ));
    }
    let mut checked_body = body.clone();
    checked_body["source_ref"] = json!({
        "type": claimed["type"], "artifact_id": claimed["artifact_id"], "ticket_id": claimed["ticket_id"],
        "origin_node_id": claimed["origin_node_id"], "sha256": claimed["sha256"],
        "location": claimed["location"], "parents": claimed["parents"],
    });
    let proof = crate::pipeline::delegated_source_proof(store, &checked_body).map_err(|error| {
        ApiError::denied(
            "delegation_evidence",
            format!("Only the actual pipeline source and parent Session may be linked: {error}"),
        )
    })?;
    let actual_parent = proof["parent_session_ref"]["session_id"].as_str();
    if actual_parent != claimed["session"]["session_id"].as_str() {
        return Err(ApiError::denied(
            "delegation_evidence",
            "The claimed parent Session does not match the producer's actual public Session",
        ));
    }
    let reference = proof["artifact_input"]["artifact_ref"].clone();
    Ok(Some(json!({
        "type": reference["type"], "artifact_id": reference["artifact_id"], "ticket_id": reference["ticket_id"],
        "origin_node_id": reference["origin_node_id"], "sha256": reference["sha256"],
        "location": reference["location"], "parents": reference["parents"],
        "session": proof["parent_session_ref"],
        "source_verified": true, "validated_by": "current_assignment_and_pipeline_relation"
    })))
}

fn valid_lease(
    store: &store::Store,
    body: &Value,
    node: &str,
    allow_cancel: bool,
) -> ApiResult<(String, String, i64)> {
    let ticket = required(body, "ticket_id", 160)?.to_owned();
    let assignment = required(body, "assignment_id", 160)?.to_owned();
    let epoch = body["lease_epoch"]
        .as_i64()
        .ok_or_else(|| ApiError::bad("lease_epoch integer is required"))?;
    let values=store.query("SELECT a.node_id,a.lease_epoch,a.lease_expires_at,t.attempt,t.cancel_requested,t.status,g.revoked_at FROM assignments a JOIN tickets t ON t.id=a.ticket_id JOIN grants g ON g.id=t.grant_id WHERE a.id=?1 AND t.id=?2",params![assignment,ticket])?.into_iter().next().ok_or_else(||ApiError::missing("Assignment/ticket not found"))?;
    if values["node_id"].as_str().unwrap_or_default() != node {
        return Err(ApiError::denied(
            "assignment_owner",
            "Authenticated node is not the assignment owner",
        ));
    }
    if values["lease_epoch"].as_i64() != Some(epoch) || values["attempt"].as_i64() != Some(epoch) {
        return Err(ApiError::denied(
            "stale_lease",
            "The report/artifact belongs to an old Assignment attempt or Lease",
        ));
    }
    let expired = values["lease_expires_at"]
        .as_str()
        .and_then(|x| parse_time(x).ok())
        .is_none_or(|x| x <= chrono::Utc::now());
    let cancelled = values["cancel_requested"] == true
        || values["status"]
            .as_str()
            .is_some_and(|s| ["cancelled", "cancel_requested", "reconciling"].contains(&s));
    if !allow_cancel && (expired || cancelled || values["revoked_at"] != Value::Null) {
        return Err(ApiError::conflict("outcome_unknown","Expired/revoked/cancelled execution cannot deliver a normal outcome. Reconcile its effects honestly."));
    }
    Ok((ticket, assignment, epoch))
}

async fn artifact_upload(
    Json(body): Json<Value>,
    state: Arc<State>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    // Validate ordinary uploads exactly as before. A narrowly validated source
    // diff may be retained for an already cancelled edit so it can be reported.

    let metadata = if body["metadata"].is_object() {
        body["metadata"].clone()
    } else {
        body.clone()
    };
    // Only a fixed, strictly validated tool invocation has a public code
    // projection. All unrelated metadata retains its prior private behavior.
    let mut code_evidence = crate::code_evidence::projected_metadata(&metadata)
        .map_err(|error| ApiError::bad(error.to_string()))?;
    let read_evidence = code_evidence
        .as_ref()
        .and_then(|text| serde_json::from_str::<Value>(text).ok())
        .filter(|value| value["schema"] == "loom.read-provenance.v1")
        .map(|value| value.to_string());
    if read_evidence.is_some() {
        // These public proof types are exclusive. Do not present the read
        // projection to the older source-code change/verification validator.
        code_evidence = None;
    }
    let bytes_base64 = body["bytes_base64"]
        .as_str()
        .or_else(|| body["bytes"].as_str())
        .ok_or_else(|| ApiError::bad("bytes_base64 is required"))?;
    let data = STANDARD
        .decode(bytes_base64)
        .map_err(|_| ApiError::bad("Canonical base64 artifact required"))?;
    if data.is_empty() || data.len() > MAX_INLINE_ARTIFACT_BYTES {
        return Err(ApiError::bad(
            "Inline artifact must be 1 byte through 8 MiB",
        ));
    };
    if let Some(proof) = read_evidence
        .as_ref()
        .map(|value| serde_json::from_str::<Value>(value).expect("validated above"))
    {
        crate::code_evidence::validate_read_artifact(&proof, &data)
            .map_err(|error| ApiError::bad(format!("read_artifact_body: {error}")))?;
    }
    let initial_lease = {
        let store = state.lock().unwrap();
        valid_lease(&store, &body, &node, false)
    };
    let (ticket, assignment, _) = match initial_lease {
        Ok(binding) => binding,
        Err(original) => {
            let candidate = read_evidence.is_none()
                && code_evidence.as_ref().is_some_and(|text| {
                    serde_json::from_str::<Value>(text).is_ok_and(|proof| proof["kind"] == "change")
                })
                && crate::code_evidence::can_upload_cancelled_change(
                    &state.lock().unwrap(),
                    body["ticket_id"].as_str().unwrap_or_default(),
                    body["assignment_id"].as_str().unwrap_or_default(),
                    &node,
                    &metadata,
                    &data,
                )
                .map_err(|error| {
                    ApiError::denied("cancelled_source_evidence", error.to_string())
                })?;
            if !candidate {
                return Err(original);
            }
            valid_lease(&state.lock().unwrap(), &body, &node, true)?
        }
    };
    let digest = sha256(&data);
    if metadata["sha256"].as_str().is_some_and(|s| s != digest)
        || metadata["size_bytes"]
            .as_i64()
            .is_some_and(|s| s != data.len() as i64)
    {
        return Err(ApiError::bad("Artifact size/hash mismatch"));
    }
    let artifact = metadata["artifact_id"]
        .as_str()
        .or_else(|| body["artifact_id"].as_str())
        .ok_or_else(|| ApiError::bad("artifact_id metadata required"))?
        .to_owned();
    if body["artifact_id"]
        .as_str()
        .is_some_and(|it| it != artifact)
    {
        return Err(ApiError::bad(
            "The top-level artifact id and its metadata must agree",
        ));
    }
    uuid::Uuid::parse_str(&artifact)
        .map_err(|_| ApiError::bad("Artifact identifier must be UUID"))?;
    let name = metadata["name"]
        .as_str()
        .unwrap_or("artifact.txt")
        .to_owned();
    let media = metadata["media_type"]
        .as_str()
        .unwrap_or("text/plain")
        .to_owned();
    if media.len() > 100 || name.len() > 200 {
        return Err(ApiError::bad("Artifact metadata too long "));
    };
    let mut lineage = Vec::new();
    let mut store = state.lock()?;
    if metadata["parents"].is_object()
        || metadata["parents"].is_string()
        || metadata["parents"].is_number()
        || metadata["parents"].is_boolean()
    {
        return Err(ApiError::bad(
            "Artifact parents must be an empty list or an explicit bounded SourceRef",
        ));
    }
    if (!metadata["artifact_ref"].is_null() && !metadata["artifact_ref"].is_object())
        || (metadata["artifact_ref"].is_null()
            && metadata["parents"]
                .as_array()
                .is_some_and(|parents| !parents.is_empty()))
    {
        if store.get("artifacts", &artifact)?.is_some_and(|existing| {
            existing["lineage"]
                .as_array()
                .is_some_and(|parents| !parents.is_empty())
        }) {
            return Err(ApiError::conflict(
                "artifact_conflict",
                "Removing an established Artifact's immutable parent lineage is forbidden",
            ));
        }
        return Err(ApiError::bad(
            "Each declared parent needs a valid artifact_ref and controller-verified lineage",
        ));
    }
    if let Some(reference) = metadata["artifact_ref"].as_object() {
        let source_id = reference
            .get("artifact_id")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad("Source dependency requires an actual Artifact UUID"))?;
        let source_hash = reference
            .get("sha256")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::bad("Source dependency requires its SHA-256"))?;
        if uuid::Uuid::parse_str(source_id).is_err() || source_hash.len() != 64 {
            return Err(ApiError::bad("Invalid source artifact reference"));
        }
        let parent = store.get("artifacts", source_id)?.ok_or_else(|| {
            ApiError::denied(
                "unknown_artifact_input",
                "Only an uploaded known Artifact can be a source",
            )
        })?;
        if parent["sha256"] != source_hash {
            return Err(ApiError::denied(
                "artifact_input_hash_mismatch",
                "The source hash does not match the immutable Artifact index",
            ));
        }
        if reference
            .get("origin_node_id")
            .and_then(Value::as_str)
            .is_some_and(|origin| origin != parent["origin_node_id"].as_str().unwrap_or_default())
        {
            return Err(ApiError::denied(
                "origin_mismatch",
                "The named source host does not match the actual Artifact origin",
            ));
        }
        lineage.push(json!({
        "type": "artifact_ref", "artifact_id":source_id, "origin_node_id":parent["origin_node_id"],
        "sha256":parent["sha256"],"component_sha256":digest,
        "source_location":parent["location"],
        "source_ticket_id":parent["ticket_id"],
        "artifact_ref":{"artifact_id":parent["id"],"sha256":parent["sha256"],"origin_node_id":parent["origin_node_id"]},
        "parents":parent["lineage"],
    }));
        if metadata["parents"].as_array().is_some_and(|declared| {
            declared.len() > 1
                || declared
                    .first()
                    .is_some_and(|entry| entry.as_str() != Some(source_id))
        }) {
            return Err(ApiError::conflict("inexact_lineage", "Parents may only hold the source UUID string or be empty; provenance fields are center-verified"));
        }
    }
    let path = store
        .root
        .join("artifacts")
        .join(format!("{artifact}.artifact"));
    if let Some(current) = store.get("artifacts", &artifact)? {
        let existing_read = crate::code_evidence::read_projection(&current)?;
        if read_evidence.as_deref()
            != existing_read
                .as_ref()
                .map(|value| value.to_string())
                .as_deref()
        {
            return Err(ApiError::conflict(
                "read_evidence_conflict",
                "Duplicate read evidence must keep the same tool, Session, sequence and source proof; add none or replace none is not a duplicate",
            ));
        }
        let existing_evidence = crate::code_evidence::projection(&current)?;
        if code_evidence
            .as_ref()
            .map(|value| {
                serde_json::from_str::<Value>(value)
                    .map_err(|_| ApiError::bad("Malformed bounded code-evidence projection"))
            })
            .transpose()?
            != existing_evidence
        {
            return Err(ApiError::conflict(
                "code_evidence_conflict",
                "An existing immutable Artifact's public code evidence cannot change or be added retroactively",
            ));
        }
        if current["sha256"] != digest
            || current["size_bytes"] != data.len()
            || current["assignment_id"] != assignment
            || current["ticket_id"] != ticket
            || current["origin_node_id"] != node
            || current["name"] != name
            || current["media_type"] != media
            || current["lineage"]
                .as_array()
                .is_some_and(|existing_lineage| existing_lineage != &lineage)
        {
            return Err(ApiError::conflict(
                "artifact_conflict",
                "An existing immutable artifact cannot change bytes or lineage",
            ));
        }
        let existing = fs::read(&path)?;
        if sha256(&existing) != digest || existing != data {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "artifact_storage_integrity",
                "Stored bytes or database evidence needs operator recovery; an upload may never repair it",
            ));
        }
        return Ok(Json(json!({
            "artifact_id":artifact,"ticket_id":ticket,"assignment_id":assignment,
            "duplicate":true,"origin_node_id":node,"name":current["name"],
            "media_type":current["media_type"],"size_bytes":current["size_bytes"],
            "sha256":current["sha256"],"location":current["location"]
        })));
    }
    // Model observation is derived from this same scoped immutable Artifact,
    // validated before any output bytes or auxiliary record are persisted.
    let model_observation = crate::model_observation::from_registration(
        &store,
        &ticket,
        &assignment,
        &node,
        &artifact,
        &digest,
        &metadata,
    )?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    use std::io::Write;
    if let Err(error) = Write::write_all(&mut file, &data) {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    if let Err(error) = file.sync_all() {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    let tx = store.conn_mut().transaction()?;
    let result = (|| -> rusqlite::Result<()> {
        tx.execute("INSERT INTO artifacts(id,ticket_id,assignment_id,origin_node_id,name,media_type,size_bytes,sha256,storage_name,location,lineage,created_at,code_evidence_json,read_evidence_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",params![artifact,ticket,assignment,node,name,media,data.len() as i64,digest,format!("{artifact}.artifact"),format!("loom://artifact/{artifact}"),serde_json::Value::Array(lineage.clone()).to_string(),now(),code_evidence,read_evidence])?;
        if let Some(observation) = model_observation.as_ref() {
            crate::model_observation::insert(&tx, observation)?;
        }
        store::audit_tx(
            &tx,
            Some(&ticket),
            "node",
            "artifact.indexed",
            &json!({"artifact_id":artifact,"sha256":digest,"origin_node_id":node}),
        )
        .map_err(|error| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(
                error.to_string(),
            )))
        })?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    if let Err(error) = tx.commit() {
        let _ = fs::remove_file(&path);
        return Err(error.into());
    }
    let current = store
        .get("artifacts", &artifact)?
        .expect("committed artifact");
    Ok(Json(
        json!({"artifact_id":artifact,"ticket_id":ticket,"assignment_id":assignment,"origin_node_id":node,"name":current["name"],"media_type":current["media_type"],"size_bytes":data.len(),"sha256":digest,"location":format!("loom://artifact/{artifact}")}),
    ))
}

fn effect_story_is_unchanged(
    existing: &Value,
    effect: &Value,
    ticket: &str,
    assignment: &str,
    node: &str,
    epoch: i64,
) -> bool {
    let evidence_equal = match existing["evidence"].as_str() {
        Some(raw) => serde_json::from_str::<Value>(raw).is_ok_and(|old| old == effect["evidence"]),
        None => existing["evidence"] == effect["evidence"],
    };
    existing["ticket_id"] == ticket
        && existing["assignment_id"] == assignment
        && existing["node_id"] == node
        && existing["attempt"] == epoch
        && existing["input_digest"] == effect["input_digest"]
        && existing["status"] == effect["status"].as_str().unwrap_or("unknown")
        && evidence_equal
        && existing["artifacts"] == effect["artifacts"]
}

/// Existing Effect identities cannot be silently ignored or moved between
/// Assignments. A second identical fact may participate in reconciliation,
/// but never acquires a new scope or a status upgrade through INSERT IGNORE.
fn preserve_effect_identity(
    store: &store::Store,
    effect: &Value,
    ticket: &str,
    assignment: &str,
    node: &str,
    epoch: i64,
) -> ApiResult<bool> {
    let effect_id = effect["effect_id"].as_str().unwrap_or_default();
    let existing = store.query("SELECT * FROM effects WHERE id=?1", [effect_id])?;
    if existing.is_empty() {
        return Ok(true);
    }
    if existing.len() == 1
        && effect_story_is_unchanged(&existing[0], effect, ticket, assignment, node, epoch)
    {
        return Ok(false);
    }
    Err(ApiError::conflict(
        "effect_collision",
        "An Effect identity cannot be reused for another Assignment, Ticket, Node or different immutable facts",
    ))
}

pub(crate) async fn report(
    AppState(state): AppState<Arc<State>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (node, _) = node(&state, &headers, &body)?;
    let request_id = required(&body, "request_id", 160)?.to_owned();
    let ticket = required(&body, "ticket_id", 160)?.to_owned();
    let assignment = required(&body, "assignment_id", 160)?.to_owned();
    let epoch = body["lease_epoch"]
        .as_i64()
        .ok_or_else(|| ApiError::bad("lease_epoch is required"))?;
    let requested_state = body["state"]
        .as_str()
        .or_else(|| body["status"].as_str())
        .or_else(|| body["requested_state"].as_str())
        .ok_or_else(|| ApiError::bad("A structured Report state is required"))?;
    if !matches!(
        requested_state,
        "running" | "succeeded" | "failed" | "cancelled" | "unknown"
    ) {
        return Err(ApiError::bad("Report state is not recognized"));
    }
    let mut store = state.lock()?;
    let payload_digest = store::hash(&body.to_string());
    let ownership = store.query(
        "SELECT t.attempt,a.lease_epoch,t.status FROM assignments a JOIN tickets t ON t.id=a.ticket_id WHERE a.id=?1 AND a.node_id=?2 AND a.ticket_id=?3",
        params![assignment, node, ticket],
    )?.into_iter().next().ok_or_else(||ApiError::denied("assignment_owner", "A node cannot report against another Assignment"))?;
    if ownership["attempt"] != epoch || ownership["lease_epoch"] != epoch {
        return Err(ApiError::denied(
            "stale_lease",
            "A report may not belong to a superseded Assignment attempt",
        ));
    }
    // Every replay must be decided before expiry/cancellation/reducer branches. It cannot
    // mutate state twice, but a changed body with the same request identity is a conflict.
    if let Some(receipt) = store.query(
        "SELECT response,payload_digest FROM requests WHERE node_id=?1 AND route='reports' AND request_id=?2",
        params![node,request_id],
    )?.into_iter().next() {
        if receipt["payload_digest"] != payload_digest {
            return Err(ApiError::conflict("idempotency_conflict", "The same Request ID must contain the same structured evidence"));
        }
        let receipt: Value = serde_json::from_str(receipt["response"].as_str().unwrap_or("null"))
            .map_err(|_|ApiError::new(StatusCode::INTERNAL_SERVER_ERROR,"receipt_corrupt","Persisted receipt is not readable"))?;
        return Ok(Json(json!({"duplicate":true,"request_id":request_id,"receipt":receipt})));
    }
    if matches!(
        ownership["status"].as_str(),
        Some("succeeded" | "failed" | "cancelled")
    ) {
        return Err(ApiError::conflict(
            "terminal_result",
            "A delivered terminal result cannot be changed by another report",
        ));
    }
    let evidence_only = matches!(requested_state, "unknown" | "cancelled");
    let (ticket, assignment, _) = valid_lease(&store, &body, &node, evidence_only)?;
    let ticket_record = store
        .get("tickets", &ticket)?
        .ok_or_else(|| ApiError::missing("Ticket not found"))?;
    let cancelled = ticket_record["cancel_requested"].as_bool().unwrap_or(false);
    if requested_state == "cancelled"
        && (!cancelled || body["cancel_acknowledged"].as_bool() != Some(true))
    {
        return Err(ApiError::conflict("cancel_gate", "Cancellation can only be acknowledged against durable center stop intent and an explicit ack"));
    }
    let artifacts = body["artifact_ids"].as_array().cloned().unwrap_or_else(|| {
        body["artifacts"]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .map(|entry| entry["artifact_id"].clone())
                    .collect()
            })
            .unwrap_or_default()
    });
    for artifact in &artifacts {
        let id = artifact
            .as_str()
            .ok_or_else(|| ApiError::bad("artifact_ids must be strings"))?;
        let found = store.get("artifacts", id)?.ok_or_else(|| {
            ApiError::denied("artifact_lineage", "Report cites an unknown artifact")
        })?;
        if found["assignment_id"] != assignment
            || found["ticket_id"] != ticket
            || found["origin_node_id"] != node
        {
            return Err(ApiError::denied(
                "artifact_lineage",
                "Report cites an artifact from a different scope",
            ));
        }
    }
    if requested_state == "succeeded" && artifacts.is_empty() {
        return Err(ApiError::bad(
            "Success requires uploaded and verified artifacts",
        ));
    }
    let effects = body["effects"].as_array().cloned().unwrap_or_default();
    if requested_state == "unknown" && effects.is_empty() {
        return Err(ApiError::bad(
            "Unknown outcome requires a structured Effect to reconcile",
        ));
    }
    for effect in &effects {
        if effect["effect_id"].as_str().is_none()
            || effect["effect_id"].as_str().unwrap_or_default().is_empty()
        {
            return Err(ApiError::bad("An effect requires an immutable identity"));
        }
        let effect_status = effect["status"].as_str().unwrap_or("unknown");
        if !matches!(
            effect_status,
            "recorded" | "unknown" | "confirmed" | "needs_person"
        ) {
            return Err(ApiError::bad("Effect status is not recognized"));
        }
        let cancelled_change = requested_state == "unknown"
            && cancelled
            && body["cancel_acknowledged"].as_bool() == Some(true)
            && crate::code_evidence::is_cancelled_change_request(&store, &artifacts, &effects)?;
        if requested_state == "unknown" && effect_status == "confirmed" && !cancelled_change {
            return Err(ApiError::conflict(
                "effect_unknown",
                "Unknown outcome cannot promote unobserved external effects to confirmed",
            ));
        }
        for reference in effect["artifacts"].as_array().into_iter().flatten() {
            if !artifacts.contains(reference) {
                return Err(ApiError::denied(
                    "effect_lineage",
                    "Effect references an artifact not linked to this Report",
                ));
            }
        }
    }
    if ticket_record["kind"] == "credential_ref" {
        crate::credential_ref::validate_outcome(&store, &ticket, &body)?;
    }
    let mut unseen_effects = std::collections::BTreeSet::new();
    let mut effects_to_insert = Vec::new();
    for effect in &effects {
        let effect_id = effect["effect_id"].as_str().unwrap_or_default();
        if !unseen_effects.insert(effect_id) {
            return Err(ApiError::conflict(
                "effect_collision",
                "A Report may not list the same immutable Effect identity twice",
            ));
        }
        if preserve_effect_identity(&store, effect, &ticket, &assignment, &node, epoch)? {
            effects_to_insert.push(effect.clone());
        }
    }
    crate::code_evidence::validate_outcome_with_evidence(
        &store,
        &ticket,
        &assignment,
        &artifacts,
        &effects,
        requested_state,
        body["cancel_acknowledged"].as_bool() == Some(true),
        &body["evidence"],
    )
    .map_err(|error| ApiError::bad(error.to_string()))?;
    let authority_status = if requested_state == "unknown" {
        "reconciling"
    } else {
        requested_state
    };
    let report_id = id("report");
    let response = json!({
        "accepted":true,"report_id":report_id,"request_id":request_id,
        "ticket_status":authority_status,"disposition":if authority_status=="reconciling"{"corrected_to_reconciling"}else{"accepted"},
        "facts_already_existed":false
    });
    let at = now();
    let tx = store.conn_mut().transaction()?;
    tx.execute(
        "INSERT INTO reports(id,assignment_id,ticket_id,node_id,lease_epoch,request_id,state,summary,evidence,session_ref,cancel_acknowledged,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
        params![report_id,assignment,ticket,node,epoch,request_id,requested_state,body["summary"].as_str().unwrap_or("No summary"),body["evidence"].to_string(),body["session_ref"].as_str(), cancelled && body["cancel_acknowledged"].as_bool() == Some(true),at],
    )?;
    for effect in &effects_to_insert {
        tx.execute(
            "INSERT INTO effects(id,ticket_id,assignment_id,node_id,attempt,input_digest,status,evidence,artifacts,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10)",
            params![effect["effect_id"].as_str().unwrap(),ticket,assignment,node,epoch,effect["input_digest"].as_str().unwrap_or(""),effect["status"].as_str().unwrap_or("unknown"),effect["evidence"].to_string(),effect["artifacts"].to_string(),at],
        )?;
    }
    tx.execute(
        "UPDATE tickets SET status=?1,updated_at=?2 WHERE id=?3",
        params![authority_status, at, ticket],
    )?;
    tx.execute(
        "UPDATE assignments SET last_report_at=?1 WHERE id=?2",
        params![at, assignment],
    )?;
    tx.execute("INSERT INTO requests(node_id,route,request_id,payload_digest,response,created_at) VALUES(?1,'reports',?2,?3,?4,?5)",params![node,request_id,payload_digest,response.to_string(),at])?;
    store::audit_tx(
        &tx,
        Some(&ticket),
        "node",
        "report.accepted",
        &json!({"report_id":report_id,"status":authority_status,"request_id":request_id}),
    )
    .map_err(|error| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(error.to_string())))
    })?;
    tx.commit()?;
    Ok(Json(response))
}

fn artifact_storage_path(store_root: &Path, artifact: &Value) -> ApiResult<PathBuf> {
    let location_error = || {
        ApiError::conflict(
            "artifact_location",
            "Artifact storage metadata names an invalid location; content was not returned",
        )
    };
    let storage_name = artifact["storage_name"]
        .as_str()
        .ok_or_else(location_error)?;
    let mut components = Path::new(storage_name).components();
    if storage_name.is_empty()
        || storage_name.contains(['/', '\\'])
        || matches!(storage_name, "." | "..")
        || !matches!(components.next(), Some(std::path::Component::Normal(_)))
        || components.next().is_some()
    {
        return Err(location_error());
    }
    let id = artifact["id"].as_str().ok_or_else(location_error)?;
    if uuid::Uuid::parse_str(id).is_ok() && storage_name != format!("{id}.artifact") {
        return Err(location_error());
    }
    let path = store_root.join("artifacts").join(storage_name);
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApiError::conflict(
                "artifact_storage_unavailable",
                "Artifact metadata exists but its stored bytes are unavailable",
            ));
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.file_type().is_file() {
        return Err(location_error());
    }
    Ok(path)
}

#[derive(Clone, Copy, Default)]
enum ArtifactEncoding {
    #[default]
    Utf8,
    Base64,
}

impl ArtifactEncoding {
    fn as_str(self) -> &'static str {
        match self {
            Self::Utf8 => "utf8",
            Self::Base64 => "base64",
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactReadQuery {
    #[serde(default)]
    encoding: Option<String>,
}

fn artifact_size(artifact: &Value) -> ApiResult<u64> {
    artifact["size_bytes"].as_u64().ok_or_else(|| {
        ApiError::conflict(
            "artifact_integrity",
            "Artifact size metadata is invalid; content was not returned",
        )
    })
}

fn artifact_sha256(artifact: &Value) -> ApiResult<&str> {
    artifact["sha256"].as_str().ok_or_else(|| {
        ApiError::conflict(
            "artifact_integrity",
            "Artifact digest metadata is invalid; content was not returned",
        )
    })
}

fn artifact_too_large() -> ApiError {
    ApiError::conflict(
        "artifact_too_large",
        "Artifact exceeds the 8 MiB read limit; content was not returned",
    )
}

fn artifact_file_io<T>(result: std::io::Result<T>) -> ApiResult<T> {
    result.map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => ApiError::conflict(
            "artifact_storage_unavailable",
            "Artifact metadata exists but its stored bytes are unavailable",
        ),
        _ => ApiError::from(error),
    })
}

fn read_projection_db_error(error: anyhow::Error) -> ApiError {
    if matches!(
        error.downcast_ref::<rusqlite::Error>(),
        Some(rusqlite::Error::FromSqlConversionFailure(..))
    ) {
        // The column's internal representation cannot be interpreted for this
        // public schema; don't echo its name or original SQL error.
        ApiError::bad(
            "Stored read evidence is invalid or incompatible; no reader proof was asserted.",
        )
    } else {
        error.into()
    }
}

fn public_code_projection(value: &Value) -> ApiResult<Option<Value>> {
    crate::code_evidence::projection(value).map_err(|_| {
        // Validation errors cannot expose the private SQL field or its arbitrary
        // original provenance candidate to the API consumer.
        ApiError::bad(
            "Stored source-change evidence is invalid or incompatible; no code proof was asserted.",
        )
    })
}

fn public_read_projection(value: &Value) -> ApiResult<Option<Value>> {
    crate::code_evidence::read_projection(value).map_err(|_| {
        // Failed raw projection must not echo SQLite columns or private
        // per-record error text into the protected client response.
        ApiError::bad(
            "Stored read evidence is invalid or incompatible; no reader proof was asserted.",
        )
    })
}

async fn artifact(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path((ticket, artifact)): axum::extract::Path<(String, String)>,
    query: Result<
        axum::extract::Query<ArtifactReadQuery>,
        axum::extract::rejection::QueryRejection,
    >,
) -> ApiResult<Json<Value>> {
    let query = query.map_err(|_| {
        ApiError::bad("Artifact query accepts one encoding parameter with value utf8 or base64")
    })?;
    let encoding = match query.encoding.as_deref() {
        None | Some("utf8") => ArtifactEncoding::Utf8,
        Some("base64") => ArtifactEncoding::Base64,
        Some(_) => {
            return Err(ApiError::bad(
                "Artifact encoding must be exactly utf8 or base64",
            ));
        }
    };
    let store = state.lock()?;
    let mut a = store
        .get("artifacts", &artifact)
        .map_err(read_projection_db_error)?
        .ok_or_else(|| ApiError::missing("Artifact unknown"))?;
    a["location"] = json!(format!("loom://artifact/{artifact}"));
    if a["ticket_id"] != ticket {
        return Err(ApiError::denied(
            "artifact_scope",
            "Ticket does not own this artifact",
        ));
    }
    let public_evidence = public_code_projection(&a)?;
    let public_read = public_read_projection(&a)?;
    if public_evidence.is_some() && public_read.is_some() {
        return Err(ApiError::conflict(
            "artifact_evidence_conflict",
            "An Artifact cannot expose both code and read proof namespaces",
        ));
    }
    if let Some(storage_fields) = a.as_object_mut() {
        storage_fields.remove("code_evidence_json");
    }
    a["code_evidence"] = public_evidence.unwrap_or(Value::Null);
    if let Some(storage_fields) = a.as_object_mut() {
        storage_fields.remove("read_evidence_json");
    }
    a["read_evidence"] = public_read.unwrap_or(Value::Null);
    let path = artifact_storage_path(&store.root, &a)?;
    let mut file = artifact_file_io(std::fs::File::open(&path))?;
    let metadata = artifact_file_io(file.metadata())?;
    if metadata.len() > MAX_INLINE_ARTIFACT_BYTES as u64 {
        return Err(artifact_too_large());
    }
    let expected_size = artifact_size(&a)?;
    let expected_sha256 = artifact_sha256(&a)?;
    let mut bytes = Vec::with_capacity(MAX_INLINE_ARTIFACT_BYTES.min(64 * 1024));
    artifact_file_io(
        file.by_ref()
            .take(MAX_INLINE_ARTIFACT_BYTES as u64 + 1)
            .read_to_end(&mut bytes),
    )?;
    if bytes.len() > MAX_INLINE_ARTIFACT_BYTES {
        return Err(artifact_too_large());
    }
    if bytes.len() as u64 != expected_size || sha256(&bytes) != expected_sha256 {
        return Err(ApiError::conflict(
            "artifact_integrity",
            "Artifact no longer matches its recorded size or digest",
        ));
    }
    let size_bytes = bytes.len();
    let content = match encoding {
        ArtifactEncoding::Utf8 => String::from_utf8(bytes).map_err(|_| {
            ApiError::conflict(
                "artifact_encoding",
                "Artifact bytes are not UTF-8; this request expects plain text. Use an explicit base64 encoding for the bounded raw-byte read",
            )
        })?,
        ArtifactEncoding::Base64 => STANDARD.encode(&bytes),
    };
    Ok(Json(json!({
        "artifact":a,
        "content":content,
        "size_bytes":size_bytes,
        "encoding":encoding.as_str(),
        "truncated":false,
    })))
}
async fn tickets(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({"tickets":state.lock()?.list("tickets")?})))
}
async fn ticket(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let mut detail = store.detail(&id).map_err(read_projection_db_error)?;
    for artifact in detail["artifacts"].as_array_mut().into_iter().flatten() {
        let public_evidence = public_code_projection(artifact)?;
        if let Some(storage_fields) = artifact.as_object_mut() {
            storage_fields.remove("code_evidence_json");
        }
        let public_read = public_read_projection(artifact)?;
        if public_evidence.is_some() && public_read.is_some() {
            return Err(ApiError::conflict(
                "artifact_evidence_conflict",
                "An Artifact cannot expose both code and read proof namespaces",
            ));
        }
        artifact["code_evidence"] = public_evidence.unwrap_or(Value::Null);
        if let Some(storage_fields) = artifact.as_object_mut() {
            storage_fields.remove("read_evidence_json");
        }
        artifact["read_evidence"] = public_read.unwrap_or(Value::Null);
    }
    detail["model_observation"] = crate::model_observation::for_ticket(&store, &id)?
        .map_or(Value::Null, |entry| json!(entry));
    Ok(Json(detail))
}
fn deserialize_ticket_priority<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    let Some(Value::Number(number)) = value else {
        return Err(serde::de::Error::custom(
            "priority must be an integer between -100 and 100, not null",
        ));
    };
    match number.as_i64() {
        Some(priority @ -100..=100) => Ok(Some(priority)),
        _ => Err(serde::de::Error::custom(
            "priority must be an integer between -100 and 100, not null",
        )),
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketRequest {
    project_id: String,
    objective: Option<String>,
    goal: Option<String>,
    #[serde(alias = "title")]
    kind: Option<String>,
    relative_path: Option<String>,
    content: Option<String>,
    grant_id: Option<String>,
    node_id: Option<String>,
    worker_id: Option<String>,
    capability: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
    #[serde(default)]
    placement_id: Option<String>,
    #[serde(default)]
    source_event_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_ticket_priority")]
    priority: Option<i64>,
}
#[allow(clippy::too_many_arguments)]
async fn create_ticket(
    AppState(state): AppState<Arc<State>>,
    _headers: HeaderMap,
    request: Result<Json<TicketRequest>, axum::extract::rejection::JsonRejection>,
) -> ApiResult<Json<Value>> {
    let Json(body) = request.map_err(|_| {
        ApiError::bad("Ticket schema, duplicate keys, unknown fields or value types are invalid")
    })?;
    let mut store = state.lock()?;
    if body.source_event_id.is_some() {
        return create_ticket_from_source_event(&mut store, body);
    }
    let project = store
        .get("projects", &body.project_id)?
        .ok_or_else(|| ApiError::bad("Authorized project reference required"))?;
    let kind = body.kind.as_deref().unwrap_or("read_summary");
    if !matches!(
        kind,
        "read_summary" | "edit_file" | "model_text" | "model_descriptor"
    ) {
        return Err(ApiError::bad("Supported task kinds are read_summary, edit_file, separately authorized model_text and read-only model_descriptor"));
    }
    if kind == "model_descriptor" {
        if body.relative_path.as_deref() != Some("model.json") {
            return Err(ApiError::bad(
                "model_descriptor requires relative_path exactly model.json and only reads this bounded descriptor",
            ));
        }
        if body.content.is_some() {
            return Err(ApiError::bad(
                "model_descriptor is read-only and cannot supply source content",
            ));
        }
        if body.capability.is_some() {
            return Err(ApiError::bad(
                "model_descriptor requires its matching read-only physical capability; no override",
            ));
        }
    }
    let path = safe_relative(
        body.relative_path
            .as_deref()
            .unwrap_or(if kind == "read_summary" {
                "README.md"
            } else {
                "not-a-file-operation"
            }),
    )?;
    let model_resource = if kind == "model_text" {
        let provider = body.provider.as_deref().unwrap_or_default();
        let model = body.model.as_deref().unwrap_or_default();
        if provider.is_empty()
            || model.is_empty()
            || [provider, model].iter().any(|value| {
                value.len() > 160
                    || !value.chars().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':' | '/')
                    })
            })
        {
            return Err(ApiError::bad(
                "A text model request requires a bounded explicit provider and model",
            ));
        }
        // This narrowly proven fixture is not a claim that arbitrary providers
        // are installed. It must never select/bill a different remote model.
        if body.content.is_some() {
            return Err(ApiError::bad("Text-model input is the explicit goal and provider/model selection, not a hidden block payload"));
        }
        if (provider, model) != ("loom-stub", "loom-stub-v1") {
            return Err(ApiError::new(
                StatusCode::NOT_IMPLEMENTED,
                "model_unavailable",
                "Only the explicit inspected loom-stub/loom-stub-v1 text fixture is eligible",
            ));
        }
        Some((provider, model))
    } else {
        if body.model_id.is_some() || body.placement_id.is_some() {
            return Err(ApiError::bad(
                "model_id/placement_id apply only to a separately authorized model_text task",
            ));
        }
        if body.provider.is_some() || body.model.is_some() {
            return Err(ApiError::bad(
                "provider/model fields are only valid on a separately granted model_text task",
            ));
        }
        None
    };
    let goal = body
        .objective
        .as_ref()
        .or(body.goal.as_ref())
        .cloned()
        .unwrap_or_default();
    if goal.is_empty() || goal.len() > 16000 {
        return Err(ApiError::bad("Explicit objective required"));
    } // Grant permission `read|write` is separately checked against Ticket kind below;
      // the stored operation list is not a TicketKind string alias.
    let grant_id = if let Some(grant) = body.grant_id.as_ref() {
        grant.clone()
    } else {
        let permission = match kind {
            "read_summary" | "model_descriptor" => "read",
            "edit_file" => "write",
            _ => "invoke_text",
        };
        let selections=store.query("SELECT id,operations,project_id,revoked_at FROM grants WHERE project_id=?1 AND revoked_at IS NULL ORDER BY created_at DESC",[&body.project_id])?;
        let selected = selections.into_iter().find(|g| {
            g["operations"]
                .as_array()
                .is_some_and(|ops| ops.iter().any(|v| v.as_str() == Some(permission)))
        });
        selected
            .and_then(|g| g["id"].as_str().map(ToOwned::to_owned))
            .ok_or_else(|| {
                ApiError::denied(
                    "grant_required",
                    "No current Grant permits this task's project and permission.",
                )
            })?
    };
    let grant = store
        .get("grants", &grant_id)?
        .ok_or_else(|| ApiError::bad("Grant not found"))?;
    if grant["project_id"] != body.project_id || grant["revoked_at"] != Value::Null {
        return Err(ApiError::denied(
            "grant_scope",
            "Grant is revoked or belongs to another project",
        ));
    };
    let ops = grant["operations"]
        .as_array()
        .map(|ops| ops.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    if !ops.contains(
        &(match kind {
            "read_summary" | "model_descriptor" => "read",
            "edit_file" => "write",
            _ => "invoke_text",
        }),
    ) {
        return Err(ApiError::denied(
            "operation_scope",
            "Grant does not permit this operation",
        ));
    }
    let model_resource = if let Some((provider, model)) = model_resource {
        let binding = model_binding_for(&store, &body, &grant)?;
        Some((provider, model, Some(binding)))
    } else {
        None
    };
    if project["mode"] == "read_only" && kind == "edit_file" {
        return Err(ApiError::denied(
            "read_only",
            "Project has no write authorization",
        ));
    }
    if let Some(node_id) = &body.node_id {
        if grant["node_id"] != "auto" && grant["node_id"].as_str() != Some(node_id.as_str()) {
            return Err(ApiError::denied(
                "placement_scope",
                "This Task selects a Node different from the Grant's authorized placement",
            ));
        }
    }
    if let Some(requested_worker) = &body.worker_id {
        if grant["worker_id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .is_some_and(|authorized| authorized != requested_worker)
        {
            return Err(ApiError::denied(
                "worker_scope",
                "The requested Worker is not the Grant's authorized Worker scope",
            ));
        }
    }
    let wanted = body.node_id.or_else(|| {
        grant["node_id"]
            .as_str()
            .filter(|x| *x != "auto")
            .map(str::to_owned)
    });
    let nodes = store.list("nodes")?;
    let selected = if let Some(ref target) = wanted {
        nodes
            .into_iter()
            .find(|n| n["id"].as_str() == Some(target.as_str()))
    } else {
        nodes.into_iter().find(|n| {
            n["capabilities"].as_array().is_some_and(|c| {
                c.iter().any(|v| {
                    v["ticket_kind"] == kind || v.as_str() == Some(&format!("file:{kind}"))
                })
            })
        })
    };
    let Some(_node) = selected else {
        return Err(ApiError::conflict("no_available_host","No authorized online Host currently supports this task; evidence shows capability, not a fabricated success"));
    };
    let gid = grant_id;
    let request = crate::maintenance::create_ticket(
        &mut store,
        &body.project_id,
        kind,
        &goal,
        &path.to_string_lossy(),
        body.content.as_deref(),
        &gid,
        wanted.as_deref(),
        body.worker_id.as_deref(),
        body.capability.as_deref(),
        model_resource,
        None,
        body.priority.unwrap_or(0),
    )?;
    Ok(Json(request))
}
fn create_ticket_from_source_event(
    store: &mut store::Store,
    body: TicketRequest,
) -> ApiResult<Json<Value>> {
    let event_id = crate::source_events::opaque(
        body.source_event_id.as_deref().unwrap_or_default(),
        "source_event_id",
    )?;
    if body.kind.as_deref() != Some("read_summary")
        || body.content.is_some()
        || body.provider.is_some()
        || body.model.is_some()
        || body.model_id.is_some()
        || body.placement_id.is_some()
        || body.priority.is_some()
        || body
            .capability
            .as_deref()
            .is_some_and(|capability| capability != "read_summary")
    {
        return Err(ApiError::denied("source_task_scope", "Only an actual project-file read_summary may be linked; no inline, model, write or capability override"));
    }
    let grant_id = body.grant_id.as_ref().ok_or_else(|| {
        ApiError::denied(
            "source_task_grant_required",
            "An explicit existing Grant is required",
        )
    })?;
    if body
        .objective
        .as_ref()
        .zip(body.goal.as_ref())
        .is_some_and(|(objective, goal)| objective != goal)
    {
        return Err(ApiError::denied(
            "source_task_identity_conflict",
            "Objective and goal must not contradict one another when provenance matters",
        ));
    }
    let objective = body
        .objective
        .as_ref()
        .or(body.goal.as_ref())
        .cloned()
        .unwrap_or_default();
    let path = safe_relative(body.relative_path.as_deref().ok_or_else(|| {
        ApiError::denied(
            "source_task_path_required",
            "The user must explicitly choose the authorized file; no implicit README selection",
        )
    })?)?;
    let event = crate::source_events::lookup_client_event(store, &event_id)?;
    if event["kind"] != "user_message" || event["content"] != objective {
        return Err(ApiError::conflict(
            "source_task_identity_conflict",
            "The requested objective must exactly match the immutable recorded user message",
        ));
    }
    let Some(node_id) = body.node_id.filter(|node| !node.is_empty()) else {
        return Err(ApiError::denied(
            "source_task_node_required",
            "Explicit physical Node selection is required; automatic placement cannot substitute",
        ));
    };
    let worker = body.worker_id.as_deref().unwrap_or("default");
    let event_digest = event["payload_digest"].as_str().ok_or_else(|| {
        ApiError::conflict(
            "source_task_identity_conflict",
            "Recorded event digest is missing",
        )
    })?;
    if event["task_ticket_id"].is_null() {
        let ticket_id = crate::id("tkt");
        let spec = crate::source_work::for_ticket(
            store, &body.project_id, "read_summary", &objective, &path.to_string_lossy(),
            &event_id, event_digest, &ticket_id,
            grant_id, &node_id, worker,
        ).map_err(|error| ApiError::denied("grant_scope", format!("Requires an exact current read Grant/Binding/Project/Node/Installation/Worker: {}", error)))?;
        let work = crate::maintenance::SourceWork {
            event_id: event_id.clone(),
            project: body.project_id.clone(),
            event_digest: event_digest.to_owned(),
            objective: objective.clone(),
            path: path.to_string_lossy().into_owned(),
            spec,
        };
        let task_digest = work.spec.digest.clone();
        let ticket = crate::maintenance::create_ticket(
            &mut *store, &body.project_id, "read_summary", &objective,
            &path.to_string_lossy(), None, grant_id, Some(&node_id), Some(worker), Some("read_summary"), None, Some(work), 0,
        ).map_err(|_| ApiError::denied("source_task_scope", "The frozen spec, physical capability or root authorization is unavailable or incompatible"))?;
        let ticket_id = ticket["id"].as_str().ok_or_else(|| {
            ApiError::conflict("source_task_identity_conflict", "New Ticket ID missing")
        })?;
        return Ok(Json(
            json!({"ticket":store.detail(ticket_id)?,"source_event_id":event["id"],"task_digest":task_digest,"duplicate":false,"task_created":true,"linked_existing_authorized_ticket":false}),
        ));
    }
    let spec = crate::source_events::validated_replay_spec(store, &event)?;
    if spec["grant_id"] != *grant_id
        || spec["node_id"] != node_id
        || spec["worker_id"] != worker
        || spec["project_id"] != body.project_id
        || spec["relative_path"] != json!(path.to_string_lossy())
    {
        return Err(ApiError::conflict("source_task_rebind", "The event and its immutable work specification cannot be rebound to a different Ticket"));
    }
    let existing =
        store.detail(event["task_ticket_id"].as_str().ok_or_else(|| {
            ApiError::conflict("source_task_rebind", "Created Ticket ID missing")
        })?)?;
    Ok(Json(
        json!({"ticket":existing,"source_event_id":event["id"],"task_digest":spec["digest"],"duplicate":true,"task_created":false,"linked_existing_authorized_ticket":true}),
    ))
}

fn model_binding_for(
    store: &store::Store,
    request: &TicketRequest,
    invocation: &Value,
) -> Result<Value, ApiError> {
    let model_id = request.model_id.as_deref().ok_or_else(|| {
        ApiError::denied(
            "model_binding_required",
            "A registered model and its current placement are required",
        )
    })?;
    let placement_id = request.placement_id.as_deref().ok_or_else(|| {
        ApiError::denied(
            "model_binding_required",
            "A registered model and its current placement are required",
        )
    })?;
    let model = store
        .query("SELECT * FROM models WHERE id=?1", [model_id])?
        .into_iter()
        .next()
        .ok_or_else(|| {
            ApiError::denied(
                "model_binding_required",
                "The registered model reference is unknown",
            )
        })?;
    if model["status"] != "registered" {
        return Err(ApiError::denied(
            "model_retired",
            "Only a registered model can bind a new invocation",
        ));
    }
    let field = |key: &str| -> Result<&str, ApiError> {
        let value = model[key].as_str().unwrap_or_default();
        if !value.is_empty()
            && value.len() <= 128
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | ':'))
        {
            Ok(value)
        } else {
            Err(ApiError::denied(
                "model_binding_scope",
                "Model source identity must be bounded and present",
            ))
        }
    };
    let (node_id, installation_id, worker_id) = (
        field("node_id")?,
        field("installation_id")?,
        field("worker_id")?,
    );
    let project_id = field("project_id")?;
    let source_ticket_id = field("source_ticket_id")?;
    let source_artifact_id = field("source_artifact_id")?;
    let placement_sha256 = field("descriptor_sha256")?;
    let source_assignment_digest = field("assignment_digest")?;
    let project = field("project_id")?.to_owned();
    if request.project_id != project
        || invocation["project_id"] != project
        || invocation["node_id"] != node_id
        || invocation["installation_id"] != installation_id
        || invocation["worker_id"] != worker_id
        || request
            .node_id
            .as_deref()
            .is_some_and(|node| node != node_id)
        || request
            .worker_id
            .as_deref()
            .is_some_and(|worker| worker != worker_id)
    {
        return Err(ApiError::denied(
            "model_binding_scope",
            "Invocation must use the exact registered node, installation, Worker and project",
        ));
    }
    let approval = store.query(
        "SELECT * FROM model_placement_authorizations WHERE model_id=?1 AND project_id=?2 AND node_id=?3 AND installation_id=?4 AND worker_id=?5 AND reviewed_model_digest=?6",
        params![model_id, project_id, node_id, installation_id, worker_id, placement_sha256],
    )?.into_iter().next().ok_or_else(|| ApiError::denied("current_placement_approval", "No current approval matches this immutable registered model"))?;
    let placement_grant = store
        .get("grants", approval["grant_id"].as_str().unwrap_or_default())?
        .ok_or_else(|| {
            ApiError::denied(
                "current_placement_approval",
                "Placement Grant no longer exists",
            )
        })?;
    let place_grant_id = placement_grant["id"].as_str().unwrap_or_default();
    if approval["grant_digest"] != placement_grant["digest"]
        || approval["binding_id"] != placement_grant["project_binding_id"]
        || placement_grant["revoked_at"] != Value::Null
        || placement_grant["project_id"] != project_id
        || placement_grant["node_id"] != node_id
        || placement_grant["installation_id"] != installation_id
        || placement_grant["worker_id"] != worker_id
        || place_grant_id == invocation["id"].as_str().unwrap_or_default()
        || !placement_grant["operations"]
            .as_array()
            .is_some_and(|ops| ops.contains(&json!("place_model")))
        || approval["accepted_state"] != "approved_for_placement"
        || !invocation["revoked_at"].is_null()
        || !invocation["operations"]
            .as_array()
            .is_some_and(|ops| ops.len() == 1 && ops[0] == "invoke_text")
    {
        return Err(ApiError::denied("current_placement_approval", "A distinct current place_model Grant and matching root approval must accompany invoke_text authority"));
    }
    let placement = store.query(
        "SELECT id,model_id,node_id,location,status FROM model_placements WHERE id=?1 AND model_id=?2 AND grant_id=?3 AND binding_id=?4 AND node_id=?5 AND status='approved_for_placement'",
        params![placement_id, model_id, place_grant_id, approval["binding_id"].as_str().unwrap_or_default(), node_id],
    )?.into_iter().next().ok_or_else(|| ApiError::denied("current_placement", "A matching existing placement receipt is required"))?;
    if placement["location"] != "local_only" {
        return Err(ApiError::denied(
            "model_placement_scope",
            "Only the exact local placement receipt can bind this fixture",
        ));
    }
    Ok(json!({
        "schema":"loom.model-binding.v1",
        "model_id":model_id, "placement_id":placement_id, "placement_sha256":placement_sha256,
        "source_artifact_id":source_artifact_id, "source_ticket_id":source_ticket_id,
        "source_assignment_digest":source_assignment_digest,
        "placement_grant_id":place_grant_id, "placement_grant_digest":placement_grant["digest"],
        "node_id":node_id, "project_id":project_id, "worker_id":worker_id,
        "installation_id":installation_id
    }))
}
async fn cancel(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(ticket): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    crate::maintenance::cancel(&store, &ticket)?;
    store.audit(
        Some(&ticket),
        "client",
        "cancel.requested",
        &json!({"stop_intent":"persistent"}),
    )?;
    Ok(Json(
        json!({"ticket_id":ticket,"status":store.get("tickets",&ticket)?.unwrap()["status"],"stop_intent":"persistent","outcome_if_effect_started":"reconciliation_required"}),
    ))
}
async fn retry(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(ticket): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    crate::maintenance::retry(&store, &ticket)?;
    Ok(Json(store.detail(&ticket)?))
}
async fn approval(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(ticket): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let decision = body["decision"]
        .as_str()
        .ok_or_else(|| ApiError::bad("decision needed"))?;
    if !matches!(decision, "approve" | "reject") {
        return Err(ApiError::bad("approve/reject"));
    };
    let approval_id = required(&body, "approval_id", 160)?;
    let reason = required(&body, "reason", 1000)?.trim();
    let store = state.lock()?;
    let t = store
        .get("tickets", &ticket)?
        .ok_or_else(|| ApiError::missing("ticket not found"))?;
    if t["status"] != "waiting_approval" {
        return Err(ApiError::conflict(
            "approval_not_pending",
            "Task is not awaiting approval",
        ));
    }
    let context = crate::maintenance::ApprovalContext {
        approval_id,
        reason,
    };
    match decision {
        "approve" => crate::maintenance::approve_ticket(&store, &ticket, context)?,
        "reject" => crate::maintenance::reject_ticket(&store, &ticket, context)?,
        _ => unreachable!("decision was validated above"),
    }
    Ok(Json(store.detail(&ticket)?))
}
#[derive(Deserialize)]
struct PreferenceQuery {
    ticket_id: Option<String>,
}
async fn preference(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Query(query): axum::extract::Query<PreferenceQuery>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let Some(ticket) = query.ticket_id else {
        return Ok(Json(json!({
            "scope":"global",
            "ticket_id":null,
            "has_override":false,
            "expanded":store.setting("global_expanded")==Some("true".into()),
            "sender_filter":null,
        })));
    };
    if ticket.trim().is_empty() || ticket.len() > 160 || ticket.chars().any(|c| c.is_control()) {
        return Err(ApiError::bad(
            "A bounded exact Ticket ID is required for preference filtering",
        ));
    }
    if let Some(mut reply) = store
        .query("SELECT * FROM preferences WHERE ticket_id=?1", [&ticket])?
        .into_iter()
        .next()
    {
        reply["scope"] = json!("ticket");
        reply["has_override"] = json!(true);
        return Ok(Json(reply));
    }
    Ok(Json(json!({
        "scope":"ticket",
        "ticket_id":ticket,
        "has_override":false,
        "expanded":store.setting("global_expanded")==Some("true".into()),
        "sender_filter":null,
    })))
}
fn parse_sender_filter(body: &Value) -> ApiResult<Option<&str>> {
    let Some(value) = body.get("sender_filter") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let Some(value) = value.as_str() else {
        return Err(ApiError::bad(
            "sender_filter must be null or a bounded non-empty string",
        ));
    };
    if value.is_empty()
        || value.trim().is_empty()
        || value.len() > 160
        || value.chars().any(char::is_control)
    {
        return Err(ApiError::bad(
            "sender_filter must be null or a bounded non-empty string",
        ));
    }
    Ok(Some(value))
}

async fn update_preference(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Query(query): axum::extract::Query<PreferenceQuery>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let expanded = body["expanded"]
        .as_bool()
        .ok_or_else(|| ApiError::bad("expanded must be boolean"))?;
    let sender_filter = parse_sender_filter(&body)?;
    let store = state.lock()?;
    if query.ticket_id.is_none() && sender_filter.is_some() {
        return Err(ApiError::bad(
            "Sender filtering requires an exact Ticket scope; only global expansion is supported",
        ));
    }
    if let Some(ticket) = query.ticket_id {
        if store.get("tickets", &ticket)?.is_none() {
            return Err(ApiError::missing("ticket unknown"));
        };
        store.conn().execute("INSERT INTO preferences(ticket_id,expanded,sender_filter,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(ticket_id) DO UPDATE SET expanded=excluded.expanded,sender_filter=excluded.sender_filter,updated_at=excluded.updated_at",params![ticket,expanded as i64,sender_filter,now()])?;
    } else {
        store.set_setting("global_expanded", if expanded { "true" } else { "false" })?;
    }
    Ok(Json(
        json!({"changed_only_display":true,"expanded":expanded}),
    ))
}
async fn memories(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({"memories":state.lock()?.list("memories")?})))
}
async fn create_memory(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let content = required(&body, "content", 8000)?;
    let scope = body["scope"].as_str().unwrap_or("project");
    if !matches!(scope, "project" | "user" | "worker" | "host") {
        return Err(ApiError::bad("Memory scope"));
    }
    let project = body["project_id"].as_str();
    let id = id("memory");
    let store = state.lock()?;
    if scope == "project"
        && (project.is_none() || store.get("projects", project.unwrap())?.is_none())
    {
        return Err(ApiError::bad(
            "Project memory must have an explicit valid project",
        ));
    }
    // An explicit origin reference is a persisted relationship, not a freeform UI label.
    // A missing source remains valid for an independent user-saved preference;
    // validating provenance does not grant any execution authority over that Ticket.
    let source_ticket_id = match body.get("source_ticket_id") {
        None | Some(Value::Null) => None,
        Some(_) => Some(required(&body, "source_ticket_id", 160)?),
    };
    if let Some(source) = source_ticket_id {
        let ticket = store
            .get("tickets", source)?
            .ok_or_else(|| ApiError::missing("Source Ticket not found"))?;
        let source_project = ticket["project_id"].as_str();
        if (scope == "project" || project.is_some()) && source_project != project {
            return Err(ApiError::bad(
                "Memory source Ticket belongs to another project, not this Memory",
            ));
        }
    }
    store.conn().execute("INSERT INTO memories(id,project_id,content,scope,version,created_at,updated_at,source_ticket_id) VALUES(?1,?2,?3,?4,1,?5,?5,?6)",params![id,project,content,scope,now(),source_ticket_id])?;
    store.audit(
        source_ticket_id,
        "client",
        "memory.explicit_saved",
        &json!({"memory_id":id,"scope":scope}),
    )?;
    Ok(Json(
        json!({"id":id,"content":content,"scope":scope,"version":1,"grant_created":false}),
    ))
}
async fn edit_memory(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(memory): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let content = required(&body, "content", 8000)?;
    let scope = body["scope"].as_str();
    if scope.is_some_and(|value| !matches!(value, "project" | "user" | "worker" | "host")) {
        return Err(ApiError::bad("Memory scope must be explicit and supported"));
    }
    let project_id = body["project_id"].as_str();
    let store = state.lock()?;
    if scope == Some("project") || (scope.is_none() && project_id.is_some()) {
        let Some(project) = project_id else {
            return Err(ApiError::bad(
                "Explicit project memory needs a real project",
            ));
        };
        if store.get("projects", project)?.is_none() {
            return Err(ApiError::missing("Memory scope project not found"));
        }
    }
    store.conn().execute("BEGIN IMMEDIATE", [])?;
    let result = (|| -> ApiResult<Value> {
        let existing = store
            .get("memories", &memory)?
            .ok_or_else(|| ApiError::missing("Memory not found"))?;
        let scope_sql = scope.unwrap_or_else(|| existing["scope"].as_str().unwrap_or("project"));
        let project_sql = if scope == Some("project") || (scope.is_none() && project_id.is_some()) {
            project_id
        } else if scope.is_none() {
            existing["project_id"].as_str()
        } else {
            None
        };
        let previous_version = existing["version"]
            .as_i64()
            .filter(|version| *version > 0)
            .ok_or_else(|| {
                ApiError::conflict("invalid_memory_version", "Stored Memory version is invalid")
            })?;
        let content_changed = existing["content"].as_str() != Some(content);
        let project_changed = existing["project_id"].as_str() != project_sql;
        let source_ticket_id = existing["source_ticket_id"].as_str();
        let previous_scope = existing["scope"].clone();
        let updated_at = now();
        if store.conn().execute(
            "UPDATE memories SET content=?1,project_id=?2,scope=?3,version=version+1,updated_at=?4 WHERE id=?5",
            params![content, project_sql, scope_sql, updated_at, memory],
        )? != 1
        {
            return Err(ApiError::missing("Memory not found"));
        }
        let persisted = store
            .get("memories", &memory)?
            .ok_or_else(|| ApiError::missing("Memory not found"))?;
        if persisted["version"].as_i64() != Some(previous_version + 1)
            || persisted["content"].as_str() != Some(content)
            || persisted["scope"].as_str() != Some(scope_sql)
            || persisted["project_id"].as_str() != project_sql
            || persisted["updated_at"].as_str() != Some(updated_at.as_str())
            || persisted["source_ticket_id"].as_str() != source_ticket_id
        {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "memory_update_verification_failed",
                "Updated Memory did not match its committed audit evidence; changes were rolled back.",
            ));
        }
        store
            .audit(
                source_ticket_id,
                "client",
                "memory.explicit_updated",
                &json!({
                    "memory_id":memory,
                    "previous_scope":previous_scope,
                    "scope":scope_sql,
                    "previous_version":previous_version,
                    "version":previous_version+1,
                    "content_changed":content_changed,
                    "project_changed":project_changed,
                    "authority_changed":false,
                    "origin_preserved":true,
                    "client_reason":"explicit_memory_edit",
                }),
            )
            .map_err(|_| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "audit_write_failed",
                    "Memory audit could not be written; the Memory update was rolled back.",
                )
            })?;
        Ok(persisted)
    })();
    let persisted = match result {
        Ok(persisted) => persisted,
        Err(error) => {
            store.conn().execute("ROLLBACK", [])?;
            return Err(error);
        }
    };
    if let Err(error) = store.conn().execute("COMMIT", []) {
        store.conn().execute("ROLLBACK", [])?;
        return Err(error.into());
    }
    Ok(Json(json!({"updated":true,"memory":persisted})))
}
async fn delete_memory(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(memory): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    if let Some(withdrawn) = crate::maintenance::delete_linked_memory(&store, &memory)? {
        return Ok(Json(withdrawn));
    }
    store.conn().execute("BEGIN IMMEDIATE", [])?;
    let result = (|| -> ApiResult<()> {
        let existing = store
            .get("memories", &memory)?
            .ok_or_else(|| ApiError::missing("Memory not found"))?;
        if store
            .conn()
            .execute("DELETE FROM memories WHERE id=?1", [&memory])?
            != 1
        {
            return Err(ApiError::missing("Memory not found"));
        }
        store
            .audit(
                existing["source_ticket_id"].as_str(),
                "client",
                "memory.explicit_deleted",
                &json!({
                    "memory_id":memory,
                    "previous_scope":existing["scope"],
                    "authority_changed":false,
                    "candidate_withdrawal":false,
                }),
            )
            .map_err(|_| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "audit_write_failed",
                    "Memory audit could not be written; the Memory deletion was rolled back.",
                )
            })?;
        Ok(())
    })();
    if let Err(error) = result {
        store.conn().execute("ROLLBACK", [])?;
        return Err(error);
    }
    if let Err(error) = store.conn().execute("COMMIT", []) {
        store.conn().execute("ROLLBACK", [])?;
        return Err(error.into());
    }
    Ok(Json(
        json!({"deleted":true,"grants_changed":false,"authority_changed":false}),
    ))
}
async fn messages(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Query(query): axum::extract::Query<PreferenceQuery>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    if let Some(ticket) = query.ticket_id {
        if ticket.trim().is_empty() || ticket.len() > 160 || ticket.chars().any(|c| c.is_control())
        {
            return Err(ApiError::bad(
                "A bounded exact Ticket ID is required for message filtering",
            ));
        }
        return Ok(Json(json!({
            "messages": store.query("SELECT * FROM messages WHERE ticket_id=?1 ORDER BY created_at,id LIMIT 1000", [ticket])?,
        })));
    }
    Ok(Json(json!({
        "messages": store.query("SELECT * FROM messages WHERE ticket_id IS NULL ORDER BY created_at LIMIT 1000", [])?,
    })))
}
async fn message(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let content = required(&body, "content", 16000)?;
    let id = id("message");
    let store = state.lock()?;
    store.conn().execute("INSERT INTO messages(id,sender,kind,content,visibility,created_at) VALUES(?1,'user','conversation',?2,'private',?3)",params![id,content,now()])?;
    Ok(Json(
        json!({"id":id,"recorded":true,"permission_granted":false}),
    ))
}
async fn register_source(
    AppState(state): AppState<Arc<State>>,
    request: Result<
        Json<crate::source_events::RegisterSource>,
        axum::extract::rejection::JsonRejection,
    >,
) -> ApiResult<Json<Value>> {
    let request = request
        .map_err(|_| {
            ApiError::bad("Invalid source registration schema, unknown fields or value types")
        })?
        .0;
    let mut store = state.lock()?;
    Ok(Json(crate::source_events::register(&mut store, request)?))
}
async fn list_sources(
    AppState(state): AppState<Arc<State>>,
    query: Result<
        axum::extract::Query<crate::source_events::SourceListQuery>,
        axum::extract::rejection::QueryRejection,
    >,
) -> ApiResult<Json<Value>> {
    let query = query
        .map_err(|_| {
            ApiError::bad("Source listing cursor and page-size parameters must be valid and known")
        })?
        .0;
    let store = state.lock()?;
    Ok(Json(crate::source_events::list(&store, query)?))
}
async fn receive_source_event(
    AppState(state): AppState<Arc<State>>,
    request: Result<
        Json<crate::source_events::AppendEvent>,
        axum::extract::rejection::JsonRejection,
    >,
) -> ApiResult<Json<Value>> {
    let request = request
        .map_err(|_| {
            ApiError::bad(
                "Invalid Source event schema, duplicate keys, unknown fields or value types",
            )
        })?
        .0;
    let mut store = state.lock()?;
    Ok(Json(crate::source_events::ingest(&mut store, request)?))
}
async fn read_source_events(
    AppState(state): AppState<Arc<State>>,
    query: Result<
        axum::extract::Query<crate::source_events::PreviewQuery>,
        axum::extract::rejection::QueryRejection,
    >,
) -> ApiResult<Json<Value>> {
    let query = query
        .map_err(|_| {
            ApiError::bad("Source preview requires known cursor/filter fields with valid types")
        })?
        .0;
    let mut store = state.lock()?;
    let result = crate::source_events::preview(&mut store, query)?;
    Ok(Json(result))
}

async fn audit(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Query(query): axum::extract::Query<PreferenceQuery>,
) -> ApiResult<Json<Value>> {
    Ok(Json(
        json!({"audit":state.lock()?.audits(query.ticket_id.as_deref())?}),
    ))
}
async fn verify_audit(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    Ok(Json(
        json!({"valid":state.lock()?.verify_audit()?,"algorithm":"sha256_chain_v1"}),
    ))
}

async fn inventory(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let mut nodes = store.list("nodes")?;
    for node in &mut nodes {
        let identity = crate::inventory::InstallationIdentity {
            node_id: node["id"].as_str().unwrap_or_default().to_owned(),
            installation_id: node["installation_id"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        };
        node["inventory"] = serde_json::to_value(crate::inventory::trusted_node_view(
            &store,
            &identity,
            Some(node),
            chrono::Utc::now(),
        )?)
        .map_err(|_| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "inventory_encoding",
                "Cannot encode resource inventory",
            )
        })?;
    }
    Ok(Json(
        json!({"nodes":nodes,"projects":store.list("projects")?,"source":"last_recorded_probe","observed_at":now(),"note":"Online status is not inferred from cached capabilities."}),
    ))
}
#[allow(dead_code)]
async fn create_pipeline(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut store = state.lock()?;
    Ok(Json(crate::pipeline::create(&mut store, &body)?))
}
async fn list_pipelines(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(json!({"pipelines":crate::pipeline::list(&store)?})))
}
async fn pipeline_detail(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    uuid::Uuid::parse_str(&id).map_err(|_| ApiError::bad("Pipeline ID must be UUID"))?;
    let store = state.lock()?;
    Ok(Json(
        json!({"pipeline":crate::pipeline::detail(&store, &id)?}),
    ))
}
async fn run_pipeline(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    uuid::Uuid::parse_str(&id).map_err(|_| ApiError::bad("Pipeline ID must be UUID"))?;
    let mut store = state.lock()?;
    crate::pipeline::advance_all(&mut store)?;
    Ok(Json(
        json!({"pipeline":crate::pipeline::detail(&store, &id)?}),
    ))
}
async fn cancel_pipeline(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    uuid::Uuid::parse_str(&id).map_err(|_| ApiError::bad("Pipeline ID must be UUID"))?;
    let store = state.lock()?;
    crate::pipeline::cancel(&store, &id)?;
    Ok(Json(
        json!({"cancel_requested":true,"pipeline":crate::pipeline::detail(&store, &id)?}),
    ))
}
async fn model_list(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(crate::model_registry::list(&store)?))
}
async fn model_detail(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(
        json!({"model":crate::model_registry::one(&store,&id)?}),
    ))
}
async fn model_register(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut store = state.lock()?;
    Ok(Json(crate::model_registry::register(&mut store, &body)?))
}
async fn model_approve(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut store = state.lock()?;
    Ok(Json(crate::model_registry::approve(
        &mut store, &id, &body,
    )?))
}
async fn model_place(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut store = state.lock()?;
    Ok(Json(crate::model_registry::place(&mut store, &id, &body)?))
}
async fn model_retire(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut store = state.lock()?;
    Ok(Json(crate::model_registry::retire(&mut store, &id, &body)?))
}
#[allow(dead_code)]
async fn models(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let _ = state;
    Err(ApiError::new(
        StatusCode::NOT_IMPLEMENTED,
        "m3_not_available",
        "Generalized model lifecycle and provider activation remain unverified. Bounded descriptor registration and explicit place_model approvals are separate evidence workflows, not model invocation or downloaded model availability claims.",
    ))
}
async fn candidates(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    let rows = store.query("SELECT c.*,cm.memory_id AS derived_memory_id FROM candidates AS c LEFT JOIN candidate_memory_links AS cm ON cm.candidate_id=c.id ORDER BY c.created_at DESC", [])?;
    let replay_proof = crate::skill_replay::list(&store)?;
    Ok(Json(
        json!({"candidates":rows,"skill_replays":replay_proof["skill_replays"],"skills":replay_proof["skills"],
                "policy":"Observations are not permanent Memory or a Grant; Skill proof is bounded exact deterministic read_summary only, never standing execution authority."}
        ),
    ))
}
async fn create_candidate(
    AppState(state): AppState<Arc<State>>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(crate::maintenance::observation_candidate(
        &store, &body,
    )?))
}
async fn review_candidate(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(candidate): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(crate::maintenance::review_candidate(
        &store, &candidate, &body,
    )?))
}

async fn skill_replay_start(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(candidate): axum::extract::Path<String>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let mut store = state.lock()?;
    Ok(Json(crate::skill_replay::create_or_get(
        &mut store, &candidate, &body,
    )?))
}

async fn skill_replay(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(candidate): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(crate::skill_replay::present(&store, &candidate)?))
}

async fn create_install_plan(
    AppState(state): AppState<Arc<State>>,
    Json(input): Json<crate::install_plan::CreateInput>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(crate::install_plan::create(&store, input)?))
}
async fn install_plans(AppState(state): AppState<Arc<State>>) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(crate::install_plan::list(&store)?))
}
async fn install_plan_detail(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(crate::install_plan::detail(&store, &id)?))
}
async fn approve_install_plan(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(input): Json<crate::install_plan::ApproveInput>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(crate::install_plan::approve(&store, &id, input)?))
}
async fn rollback_install_plan(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(input): Json<crate::install_plan::RollbackInput>,
) -> ApiResult<Json<Value>> {
    let store = state.lock()?;
    Ok(Json(crate::install_plan::rollback_approve(
        &store, &id, input,
    )?))
}
async fn observe_install_plan(
    AppState(state): AppState<Arc<State>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(input): Json<crate::install_plan::ObserveInput>,
) -> ApiResult<Json<Value>> {
    if std::env::var("LOOM_INSTALL_SIMULATION").ok().as_deref() != Some("synthetic_inventory") {
        return Err(ApiError::new(StatusCode::NOT_IMPLEMENTED,"synthetic_install_observation_disabled","Only the explicitly enabled synthetic Inventory driver can report fixture observations; actual Host execution is unavailable."));
    }
    let store = state.lock()?;
    Ok(Json(crate::install_plan::observe(&store, &id, input)?))
}

fn hash_json(value: &Value) -> String {
    sha256(value.to_string())
}
