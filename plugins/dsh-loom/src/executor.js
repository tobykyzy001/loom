import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { id, sha256, writeJsonAtomic } from './util.js'

export const MAX_FILE_BYTES = 1_048_576
export function safeProjectRoot(root) {
  if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Grant root must be an explicit absolute test directory')
  const resolved = resolve(root)
  if (resolved === '/' || resolved === resolve(process.env.HOME || '__none__')) throw new Error('Refusing a broad non-fixture Grant root')
  return resolved
}
export function safeRelative(path) {
  if (typeof path !== 'string' || !path.length || Buffer.byteLength(path) > 1000 || path.includes('\0') || path.includes('\\')) {
    throw new Error('Invalid relative UTF-8 filename')
  }
  if (path.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Filename traversal is not allowed')
  if (isAbsolute(path)) throw new Error('Filename must be relative')
  return path
}
/** Each directory component is checked; the final file and its existing parent must be non-symlinks. */
async function controlledParent(root, parts, create) {
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    let info
    try { info = await lstat(current) } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error
      await mkdir(current, { mode: 0o700 }); info = await lstat(current)
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Path component is not a controlled real directory')
  }
  return current
}
export class ControlledFileExecutor {
  constructor({ artifactDir, now = () => new Date() } = {}) {
    if (!isAbsolute(artifactDir || '')) throw new Error('artifactDir must be an explicitly isolated absolute directory')
    this.artifactDir = resolve(artifactDir); this.now = now
  }
  async execute(assignment, grant) {
    const realRoot = await realpath(grant.project_root || grant.root)
    const root = safeProjectRoot(realRoot)
    const path = safeRelative(assignment.relative_path)
    const kind = assignment.kind
    const inputDigest = sha256(JSON.stringify({ assignment_id: assignment.id, kind, path,
      ...(kind === 'read_summary' ? {} : { content: assignment.content }) }))
    const effectId = id()
    const artifactId = id()
    await mkdir(this.artifactDir, { recursive: true, mode: 0o700 })
    const evidence = { effect_id: effectId, input_digest: inputDigest, artifact_id: artifactId, target_sha256: null }
    // Put pending facts on durable disk BEFORE any file effect. This is crash-recovery evidence.
    await writeJsonAtomic(join(this.artifactDir, `${effectId}.effect.json`), { status: 'recorded', ...evidence })
    const parent = await controlledParent(realRoot, path.split('/'), kind === 'edit_file')
    const realParent = await realpath(parent)
    if (realParent !== root && !realParent.startsWith(root + sep)) throw new Error('Directory escapes Grant root')
    const target = join(realParent, path.split('/').at(-1))
    let finalState = 'unknown'
    try {
      if (kind === 'read_summary') {
        const info = await lstat(target)
        if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1 || info.size > MAX_FILE_BYTES) throw new Error('Only a small, ordinary project file can be read')
        const fd = await open(target, 'r')
        let bytes
        try { bytes = await fd.readFile() } finally { await fd.close() }
        const confirmedRoot = await realpath(root)
        if (confirmedRoot !== root) throw new Error('Grant root changed during execution')
        const summary = summarize(bytes.toString('utf8'), path)
        const content = Buffer.from(summary)
        return await this.finish({ effectId, artifactId, assignment, grant, content, mediaType: 'application/json',
          root, target, readOnly: true, evidence, finalState: 'confirmed' })
      }
      if (kind === 'edit_file') {
        if (typeof assignment.content !== 'string' || Buffer.byteLength(assignment.content) > MAX_FILE_BYTES) {
          throw new Error('edit_file content is missing or exceeds the size limit')
        }
        let existed = false, previous = null
        try {
          const info = await lstat(target)
          if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1 || info.size > MAX_FILE_BYTES) throw new Error('Refusing to replace an uncontrolled file')
          previous = await readFile(target)
          if (Buffer.byteLength(assignment.content) > MAX_FILE_BYTES) throw new Error('Content limit exceeded')
          existed = true
        } catch (error) { if (error.code !== 'ENOENT') throw error }
        const temporary = join(realParent, `.loom-${process.pid}-${id()}.tmp`)
        const content = Buffer.from(JSON.stringify({ path, kind, operation: 'replaced_project_file', target_hash: sha256(assignment.content) }))
        let moved = false
        try {
          await writeFile(temporary, assignment.content, { mode: 0o600, flag: 'wx' })
          await rename(temporary, target)
          moved = true
          evidence.target_sha256 = sha256(assignment.content)
          if ((await realpath(root)) !== root || (await realpath(parent)) !== realParent) throw new Error('Project scope changed during file effect')
        } finally {
          await writeJsonAtomic(join(this.artifactDir, `${effectId}.effect.json`), { ...evidence, status: moved ? 'unknown' : 'recorded',
            previous_present: existed, previous_sha256: previous ? sha256(previous) : null })
          await rm(temporary, { force: true }).catch(() => {})
        }
        return await this.finish({ effectId, artifactId, assignment, grant, content, mediaType: 'application/json',
          root, target, readOnly: false, evidence, finalState: 'confirmed' })
      }
      throw new Error('Unsupported operation')
    } catch (error) {
      const effect = { effect_id: effectId, status: finalState, evidence }
      error.effect = effect
      throw error
    }
  }
  async finish({ effectId, artifactId, assignment, grant, content, mediaType, readOnly, evidence, finalState }) {
    const location = join(this.artifactDir, `${artifactId}.bin`)
    await writeFile(location, content, { mode: 0o600, flag: 'wx' })
    const metadata = { name: `${assignment.kind}-${artifactId}.json`, media_type: mediaType, size_bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'), origin_node_id: assignment.node_id }
    const effect = { effect_id: effectId, status: finalStatus(readOnly), evidence }
    await writeJsonAtomic(join(this.artifactDir, `${effectId}.effect.json`), { ...evidence, status: 'confirmed', read_only: readOnly })
    return { state: 'succeeded', summary: `${assignment.kind} completed without calling a model.`,
      artifact: { artifact_id: artifactId, metadata, bytes: content }, effect }
  }
}
function finalStatus(readOnly) { return readOnly ? 'confirmed' : 'confirmed' }
function summarize(content, path) {
  return JSON.stringify({ schema: 'loom.synthetic_summary.v1', path, byte_length: Buffer.byteLength(content),
    line_count: content.length ? content.split('\n').length : 0,
    lines: content.split('\n').filter((line) => line.trim()).slice(0, 20).map((line) => line.slice(0, 200)) }, null, 2)
}
export async function reconcileEffect(record, { target, expectedSha256 }) {
  if (record.read_only || record.status === 'confirmed') return 'confirmed'
  try {
    const info = await lstat(target)
    if (!info.isFile() || info.isSymbolicLink()) return 'needs_person'
    return sha256(await readFile(target)) === expectedSha256 ? 'confirmed' : 'needs_person'
  } catch { return 'unknown' }
}
