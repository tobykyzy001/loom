// Bounded public evidence for one explicitly captured fixture ToolCall/ToolResult.
// Original source bytes, caller arguments, tool rendering and messages never enter
// this public artifact. DshAdapter owns Session event capture; this helper only
// validates supplied records and independently rereads the fixed source.
import { createHash } from 'node:crypto'
import { open, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { stableArtifactId } from './ids.js'

const SOURCE = 'input.txt'
const MAX_SOURCE = 4096
const HEX = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UNKNOWN = 'unverified_read_evidence'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const object = value => value && typeof value === 'object' && !Array.isArray(value)
function exactKeys(value, keys) { return object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) }
function boundedId(value, expression = ID) { return typeof value === 'string' && expression.test(value) }
function session(value) {
  return exactKeys(value, ['harness', 'session_id', 'protocol', 'host_api', 'observed_seq'])
    && value.harness === 'dsh' && value.protocol === 'dsh-session-log'
    && boundedId(value.session_id, SESSION) && boundedId(value.host_api)
    && Number.isSafeInteger(value.observed_seq) && value.observed_seq >= 0
}
function publicResult(value) {
  return exactKeys(value, ['schema', 'path', 'sha256', 'size_bytes', 'read'])
    && value.schema === 'loom.fixture-read.v1' && value.path === SOURCE
    && HEX.test(value.sha256) && Number.isSafeInteger(value.size_bytes)
    && value.size_bytes >= 1 && value.size_bytes <= MAX_SOURCE && value.read === true
}

/** Identify the fixed reader without inspecting or authorizing objective text. */
export function fixtureReadAssignment(assignment) {
  if (assignment?.kind !== 'read_summary' || assignment.relative_path !== SOURCE
    || !boundedId(assignment.id) || !boundedId(assignment.node_id)) return null
  if (assignment.objective !== undefined
    && (typeof assignment.objective !== 'string' || !/LOOM_FIXTURE_READ\b/.test(assignment.objective))) return null
  return Object.freeze({ assignment_id: assignment.id, relative_path: SOURCE })
}

/**
 * Adapter integration supplies only tracked events; no messages are read here.
 * Preferred shape: read_calls: Map(id,{name,args,seq}),
 * read_records: [{call,call_id,result_id,result_seq,is_error,result,session,invalid?}].
 * DshAdapter may instead pass one {read_call,read_result} pair from its capture.
 * NULL is not proof; actual capture/source inconsistency yields a stable unknown.
 */
export async function boundedReadArtifact(assignment, projectRoot, trackedRecord) {
  let unknown = false
  try {
    if (!fixtureReadAssignment(assignment)) return null
    const record = trackedRecord
    const calls = record?.read_calls instanceof Map ? [...record.read_calls.values()]
      : record?.read_tool_calls instanceof Map ? [...record.read_tool_calls.values()] : []
    const results = Array.isArray(record?.read_records) ? record.read_records
      : Array.isArray(record?.read_tool_records) ? record.read_tool_records : []
    if (record?.read_call && record?.read_result) {
      calls.push(record.read_call)
      results.push(record.read_result)
    }
    if (!calls.length && !results.length) return null
    if (calls.length !== 1 || results.length !== 1 || record?.read_invalid === true) unknown = true
    const entry = results[0]
    const call = entry?.call || calls[0]
    if (!unknown) {
      if (!exactKeys(call, ['name', 'args', 'seq']) || call.name !== 'loom_fixture_inspect'
        || !exactKeys(call.args, ['mode', 'relative_path']) || call.args.mode !== 'read' || call.args.relative_path !== SOURCE
        || !Number.isSafeInteger(call.seq) || call.seq < 0
        || !boundedId(entry.call_id) || !boundedId(entry.result_id)
        || !Number.isSafeInteger(entry.result_seq) || entry.result_seq <= call.seq
        || entry.is_error !== false || !publicResult(entry.result) || !session(entry.session)
        || (entry.result_seq > entry.session.observed_seq)) unknown = true
      // SDK message.toolCallId (or capture.parse toolCallId) is call identity;
      // result_id is a distinct, never-authoritative message identifier.
    }
    const rootInput = typeof projectRoot === 'string' && isAbsolute(projectRoot) ? projectRoot : ''
    if (!rootInput) unknown = true
    const root = rootInput ? await realpath(resolve(rootInput)) : ''
    const expected = root ? join(root, SOURCE) : ''
    // No parent/absolute/symlink traversal: the actual target must remain this
    // one direct child of the already-exact ProjectBinding root.
    const actual = expected ? await realpath(expected) : ''
    if (!root || actual !== expected) unknown = true
    let source
    let bytes
    try {
      // realpath above is the canonical root and not a symlink; the reopened
      // verification descriptor is constrained to that exactly-named child.
      source = expected ? await open(expected, 'r') : null
      const stat = await source?.stat()
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_SOURCE) unknown = true
      bytes = source ? await source.readFile() : Buffer.alloc(0)
      if (bytes.length !== stat?.size) unknown = true
    } finally {
      await source?.close().catch(() => {})
    }
    const sha256 = hash(bytes)
    if (!unknown && (entry.result.path !== SOURCE || entry.result.sha256 !== sha256 || entry.result.size_bytes !== bytes.length)) unknown = true
    if (unknown) return failure(trackedRecord)
    const sourceBytes = { schema: 'loom.read-source.v1', path: SOURCE, bytes: sha256, size_bytes: bytes.length }
    const proof = {
      schema: 'loom.read-proof.v1', name: call.name,
      call_id: entry.call_id, call_seq: call.seq, result_id: entry.result_id, result_seq: entry.result_seq,
      session: { session_id: entry.session.session_id, protocol: entry.session.protocol },
    }
    const publicBytes = Buffer.from(JSON.stringify({ schema: 'loom.read-evidence.v1', source: sourceBytes,
      read_observed: true, raw_artifact_published: false, proof }, null, 2) + '\n')
    const artifactId = stableArtifactId(`${assignment.id}:read-evidence:${entry.call_id}:${sha256}`)
    const evidence = { schema: 'loom.read-evidence.v1', type: 'dsh-tool-result', name: call.name,
      call_id: entry.call_id, call_seq: call.seq, result_id: entry.result_id, result_seq: entry.result_seq,
      path: SOURCE,
      sha256,
      size_bytes: bytes.length,
      read_observed: true,
      raw_artifact_published: false,
      session: {
        harness: entry.session.harness,
        session_id: entry.session.session_id,
        protocol: entry.session.protocol,
        host_api: entry.session.host_api,
        observed_seq: entry.session.observed_seq,
      } }
    const metadata = { artifact_id: artifactId, name: `read-evidence-${assignment.id}.json`, media_type: 'application/json',
      origin_node_id: assignment.node_id, size_bytes: publicBytes.length, sha256: hash(publicBytes), parents: [], evidence: [evidence] }
    return { state: 'succeeded', artifact: { artifact_id: artifactId, bytes: publicBytes, metadata },
      metadata, session_ref: { ...entry.session },
      summary: 'Verified the actual fixture source bytes and one bounded real tool read; only public hashes and metadata are published.',
      summary_classification: 'public', effects: [] }
  } catch {
    // Filesystem errors, malformed events and tampering never expose internals.
    return failure(trackedRecord)
  }
}

function failure(tracked) {
  return { state: 'unknown', summary: 'The bounded source read or its real tool evidence could not be independently verified; no public source content or successful proof is published.',
    summary_classification: 'public', effects: [], artifacts: [], reason_code: 'read_evidence_unverified',
    ...(session(tracked?.session_ref) ? { session_ref: tracked.session_ref } : {}) }
}
