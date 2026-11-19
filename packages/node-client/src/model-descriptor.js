import { createHash } from 'node:crypto'

const DESCRIPTOR_KEYS = ['schema', 'provider', 'revision', 'input_modalities', 'local_only']
/** Read only an explicitly named, bounded JSON metadata file; never discover/run a model. */
export function modelDescriptorProof(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 8192) throw new Error('model.json must contain 1..8192 ordinary bytes')
  const source = bytes.toString('utf8')
  if (source.includes('�')) throw new Error('Model descriptor must be valid UTF-8 JSON')
  let descriptor
  try { descriptor = JSON.parse(source) } catch { throw new Error('Model descriptor is not a bounded JSON object') }
  // This tiny schema has a flat root. Repeated root keys are invalid, not last-write-wins authorization.
  if (rawRootKeys(source).length !== DESCRIPTOR_KEYS.length) throw new Error('Model descriptor must have exactly five fields without duplicate keys')
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)
    || Object.keys(descriptor).length !== DESCRIPTOR_KEYS.length
    || !DESCRIPTOR_KEYS.every((key) => Object.hasOwn(descriptor, key))
    || descriptor.schema !== 'loom.model-descriptor.v1'
    || descriptor.provider !== 'fixture-local-text' || descriptor.revision !== 'v1'
    || !Array.isArray(descriptor.input_modalities) || descriptor.input_modalities.length !== 1 || descriptor.input_modalities[0] !== 'text'
    || descriptor.local_only !== true) throw new Error('Model descriptor must exactly match the local fixture schema')
  const result = Buffer.from(JSON.stringify({ schema: descriptor.schema, provider: descriptor.provider,
    revision: descriptor.revision, input_modalities: ['text'], local_only: true,
    source_kind: 'explicit_local_artifact_descriptor', relative_path: 'model.json', source_sha256: createHash('sha256').update(bytes).digest('hex'), source_document: source }))
  if (result.length > 8192) throw new Error('Model descriptor proof exceeds the 8192-byte registry artifact budget')
  return result
}
function rawRootKeys(source) {
  const members = /(?:^|[{,])\s*"([^"\\]+)"\s*:/g
  return [...source.matchAll(members)].map(([, key]) => key)
}
