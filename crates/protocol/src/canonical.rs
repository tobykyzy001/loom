//! Deterministic JSON object-key order for serialized, bounded evidence.
//! Arrays keep semantic order. Callers must bound the input and accept only
//! finite JSON numbers before calling this serializer; no arbitrary inputs.

use serde::Serialize;
use serde_json::Value;

pub fn json(value: &Value) -> Result<String, serde_json::Error> {
    serde_json::to_string(&Canonical(value))
}

struct Canonical<'a>(&'a Value);

impl Serialize for Canonical<'_> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self.0 {
            Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {
                self.0.serialize(serializer)
            }
            Value::Array(values) => {
                use serde::ser::SerializeSeq;
                let mut result = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    result.serialize_element(&Canonical(value))?;
                }
                result.end()
            }
            Value::Object(values) => {
                use serde::ser::SerializeMap;
                let mut result = serializer.serialize_map(Some(values.len()))?;
                let mut keys: Vec<_> = values.keys().collect();
                keys.sort_unstable();
                for key in keys {
                    result.serialize_entry(key, &Canonical(&values[key]))?;
                }
                result.end()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_keeps_array_order_but_sorts_object_keys() {
        let a = serde_json::json!({"b":[2,{"z":true,"a":null}],"a":"text"});
        let b = serde_json::json!({"a":"text","b":[2,{"a":null,"z":true}]});
        assert_eq!(json(&a).unwrap(), json(&b).unwrap());
        assert_eq!(
            json(&a).unwrap(),
            r#"{"a":"text","b":[2,{"a":null,"z":true}]}"#
        );
        assert_ne!(
            json(&a).unwrap(),
            json(&serde_json::json!({"a":"text","b":[{"a":null,"z":true},2]})).unwrap()
        );
    }
}
