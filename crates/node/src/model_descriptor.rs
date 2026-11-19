//! Bounded metadata-only `loom.model-descriptor.v1` reader.
//! It never discovers, downloads, activates or invokes a model.
use anyhow::{bail, Context, Result};
use serde::{
    de::{MapAccess, Visitor},
    Deserializer,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fmt;

pub const MAX_DESCRIPTOR_BYTES: usize = 8_192;
const REQUIRED: [&str; 5] = [
    "schema",
    "provider",
    "revision",
    "input_modalities",
    "local_only",
];

struct RootMembers;
impl<'de> Visitor<'de> for RootMembers {
    type Value = Map<String, Value>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON object without repeated field names")
    }

    fn visit_map<A>(self, mut access: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut output = Map::new();
        while let Some(key) = access.next_key::<String>()? {
            if output.contains_key(&key) {
                return Err(serde::de::Error::custom("duplicate descriptor member"));
            }
            output.insert(key, access.next_value()?);
        }
        Ok(output)
    }
}

/// The source Registry's canonical no-content assignment input, kept separate
/// from logical admission/replay digest and from the source-file/proof hashes.
pub fn assignment_input_digest(assignment_id: &str) -> Result<String> {
    let encoded = format!(
        "{{\"assignment_id\":{},\"kind\":\"model_descriptor\",\"path\":\"model.json\",\"content\":null}}",
        serde_json::to_string(assignment_id).context("assignment ID must be serializable")?
    );
    Ok(format!("{:x}", Sha256::digest(encoded.as_bytes())))
}

pub fn proof(bytes: &[u8]) -> Result<Vec<u8>> {
    if !(1..=MAX_DESCRIPTOR_BYTES).contains(&bytes.len()) {
        bail!("model.json must contain 1..8192 ordinary bytes");
    }
    let source = std::str::from_utf8(bytes).context("model descriptor must be valid UTF-8")?;
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    let descriptor = decoder
        .deserialize_any(RootMembers)
        .context("model descriptor must be one bounded JSON object without duplicate members")?;
    decoder
        .end()
        .context("model descriptor has trailing input")?;
    if descriptor.len() != REQUIRED.len()
        || !REQUIRED.iter().all(|key| descriptor.contains_key(*key))
    {
        bail!("model descriptor must contain its exact five root fields without unknown keys");
    }
    if descriptor.get("schema") != Some(&json!("loom.model-descriptor.v1"))
        || descriptor.get("provider") != Some(&json!("fixture-local-text"))
        || descriptor.get("revision") != Some(&json!("v1"))
        || descriptor.get("input_modalities") != Some(&json!(["text"]))
        || descriptor.get("local_only") != Some(&json!(true))
    {
        bail!("model descriptor does not exactly match the bounded local fixture schema");
    }
    let encoded = serde_json::to_vec(&json!({
        "schema":"loom.model-descriptor.v1",
        "provider":"fixture-local-text",
        "revision":"v1",
        "input_modalities":["text"],
        "local_only":true,
        "relative_path":"model.json",
        "source_kind":"explicit_local_artifact_descriptor",
        "source_sha256":format!("{:x}", Sha256::digest(bytes)),
        "source_document":source,
    }))
    .context("bounded descriptor proof cannot be encoded")?;
    if encoded.len() > MAX_DESCRIPTOR_BYTES {
        bail!("model descriptor proof exceeds the 8192-byte registry artifact budget");
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    fn legal() -> &'static [u8] {
        static SOURCE: OnceLock<Vec<u8>> = OnceLock::new();
        SOURCE.get_or_init(|| {
            let mut bytes = br#"{"schema":"loom.model-descriptor.v1","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":true}"#.to_vec();
            bytes.push(b'\n');
            bytes
        })
    }

    #[test]
    fn source_assignment_digest_matches_the_registry_canonical_bytes_not_the_lease_admission_digest(
    ) {
        let expected = format!(
            "{:x}",
            Sha256::digest(br#"{"assignment_id":"asg_descriptor","kind":"model_descriptor","path":"model.json","content":null}"#)
        );
        assert_eq!(assignment_input_digest("asg_descriptor").unwrap(), expected);
        assert_ne!(expected, format!("{:x}", Sha256::digest(legal())));
    }

    #[test]
    fn preserves_raw_source_and_separates_it_from_the_generated_proof_sha() {
        let bytes = proof(legal()).unwrap();
        let proof: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            proof["source_document"],
            std::str::from_utf8(legal()).unwrap()
        );
        assert_eq!(
            proof["source_document"].as_str().unwrap(),
            String::from_utf8(legal().to_vec()).unwrap()
        );
        assert_eq!(
            proof["source_sha256"],
            format!("{:x}", Sha256::digest(legal()))
        );
        assert_ne!(
            format!("{:x}", Sha256::digest(bytes.as_slice())),
            proof["source_sha256"]
        );
        assert_eq!(proof["relative_path"], "model.json");
        assert_eq!(proof["input_modalities"], json!(["text"]));
        assert_eq!(proof.as_object().unwrap().len(), 9);
        assert!(bytes.len() <= MAX_DESCRIPTOR_BYTES);
    }

    #[test]
    fn rejects_key_duplication_and_unknown_or_untrusted_metadata() {
        for source in [
            r#"{"schema":"loom.model-descriptor.v1","schema":"loom.model-descriptor.v1","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":true}"#,
            r#"{"schema":"loom.model-descriptor.v1","pro\u0076ider":"fixture-local-text","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":true}"#,
            r#"{"schema":"loom.model-descriptor.v1","provider":"other","revision":"v1","input_modalities":["text"],"local_only":true}"#,
            r#"{"schema":"loom.model-descriptor.v1","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":false}"#,
            r#"{"schema":"loom.model-descriptor.v1","provider":"fixture-local-text","revision":"v1","input_modalities":["text"],"local_only":true,"download":"https://example.invalid"}"#,
        ] {
            assert!(proof(source.as_bytes()).is_err());
        }
        assert!(proof(&[]).is_err());
        assert!(proof(&vec![b' '; MAX_DESCRIPTOR_BYTES + 1]).is_err());
        assert!(proof(&[0xff, 0xfe, 128]).is_err());
        for malformed in ["", "null", "[]", "{", "]"] {
            assert!(
                proof(malformed.as_bytes()).is_err(),
                "empty/root/malformed form must not pass: {malformed}"
            );
        }
        let mut second_document = legal().to_vec();
        second_document.extend_from_slice(b"{}");
        assert!(proof(&second_document).is_err());
        let source = std::str::from_utf8(legal()).unwrap().trim_end().to_owned();
        let padded = format!(
            "{source}{}",
            " ".repeat(MAX_DESCRIPTOR_BYTES - source.len())
        );
        assert_eq!(padded.len(), MAX_DESCRIPTOR_BYTES);
        assert!(
            proof(padded.as_bytes()).is_err(),
            "a valid padded source cannot overflow the registry's proof budget"
        );
    }
}
