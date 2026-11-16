#!/usr/bin/env node
// One bare Rust process per scenario; no DSH host/profile/model/network targets.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { prepareProject, startRustConcierge, testingClientToken, testingRoot } from './fixtures/rust-server.mjs'

const repository = resolve(fileURLToPath(new URL('..', import.meta.url)))
const bareBinary = join(repository, 'target/debug/loom-node')
const once = (...args) => spawn(...args, { encoding: 'utf8', timeout: 5000 })
const auth = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })
async function admin(baseUrl, clientToken, route, method = 'GET', body = undefined) {
  const response = await fetch(`${baseUrl}/api/v1${route}`, { method, headers: auth(clientToken), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const responseBody = await response.json()
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status}: ${JSON.stringify(responseBody.error)}`)
  return responseBody
}

const token = testingClientToken()
const root = await testingRoot()
const center = await startRustConcierge({ root, env: { ...process.env, LOOM_CLIENT_TOKEN: token } })
const childProcesses = []
const checks = []
async function run(name, command, args) {
  const child = spawn(command, args, { cwd: join(root), stdio: ['ignore', 'pipe', 'pipe'] })
  childProcesses.push(child)
  const output = []
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output.push(String(chunk).replaceAll(token, '[redacted-token]')) })
  const result = await new Promise((resolve) => child.once('exit', (code) => resolve({ code, output: output.join('') })))
  childProcesses.splice(childProcesses.indexOf(child), 1)
  if (result.code !== 0) throw new Error(`${name} exit ${result.code}: ${result.output}`)
  return result
}

try {
  const project = await prepareProject(root)
  const projectResponse = await admin(center.baseUrl, token, '/projects', 'POST', { name: 'Rust bare fixture', root: project, mode: 'read_write' })
  const projectId = projectResponse.project.id
  const state = join(root, 'state'), artifacts = join(root, 'artifacts')
  await run('binding', bareBinary, ['bind', '--state-dir', state, '--project-root', `${projectId}=${project}`])
  const enrollment = await admin(center.baseUrl, token, '/enrollment-codes', 'POST', {})
  const registration = await run('register-and-once', bareBinary, [
    'start', '--coordinator', center.baseUrl, '--state-dir', state, '--artifact-dir', artifacts,
    '--project-root', `${projectId}=${project}`, '--once', '--enrollment-code', enrollment.code,
  ])
  const identity = JSON.parse(registration.output.trim().split('\n')[0])
  checks.push({ name: 'signed binding and identity registration', value: identity })
  const nodes = await admin(center.baseUrl, token, '/nodes')
  const node = nodes.nodes.find((item) => item.id === identity.node_id)
  assert.ok(node, 'registered node is visible with its persistent key identity')
  assert.equal(node.workers[0].worker_id, 'default')
  assert.ok(node.inventory.project_roots[projectId])
  await admin(center.baseUrl, token, '/project-bindings', 'POST', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', root_scope: project })
  await admin(center.baseUrl, token, '/grants', 'POST', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', operations: ['read', 'write'] })
  const ticket = await admin(center.baseUrl, token, '/tickets', 'POST', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', kind: 'read_summary', relative_path: 'input.txt', objective: 'Rust bare actual read' })
  await run('actual-bare-task', bareBinary, ['start', '--coordinator', center.baseUrl, '--state-dir', state, '--artifact-dir', artifacts, '--project-root', `${projectId}=${project}`, '--once'])
  const detail = await admin(center.baseUrl, token, `/tickets/${ticket.id}`)
  assert.equal(detail.status, 'succeeded', JSON.stringify(detail))
  assert.equal(detail.artifacts.length, 1)
  const artifact = await admin(center.baseUrl, token, `/tickets/${ticket.id}/artifacts/${detail.artifacts[0].id}`)
  const summary = JSON.parse(artifact.content)
  assert.equal(summary.lines[0], 'Real isolated project input.')
  checks.push({ name: 'actual read_summary from real file', artifact: { sha256: detail.artifacts[0].sha256, lines: summary.lines } })
  const edit = await admin(center.baseUrl, token, '/tickets', 'POST', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', kind: 'edit_file', relative_path: 'nested/result.txt', content: 'Native actual effect\n', objective: 'Rust bare actual edit' })
  await run('actual-bare-edit', bareBinary, ['start', '--coordinator', center.baseUrl, '--state-dir', state, '--artifact-dir', artifacts, '--project-root', `${projectId}=${project}`, '--once'])
  assert.equal(await readFile(join(project, 'nested/result.txt'), 'utf8'), 'Native actual effect\n')
  const edited = await admin(center.baseUrl, token, `/tickets/${edit.id}`)
  assert.equal(edited.status, 'succeeded')
  checks.push({ name: 'actual authorized atomic file effect', state: edited.status, effects: edited.effects })
  const cancel = await admin(center.baseUrl, token, '/tickets', 'POST', { project_id: projectId, node_id: identity.node_id, worker_id: 'default', kind: 'edit_file', relative_path: 'should-not-exist.txt', content: 'forbidden', objective: 'Persisted cancellation before execution' })
  await admin(center.baseUrl, token, `/tickets/${cancel.id}/cancel`, 'POST', {})
  await run('cancelled-preexecution', bareBinary, ['start', '--coordinator', center.baseUrl, '--state-dir', state, '--artifact-dir', artifacts, '--project-root', `${projectId}=${project}`, '--once'])
  const cancelled = await admin(center.baseUrl, token, `/tickets/${cancel.id}`)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.reports.at(-1).state, 'cancelled')
  await writeFile(join(state, 'node-state.json'), (await readFile(join(state, 'node-state.json'), 'utf8')).replaceAll('__no_such_key__', 'preserved'), { mode: 0o600 })
  await run('restart-preserving-completions', bareBinary, ['start', '--coordinator', center.baseUrl, '--state-dir', state, '--artifact-dir', artifacts, '--project-root', `${projectId}=${project}`, '--once'])
  checks.push({ name: 'persisted cancellation and restart do not reexecute completed work', state: cancelled.status })
  console.log(JSON.stringify({ overall: 'PASS', schema: 'loom.native.bare.integration.v1', checks, limitations: ['No DSH Host, remote machine, real LLM, system credential store or platform installer was invoked.'] }, null, 2))
} finally {
  for (const child of childProcesses) child.kill('SIGTERM')
  await center.stop()
}
