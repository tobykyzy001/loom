import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

function sourceProjection(scene) {
  if (!scene.bytes || scene.bytes.length > 4096 || scene.ref.sha256 !== createHash('sha256').update(scene.bytes).digest('hex')) {
    throw new Error('Delegation source was not independently verified below 4 KiB')
  }
  let summary
  try { summary = JSON.parse(scene.bytes.toString('utf8')) } catch { throw new Error('Expected an actual JSON source Artifact') }
  if (typeof summary.text !== 'string' || !summary.text.includes('ORBITAL-731')) throw new Error('The source does not contain the exact declared fixture observation')
  return { text: '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Verified delegated Agent</title></head><body><main><h1>Verified delegated Agent</h1><h2>Independent source below</h2><pre>ORBITAL-731\nActual source Artifact was independently hash-verified.</pre><p>Created by a separate child Agent through its public scoped tool.</p></main></body></html>\n', sha256: createHash('sha256').update(scene.bytes).digest('hex') }
}
export async function registerScopedDelegationTool(ctx, scene) {
  const checked = sourceProjection(scene)
  const root = await realpath(scene.root)
  const directory = await realpath(join(root, 'docs')).catch(async () => { await mkdir(join(root, 'docs'), { mode: 0o700 }); return realpath(join(root, 'docs')) })
  if (directory !== join(root, 'docs')) throw new Error('Delegation target must remain in the exact authorized docs/ directory')
  const registration = ctx.tools.register({
    name: 'loom_fixture_delegate_write',
    description: 'Create docs/delegated.html from an already verified source Artifact, not from provider claims.',
    parameters: { type: 'object', required: [], properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        required: ['created', 'path', 'title', 'source', 'source_session_id', 'sha256', 'size_bytes'],
        properties: {
          created: { type: 'boolean' }, path: { type: 'string' }, title: { type: 'string' },
          source: { type: 'object', required: ['type', 'artifact_id', 'ticket_id', 'origin_node_id', 'sha256', 'location', 'parents'], properties: {
            type: { type: 'string' }, artifact_id: { type: 'string' }, ticket_id: { type: 'string' },
            origin_node_id: { type: 'string' }, sha256: { type: 'string' }, location: { type: 'string' },
            parents: { type: 'array', items: {} },
          }, additionalProperties: false }, source_session_id: { type: 'string' },
          sha256: { type: 'string' }, size_bytes: { type: 'integer' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args, invocation) {
      if (invocation.signal?.aborted) throw new Error('Child Agent cancellation requested')
      const file = join(directory, 'delegated.html')
      const temporary = join(directory, `.loom-delegated-${randomUUID()}.tmp`)
      const data = { created: true, path: 'docs/delegated.html', title: 'Verified delegated Agent',
        source: scene.ref, source_session_id: scene.parent_session.session_id }
      const bytes = Buffer.from(checked.text, 'utf8')
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
        if ((await readFile(file)).equals(bytes)) throw new Error('Unexpected previous output requires reconciliation, not replacement')
      } catch (error) {
        if (error.code === 'ENOENT') await import('node:fs/promises').then(({ rename }) => rename(temporary, file))
        else { await rm(temporary, { force: true }); throw error }
      }
      if (invocation.signal?.aborted) throw new Error('Child Agent cancellation raced with the write; unknown evidence retained')
      return { ...data, sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length,
        source_session_id: scene.parent_session.session_id }
    },
  })
  return registration
}
