use crate::{executor::VerifiedArtifactInput, identity::Identity, wire::Assignment};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, io::Read, net::IpAddr, path::Path, time::Duration};
use uuid::Uuid;

pub const MAX_DIRECT_BYTES: u64 = 1_048_576;

fn bounded_string<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
        .with_context(|| format!("DirectOffer requires a bounded {key}"))
}

fn digest(value: &Value, key: &str) -> Result<String> {
    let text = bounded_string(value, key)?;
    if text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Ok(text.to_owned());
    }
    bail!("DirectOffer has an invalid {key}");
}

fn uuid(value: &Value, key: &str) -> Result<String> {
    let raw = bounded_string(value, key)?;
    let parsed = Uuid::parse_str(raw)?;
    if parsed.to_string() != raw {
        bail!("DirectOffer requires canonical UUID in {key}");
    }
    Ok(raw.to_owned())
}

fn unsigned(value: &Value, key: &str) -> Result<u64> {
    let number = value[key]
        .as_u64()
        .context("DirectOffer requires non-negative integer")?;
    if number == 0 || number > 9_007_199_254_740_991 {
        bail!("DirectOffer numeric field is not a positive JavaScript-safe integer");
    }
    Ok(number)
}

pub fn reference(value: &Value) -> Result<Value> {
    let object = value
        .as_object()
        .context("DirectOffer parent reference must be bounded JSON")?;
    if object.len() != 7
        || value["type"].as_str() != Some("artifact_ref")
        || value["parents"]
            .as_array()
            .is_some_and(|parents| !parents.is_empty())
    {
        bail!("DirectOffer only accepts the current bounded root ArtifactRef");
    }
    let artifact_id = uuid(value, "artifact_id")?;
    let origin = digest(value, "origin_node_id")?;
    let digest = digest(value, "sha256")?;
    let ticket = bounded_string(value, "ticket_id")?;
    if bounded_string(value, "location")? != format!("loom://artifact/{artifact_id}") {
        bail!("DirectOffer reference location does not identify the same immutable Artifact");
    }
    if value["parents"].as_array().is_none() {
        bail!("DirectOffer parent lineage must include an explicit bounded parents array");
    }
    let mut normalized = Map::new();
    for (key, value) in [
        ("type", "artifact_ref"),
        ("artifact_id", artifact_id.as_str()),
        ("ticket_id", ticket),
        ("sha256", digest.as_str()),
        ("origin_node_id", origin.as_str()),
        (
            "location",
            value["location"]
                .as_str()
                .context("Parent URI is missing")?,
        ),
    ] {
        normalized.insert(key.into(), json!(value));
    }
    normalized.insert("parents".into(), json!([]));
    Ok(Value::Object(normalized))
}

fn sort(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, sort(value)))
                .collect::<BTreeMap<_, _>>()
                .into_iter()
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(sort).collect()),
        value => value,
    }
}

/// This exact 28-field canonical statement must interoperate with the existing
/// TypeScript peer; do not add grant digests, public keys, or a transport URI.
pub fn challenge(offer: &Value) -> Result<Vec<u8>> {
    if bounded_string(offer, "schema")? != "loom.direct-offer.v1"
        || bounded_string(offer, "protocol")? != "loom.node.v1"
    {
        bail!("DirectOffer schema or protocol version is unsupported");
    }
    let parent = reference(&offer["artifact_ref"])?;
    if bounded_string(offer, "expires_at")?
        .parse::<DateTime<Utc>>()
        .is_err()
    {
        bail!("DirectOffer expiry must be RFC3339");
    }
    if unsigned(offer, "size_bytes")? > MAX_DIRECT_BYTES {
        bail!("DirectOffer content exceeds the one MiB payload limit");
    }
    let statement = json!({
        "schema": "loom.direct-offer.v1",
        "protocol": "loom.node.v1",
        "offer_id": bounded_string(offer, "offer_id")?,
        "nonce": digest(offer, "nonce")?,
        "artifact_ref": parent,
        "artifact_id": uuid(offer, "artifact_id")?,
        "artifact_sha256": digest(offer, "artifact_sha256")?,
        "source_ticket_id": bounded_string(offer, "source_ticket_id")?,
        "origin_node_id": digest(offer, "origin_node_id")?,
        "source_installation_id": bounded_string(offer, "source_installation_id")?,
        "source_worker_id": bounded_string(offer, "source_worker_id")?,
        "recipient_node_id": digest(offer, "recipient_node_id")?,
        "recipient_installation_id": bounded_string(offer, "recipient_installation_id")?,
        "recipient_worker_id": bounded_string(offer, "recipient_worker_id")?,
        "ticket_id": bounded_string(offer, "ticket_id")?,
        "assignment_id": bounded_string(offer, "assignment_id")?,
        "lease_id": bounded_string(offer, "lease_id")?,
        "lease_epoch": unsigned(offer, "lease_epoch")?,
        "expires_at": bounded_string(offer, "expires_at")?,
        "source_binding_id": bounded_string(offer, "source_binding_id")?,
        "destination_binding_id": bounded_string(offer, "destination_binding_id")?,
        "source_grant_id": bounded_string(offer, "source_grant_id")?,
        "destination_grant_id": bounded_string(offer, "destination_grant_id")?,
        "source_grant_version": unsigned(offer, "source_grant_version")?,
        "destination_grant_version": unsigned(offer, "destination_grant_version")?,
        "size_bytes": unsigned(offer, "size_bytes")?,
        "media_type": bounded_string(offer, "media_type")?,
        "byte_limit": MAX_DIRECT_BYTES,
    });
    if statement["artifact_id"] != statement["artifact_ref"]["artifact_id"]
        || statement["artifact_sha256"] != statement["artifact_ref"]["sha256"]
        || statement["origin_node_id"] == statement["recipient_node_id"]
    {
        bail!("DirectOffer must identify distinct recipient and a consistent immutable parent");
    }
    Ok(serde_json::to_vec(&sort(statement))?)
}

fn public_key_matches(value: &Value, key: &str, node_id: &str) -> Result<String> {
    let encoded = bounded_string(value, key)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .context("DirectOffer public key is not base64url")?;
    if decoded.len() != 32 || format!("{:x}", Sha256::digest(&decoded)) != node_id {
        bail!("DirectOffer public key does not match the registered origin or recipient");
    }
    Ok(encoded.to_owned())
}

fn validate_recipient(offer: &Value, assignment: &Assignment, identity: &Identity) -> Result<()> {
    for (key, expected) in [
        ("ticket_id", assignment.ticket_id.as_str()),
        ("assignment_id", assignment.id.as_str()),
        ("lease_id", assignment.lease_id.as_str()),
        ("recipient_node_id", identity.node_id.as_str()),
        (
            "recipient_installation_id",
            identity.installation_id.as_str(),
        ),
        ("recipient_worker_id", assignment.worker_id.as_str()),
        (
            "destination_binding_id",
            assignment.grant.binding_id.as_str(),
        ),
        ("destination_grant_id", assignment.grant.id.as_str()),
    ] {
        if bounded_string(offer, key)? != expected {
            bail!("DirectOffer scope does not match the active Assignment");
        }
    }
    if unsigned(offer, "lease_epoch")? != assignment.lease_epoch
        || unsigned(offer, "destination_grant_version")? != assignment.grant.version
        || bounded_string(offer, "destination_grant_digest")? != assignment.grant_digest
        || assignment.grant.revoked_at.is_some()
    {
        bail!("DirectOffer destination Grant or Lease is no longer current");
    }
    if bounded_string(offer, "media_type")? != "application/json"
        || bounded_string(offer, "transport")? != "loopback-explicit-configuration"
        || unsigned(offer, "byte_limit")? != MAX_DIRECT_BYTES
    {
        bail!("DirectOffer carries an unsupported transport/scope marker");
    }
    if bounded_string(offer, "expires_at")?.parse::<DateTime<Utc>>()? <= chrono::Utc::now()
        || bounded_string(offer, "expires_at")?.parse::<DateTime<Utc>>()?
            > assignment.lease_expires_at
    {
        bail!("DirectOffer is expired or extends beyond the current lease");
    }
    public_key_matches(
        offer,
        "source_public_key",
        bounded_string(offer, "origin_node_id")?,
    )?;
    if *public_key_matches(offer, "recipient_public_key", &identity.node_id)?
        != *identity.public_key()
    {
        bail!("DirectOffer recipient public key differs from this identity");
    }
    Ok(())
}

pub fn validate_endpoint(value: &str) -> Result<String> {
    if value.len() > 2048 {
        bail!("Direct peer URL is too long");
    }
    let mut url = reqwest::Url::parse(value).context("Direct peer must be an explicit URL")?;
    if url.scheme() != "http"
        || url.cannot_be_a_base()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        bail!("Direct peer must be a bare numeric HTTP loopback origin, not a resource URL");
    }
    match url
        .host_str()
        .unwrap_or_default()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
    {
        Ok(address)
            if address == std::net::Ipv4Addr::LOCALHOST
                || address == std::net::Ipv6Addr::LOCALHOST => {}
        _ => bail!("Direct peer must be the explicitly configured 127.0.0.1 or ::1 address"),
    }
    if url.port().is_none() {
        bail!("Direct peer must include its explicitly configured listening port");
    }
    url.set_path("/");
    Ok(url.origin().ascii_serialization())
}

pub fn load_peers(path: Option<&Path>) -> Result<BTreeMap<String, String>> {
    let mut peers = BTreeMap::new();
    if path.is_none() {
        return Ok(peers);
    }
    let mut file = std::fs::File::open(path.unwrap())
        .context("could not open explicitly configured Direct peer map")?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .context("could not read explicitly configured Direct peer map")?;
    let parsed = loom_protocol::node::from_json_strict(&bytes)
        .context("Direct peer map must have no duplicate JSON keys")?;
    let values: BTreeMap<String, String> = serde_json::from_value(parsed)
        .context("Direct peer map must be a bounded origin-to-loopback object")?;
    if bytes.len() > 64 * 1024 || values.len() > 32 {
        bail!("Direct peer map exceeds bounded operator configuration");
    }
    for (origin, endpoint) in &values {
        if origin.len() != 64
            || !origin
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            bail!("Direct peer origin is not a canonical registered Node identity");
        }
        peers.insert(origin.clone(), validate_endpoint(endpoint)?);
    }
    Ok(peers)
}

pub const DIRECT_INPUT_FIELDS: [&str; 4] =
    ["artifact_ref", "direct_offer", "offer_scope", "transform"];
pub const DIRECT_OFFER_FIELDS: [&str; 33] = [
    "artifact_id",
    "artifact_ref",
    "artifact_sha256",
    "assignment_id",
    "byte_limit",
    "destination_binding_id",
    "destination_grant_digest",
    "destination_grant_id",
    "destination_grant_version",
    "expires_at",
    "lease_epoch",
    "lease_id",
    "media_type",
    "nonce",
    "offer_id",
    "origin_node_id",
    "protocol",
    "recipient_installation_id",
    "recipient_node_id",
    "recipient_public_key",
    "recipient_worker_id",
    "schema",
    "size_bytes",
    "source_binding_id",
    "source_grant_digest",
    "source_grant_id",
    "source_grant_version",
    "source_installation_id",
    "source_public_key",
    "source_ticket_id",
    "source_worker_id",
    "ticket_id",
    "transport",
];

pub fn exact_fields(value: &Value, allowed: &[&str], label: &str) -> Result<()> {
    let object = value
        .as_object()
        .with_context(|| format!("{label} must be an object"))?;
    if object.len() != allowed.len()
        || object.keys().any(|key| !allowed.contains(&key.as_str()))
        || allowed.iter().any(|key| !object.contains_key(*key))
    {
        bail!("{label} has missing, extra or changed wire fields");
    }
    Ok(())
}

pub async fn resolve(
    client: &crate::client::NodeClient,
    identity: &Identity,
    assignment: &Assignment,
    peers: &BTreeMap<String, String>,
) -> Result<VerifiedArtifactInput> {
    if assignment.kind != "edit_file"
        || assignment.content.is_some()
        || assignment.grant.revoked_at.is_some()
        || !assignment
            .grant
            .operations
            .iter()
            .any(|operation| operation == "write")
    {
        bail!("Direct input requires a current write-authorized edit_file Assignment");
    }
    exact_fields(
        &assignment.raw["artifact_input"],
        &DIRECT_INPUT_FIELDS,
        "direct Assignment input",
    )?;
    let input = assignment.raw["artifact_input"]
        .as_object()
        .context("direct input metadata must be an object")?;
    if input["direct_offer"] != json!(true)
        || input["transform"].as_str() != Some("trim")
        || input["offer_scope"].as_str() != Some("recipient_current_lease_only")
        || input.get("bytes_base64").is_some()
    {
        bail!("Only the fixed DirectOffer trim protocol is accepted");
    }
    let expected = reference(&input["artifact_ref"])?;
    let offer_buttons = client.issue_direct_offer(identity, assignment).await?;
    let offer = offer_buttons
        .get("direct_offer")
        .context("concierge returned no DirectOffer")?;
    exact_fields(offer, &DIRECT_OFFER_FIELDS, "concierge DirectOffer")?;
    if reference(&offer["artifact_ref"])? != expected {
        bail!("coordinator selected a different parent for this Assignment");
    }
    validate_recipient(offer, assignment, identity)?;
    let signed = challenge(offer)?;
    let signature = identity.sign_binding_declaration(&signed);
    let origin = bounded_string(offer, "origin_node_id")?;
    if bounded_string(offer, "source_ticket_id")?
        != expected["ticket_id"]
            .as_str()
            .context("source ticket missing")?
        || expected["sha256"] != offer["artifact_sha256"]
    {
        bail!("DirectOffer parent Ticket or SHA is incompatible with its assigned source");
    }
    let base = peers
        .get(origin)
        .map(String::as_str)
        .context("No explicitly configured source peer for this parent origin")?;
    let base = validate_endpoint(base)?;
    let path = format!(
        "{base}/api/v1/direct/artifacts/{}",
        expected["artifact_id"].as_str().context("UUID missing")?
    );
    let request = json!({
        "schema": "loom.direct-offer.v1", "offer_id": bounded_string(offer, "offer_id")?,
        "nonce": bounded_string(offer, "nonce")?,
        "artifact_id": offer["artifact_id"], "origin_node_id": offer["origin_node_id"],
        "source_ticket_id": offer["source_ticket_id"],
        "recipient_node_id": identity.node_id, "recipient_installation_id": identity.installation_id,
        "recipient_worker_id": assignment.worker_id, "ticket_id": assignment.ticket_id,
        "assignment_id": assignment.id, "lease_id": assignment.lease_id,
        "lease_epoch": assignment.lease_epoch, "signature": signature,
    });
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3))
        .build()?;
    let response = http
        .post(path)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&request)?)
        .send()
        .await
        .map_err(|_| {
            anyhow::anyhow!(
                "Direct peer failed; no alternate artifact or coordinator path will be borrowed"
            )
        })?;
    if response.status() != reqwest::StatusCode::OK {
        bail!("Direct peer rejected the one-off signed source request; outcome remains unknown");
    }
    let headers = response.headers();
    if headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        != Some("application/json")
        || headers
            .get("x-content-type-options")
            .and_then(|v| v.to_str().ok())
            != Some("nosniff")
        || headers.contains_key(reqwest::header::CONTENT_ENCODING)
        || headers.contains_key(reqwest::header::TRANSFER_ENCODING)
        || headers.contains_key("trailer")
        || headers
            .get_all(reqwest::header::CONTENT_LENGTH)
            .iter()
            .count()
            != 1
    {
        bail!("Direct peer response has insecure or unsupported headers");
    }
    let expected_size = unsigned(offer, "size_bytes")? as usize;
    let content_lengths = headers
        .get_all(reqwest::header::CONTENT_LENGTH)
        .iter()
        .map(|value| {
            value
                .to_str()
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .context("Direct peer Content-Length must be one canonical byte count")
        })
        .collect::<Result<Vec<_>>>()?;
    if content_lengths.len() != 1 || content_lengths[0] != expected_size as u64 {
        bail!("Direct peer has missing or conflicting content lengths");
    }
    if response.content_length() != Some(expected_size as u64) {
        bail!("Direct peer body length does not match the issued bytes");
    }
    let mut bytes = Vec::new();
    let mut response = response;
    while let Some(chunk) = response.chunk().await? {
        if bytes
            .len()
            .checked_add(chunk.len())
            .is_none_or(|len| len > expected_size)
        {
            bail!("Direct peer exceeds the immutable byte count");
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.len() != expected_size {
        bail!("Direct peer truncated the immutable source bytes");
    }
    VerifiedArtifactInput::new(assignment, &expected, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn endpoint_is_never_an_arbitrary_resource() {
        for bad in [
            "http://localhost:1234",
            "http://127.0.0.2:1234",
            "https://127.0.0.1:1234",
            "http://127.0.0.1:1234/other-api",
            "http://127.0.0.1:1234?q=token",
        ] {
            assert!(validate_endpoint(bad).is_err());
        }
        assert_eq!(
            validate_endpoint("http://127.0.0.1:33531").unwrap(),
            "http://127.0.0.1:33531"
        );
        assert!(validate_endpoint("http://[::1]:33531").is_ok());
    }
}
