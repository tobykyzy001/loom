// Reused bounded source-byte proof for completed fixtures and a user-cancelled
// change-only edit. It never executes a verification tool or treats missing
// execution as a successful test; its read-only Git and file checks are shared.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { stableArtifactId } from './ids.js'

const execute = promisify(execFile)
const hash = value => createHash('sha256').update(value).digest('hex')
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

export async function sourceChangeProof(assignment, projectRoot, task, edit, failure) {
  const rootInput = projectRoot || assignment.grant?.project_root
  if (!rootInput) return failure('Code change requires the exact ProjectBinding root', 'unknown')
  const root = await realpath(resolve(rootInput))
  if (assignment.grant?.project_root && await realpath(resolve(assignment.grant.project_root)) !== root) {
    return failure('Current Code Evidence root differs from the exact ProjectBinding root', 'unknown')
  }
  const relative = task.relative_path
  const directory = await realpath(resolve(root, dirname(relative)))
  const expectedDirectory = await realpath(resolve(root, 'src'))
  if (directory !== expectedDirectory || !directory.startsWith((await realpath(root)) + sep)) {
    return failure('Actual edit is outside the selected source directory', 'unknown')
  }
  const stat = await lstat(resolve(directory, 'calc.js'))
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32768) {
    return failure('The changed target is not a bounded ordinary non-symlink file', 'unknown')
  }
  const actual = await readFile(resolve(directory, 'calc.js'))
  const content = Buffer.from(assignment.content, 'utf8')
  if (content.length > 32768 || !actual.equals(content) || !hex(hash(actual)) || hash(actual) !== edit.edit.sha256 || stat.size !== edit.edit.size_bytes) {
    return failure('Actual post-edit bytes or digest differ from the Ticket and observed source edit', 'unknown')
  }
  // The only Git operations here are real, bounded, read-only commands. Never use
  // reset/stash/checkout, arbitrary scripts or a model-provided commit status.
  const environment = { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
  const git = async (...args) => (await execute('/usr/bin/git', ['--no-pager', ...args], {
    cwd: root, env: environment, shell: false, windowsHide: true, timeout: 5000, maxBuffer: 96 * 1024,
  })).stdout
  const head = Buffer.from(await git('show', `HEAD:${relative}`), 'binary')
  const status = (await git('status', '--porcelain=v1', '--untracked-files=all', '--', '.')).trimEnd()
  if (status !== ` M ${relative}`) return failure('Only the exact one-file change is permitted in this fixture; observed unrelated or staged changes.', 'unknown')
  const staged = (await git('diff', '--cached', '--no-ext-diff', '--no-color', '--exit-code', '--', relative)).trim()
  if (staged) return failure('Source is already staged; no read-only change evidence may hide another approved change.', 'unknown')
  const patch = await git('-c', 'diff.external=', 'diff', '--no-ext-diff', '--no-color', '--unified=3', '--', relative)
  if (!patch.includes(`--- a/${relative}`) || !patch.includes(`+++ b/${relative}`)
    || !patch.includes('-  return a - b;') || !patch.includes('+  return a + b;')
    || Buffer.byteLength(patch) > 96 * 1024) return failure('Only a genuine one-source baseline-to-result unified diff is accepted.', 'unknown')
  const previous = hash(head)
  const expectedOld = hash("export function add(a, b) {\n  return a - b;\n}\n")
  if (previous !== edit.edit.previous_sha256 || previous !== expectedOld) {
    return failure('Observed baseline is not the committed source whose actual edit result was reported.', 'unknown')
  }
  if (previous === hash(actual)) return failure('The source task did not have a measurable original-to-new change', 'unknown')
  const changeRef = { type: 'dsh-tool-result', name: edit.call.name, call_id: edit.call_id,
    call_seq: edit.call.seq, result_id: edit.result_id, result_seq: edit.seq, session: edit.session,
    schema: 'loom.code-change.v1', path: relative, previous_sha256: previous,
    sha256: hash(actual), size_bytes: actual.length }
  const changeId = stableArtifactId(`${assignment.id}:code-change:${edit.call_id}:${previous}:${hash(actual)}`)
  return { changeRef, changeId, actual, patch, previous, root }
}

export function sourceArtifact(assignment, changeId, patch) {
  return { artifact_id: changeId, bytes: Buffer.from(patch), metadata: { artifact_id: changeId,
    name: `code-change-${assignment.id}.diff`, media_type: 'text/x-diff', origin_node_id: assignment.node_id,
    size_bytes: Buffer.byteLength(patch), sha256: hash(patch), parents: [], evidence: [] } }
}

export function sourceEffectId(assignment, edit, actual, previous) {
  return stableArtifactId(`${assignment.id}:code-effect:${edit.call_id}:${previous}:${hash(actual)}`)
}
