# Node envelope `loom.node.v1` fixtures

All JSON is UTF-8, pretty printed only for readability. Exchanges must preserve
exact byte/string values where signatures or digests are involved.

- `challenge.request.json`, `challenge.response.json`: public, non-authorizing
  signed-challenge round.
- `register.request.json`, `register.response.json`: initial enrollment. Tokens
  and enrollment codes are synthetic. `signed_challenge` is the unpadded
  base64url encoding of a raw 64-byte Ed25519 signature over the UTF-8 nonce.
- `heartbeat.request.json`: an authenticated, authorized node inventory update.
- `poll.request.json`, `assignment.response.json`: bounded outbound polling and
  issued Assignment/Lease (Grant is referenced by digest in M0).
- `report.request.json`, `report.response.json`: accepted structured report.
  `request_id` is idempotent but is not a substitute for assignment fencing.
- `unknown-report.request.json`: accepted uncertainty; it becomes `reconciling`.
- `protocol-unsupported.invalid.json`: must be rejected before body dispatch.
- `key-mismatch.invalid.json`: the `node_id` does not match SHA-256(public_key).

Timestamps are RFC3339 UTC; UUIDs are lowercase canonical strings. JSON objects
must not contain duplicate keys. Consumers should reject unknown protocol
versions and may preserve unknown optional fields. Authorization headers,
SQLite storage, signatures in these examples and external artifact delivery are
transport/storage responsibilities, not implicit grants.
