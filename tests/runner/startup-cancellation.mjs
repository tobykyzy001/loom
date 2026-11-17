import assert from 'node:assert/strict'
import { createPublicKey, verify as verifySignature } from 'node:crypto'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalNodeRunner as MainRunner } from '../../packages/node-client/src/runner.js'
import { NodeIdentity as MainIdentity } from '../../packages/node-client/src/identity.js'
import { NodeState as MainState } from '../../packages/node-client/src/state.js'
import { LocalNodeRunner as PluginRunner } from '../../plugins/dsh-loom/src/runner.js'
import { NodeIdentity as PluginIdentity } from '../../plugins/dsh-loom/src/identity.js'
import { NodeState as PluginState } from '../../plugins/dsh-loom/src/state.js'
import { createClient, runLocalDshPlugin } from '../../plugins/dsh-loom/lib/coordinator.js'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'

const enrollmentCode = 'fixture-explicit-enrollment-code'
function transport() {
  const fixture = { calls: [], nonce: 0, token: 'fixture-node-credential' }
  const readers = new Map()
  const arrival = name => {
    if (!readers.has(name)) readers.set(name, Promise.withResolvers())
    return readers.get(name)
  }
  fixture.waitFor = async name => {
    await arrival(name).promise
    return fixture.calls.filter(call => call.name === name)
  }
  fixture.holdRegistration = false
  fixture.fetch = async (url, options) => {
    const name = new URL(url).pathname.split('/').at(-1)
    const body = JSON.parse(options.body || '{}')
    assert.ok(['challenge', 'register', 'heartbeat'].includes(name), `Unexpected startup request: ${name}`)
    const call = { name, authorization: options.headers.authorization === undefined ? 'none' : 'node-credential' }
    fixture.calls.push(call)
    assertionForCall(body, options, name, fixture)
    arrival(name).resolve()
    if (name === 'challenge') {
      fixture.nonce++
      const nonce = fixture.nonce.toString(16).padStart(64, '0')
      fixture.lastNonce = nonce
      return Response.json({ nonce })
    }
    if (name === 'register' && fixture.holdRegistration) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      })
    }
    if (name === 'register') return Response.json({ token: fixture.token })
    return Response.json({ accepted: true })
  }
  return fixture
}
function assertionForCall(body, options, name, fixture) {
  assert.equal(body.protocol, 'loom.node.v1')
  assert.equal(/^[a-f0-9]{64}$/.test(body.node_id), true)
  if (name === 'challenge') assert.equal(options.headers.authorization, undefined)
  if (name === 'register') {
    assert.equal(options.headers.authorization, undefined)
    assert.equal(body.enrollment_code, enrollmentCode)
    assert.equal(body.nonce, fixture.lastNonce)
    assert.equal(verifySignature(null, Buffer.from(body.nonce, 'utf8'),
      createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(body.public_key, 'base64url')]), format: 'der', type: 'spki' }),
      Buffer.from(body.signed_challenge, 'base64url')), true, 'Only a real Ed25519 response fixture may be admitted')
  }
  if (name === 'heartbeat') assert.equal(options.headers.authorization, `Bearer ${fixture.token}`)
}

async function prove(label, Runner, Identity, State) {
  assert.equal(await Identity.readEnrollment(join('/tmp', `loom-nonexistent-${process.pid}`, label)), false)
  const stageEvidence = {}
  for (const stage of ['readEnrollment', 'open', 'stateOpen']) {
    stageEvidence[stage] = await probeStage(stage, Runner, Identity, State)
  }
  const root = await mkdtemp(join(tmpdir(), `loom-startup-cancel-${label}-`))
  const stateDir = join(root, 'state')
  const artifactDir = join(root, 'artifacts')
  const early = new AbortController()
  const earlyReason = new Error('Cancel before creating any new Node identity')
  early.abort(earlyReason)
  let calls = 0
  await assert.rejects(() => Runner.create({ stateDir, artifactDir, baseUrl: 'http://fixture.invalid', enrollmentCode,
    fetch: async () => { calls++ }, signal: early.signal }), error => error === earlyReason)
  await assert.rejects(() => stat(join(stateDir, 'identity.json')), error => error?.code === 'ENOENT')
  assert.equal(calls, 0)
  const uninitialized = new Runner({ stateDir, artifactDir, baseUrl: 'http://fixture.invalid', fetch: async () => { calls++ } })
  await assert.rejects(() => uninitialized.start({}), /Persistent node token is missing/)
  await assert.rejects(() => stat(join(stateDir, 'identity.json')), error => error?.code === 'ENOENT')
  const brokenDir = join(root, 'broken-identity')
  await mkdir(brokenDir, { mode: 0o700 })
  const corrupt = JSON.stringify({ version: 0, node_id: 'invalid', public_key: '', private_key_pkcs8: '', token: null })
  await writeFile(join(brokenDir, 'identity.json'), corrupt, { mode: 0o600 })
  await assert.rejects(() => new Runner({ stateDir: brokenDir, artifactDir: join(root, 'broken-artifacts'),
    baseUrl: 'http://fixture.invalid', fetch: async () => { calls++ } }).start({}), /Persistent node identity is invalid/)
  assert.equal(await readFile(join(brokenDir, 'identity.json'), 'utf8'), corrupt)
  assert.equal(calls, 0)

  const pending = new AbortController()
  const pendingReason = new Error('Cancel an in-flight registration, without guessing its server outcome')
  const blocked = transport()
  blocked.holdRegistration = true
  const pendingRun = Runner.create({ stateDir, artifactDir, baseUrl: 'http://fixture.invalid', enrollmentCode, fetch: blocked.fetch, signal: pending.signal })
  await blocked.waitFor('register')
  pending.abort(pendingReason)
  await assert.rejects(() => pendingRun, error => error === pendingReason)
  assert.equal(blocked.calls.filter(call => call.name === 'register').length, 1)
  assert.equal(blocked.calls.some(call => call.name === 'heartbeat'), false)
  assert.equal((await Identity.open(stateDir)).token, '')

  const afterEnroll = new AbortController()
  const reason = new Error('Caller cancels exactly after committing a trusted registration token')
  const accepted = transport()
  const runner = new Runner({ stateDir, artifactDir, baseUrl: 'http://fixture.invalid', fetch: accepted.fetch })
  const originalSet = Identity.prototype.setToken
  let saveCommitted = false
  Identity.prototype.setToken = async function (response) {
    const result = await originalSet.call(this, response)
    saveCommitted = true
    afterEnroll.abort(reason)
    return result
  }
  try {
    await assert.rejects(() => runner.start({ enrollmentCode, signal: afterEnroll.signal }), error => error === reason)
  } finally { Identity.prototype.setToken = originalSet }
  assert.equal(saveCommitted, true)
  const reopened = await Identity.open(stateDir)
  assert.equal(reopened.token, accepted.token, 'An accepted and saved token is not falsely rolled back by cancellation')
  assert.equal(accepted.calls.filter(call => call.name === 'heartbeat').length, 0)

  const healthy = transport()
  healthy.token = accepted.token
  const recovered = new Runner({ stateDir, artifactDir, baseUrl: 'http://fixture.invalid', fetch: healthy.fetch })
  await recovered.start({})
  assert.equal(recovered.nodeId, reopened.nodeId)
  assert.equal(recovered.installationId, reopened.installationId)
  assert.deepEqual(healthy.calls.map(call => call.name), ['heartbeat'])
  const state = await State.open(stateDir)
  assert.deepEqual(state.data.assignments, {})
  assert.deepEqual(state.outbox, [])
  const persistedMode = (await stat(join(stateDir, 'identity.json'))).mode & 0o777
  assert.equal(persistedMode, 0o600)
  return { implementation: label, stage_cancellations_stop_further_stages: stageEvidence,
    pre_cancel_and_missing_enrollment_never_create_identity_key: true,
    pending_enrollment_has_no_token_or_heartbeat: true,
    committed_token_not_forgotten_or_revoked_by_cancel: true,
    restart_has_exactly_one_heartbeat_no_new_enrollment: true,
    no_assignment_or_acknowledgement_invented_by_cancel: true }
}

async function probeStage(stage, Runner, Identity, State) {
  const root = await mkdtemp(join(tmpdir(), `loom-startup-phase-${stage}-`))
  const stateDir = join(root, 'state')
  const stateSpec = { enrollmentCode, stateDir, artifactDir: join(root, 'artifacts'),
    baseUrl: 'http://fixture.invalid', fetch: async () => { throw new Error('No transport may start after a cancelled startup phase') } }
  const read = Identity.readEnrollment
  const open = Identity.open
  const openState = State.open
  const entered = Promise.withResolvers()
  const released = Promise.withResolvers()
  const caller = new AbortController()
  const reason = new Error(`Caller cancels during ${stage}`)
  let opened = false
  if (stage === 'readEnrollment') {
    const existing = await open(stateDir)
    await existing.setToken({ token: 'fixture-only-existing-node-credential' })
    delete stateSpec.enrollmentCode
    Identity.readEnrollment = async dir => {
      entered.resolve(); await released.promise
      return read(dir)
    }
  } else if (stage === 'open') {
    Identity.open = async dir => {
      entered.resolve(); await released.promise
      return open(dir)
    }
  } else {
    State.open = async dir => {
      entered.resolve(); await released.promise
      opened = true
      return openState(dir)
    }
  }
  try {
    const starting = Runner.create({ ...stateSpec, signal: caller.signal })
    await entered.promise
    caller.abort(reason)
    released.resolve()
    await assert.rejects(() => starting, error => error === reason)
    if (stage === 'stateOpen') assert.equal(opened, true)
  } finally {
    Identity.readEnrollment = read
    Identity.open = open
    State.open = openState
    released.resolve()
  }
  return { stage, subsequent_network_requests: 0, original_method_restored: true }
}

async function coordinatorCancellation(createClientFn) {
  const root = await mkdtemp(join(tmpdir(), 'loom-factory-startup-cancel-'))
  const wire = transport()
  wire.holdRegistration = true
  const controller = new AbortController()
  const reason = new Error('Cancel caller-owned Coordinator bootstrap')
  const pending = createClientFn({ base_url: 'http://fixture.invalid', state_dir: join(root, 'state'),
    artifact_dir: join(root, 'artifacts'), enrollment_code: enrollmentCode, fetch: wire.fetch, registration: {} }, { signal: controller.signal })
  await wire.waitFor('register')
  controller.abort(reason)
  await assert.rejects(() => pending, error => error === reason)
  assert.equal(wire.calls.some(call => call.name === 'heartbeat'), false)

  const stopping = new AbortController()
  const stopReason = new Error('Finished observed catalog, but do not launch the Coordinator after cancellation')
  let catalog
  let dispatcherCalls = 0
  let polling = false
  const release = Promise.withResolvers()
  const beginning = Promise.withResolvers()
  const handle = runLocalDshPlugin({ heartbeat_ms: 50, poll_seconds: 0 }, {
    createClient: async (_config, options) => {
      assert.equal(options.signal, stopping.signal)
      return { runner: { capabilities: [] },
        client: { heartbeat: async () => { polling = true }, poll: async () => { polling = true } }, capabilities: [] }
    },
    localDispatcher: () => {
      dispatcherCalls++
      return { capabilities: [], initializeModelCatalog: async () => {
        catalog = true
        beginning.resolve()
        await release.promise
      } }
    },
  }, { signal: stopping.signal })
  await beginning.promise
  assert.equal(catalog, true)
  stopping.abort(stopReason)
  // The waiting lifecycle must settle itself; the SDK-like pending observation need not finish to cancel startup.
  const settled = await Promise.race([
    assert.rejects(() => handle, error => error === stopReason).then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 1000)),
  ])
  assert.equal(settled, true, 'Cancellation must not hang waiting for possibly non-cancellable internal lookup')
  release.resolve()
  await assert.rejects(() => handle, error => error === stopReason)
  assert.equal(dispatcherCalls, 1)
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(polling, false, 'Cancellation after observation cannot start the next heartbeat/poll')

  const before = new AbortController()
  before.abort(new Error('No create after pre-aborted factory'))
  let factoryCalls = 0
  await assert.rejects(() => runLocalDshPlugin({}, { createClient: async () => { factoryCalls++ } }, { signal: before.signal }),
    error => error === before.signal.reason)
  assert.equal(factoryCalls, 0)
  return true
}

async function catalogDeadlineAndLateCancel() {
  const controller = new AbortController()
  const reason = new Error('Caller stop after observed catalog expiry, distinct from expiry itself')
  let expired = 0
  let polling = 0
  const start = Date.now()
  // The real library timer is deliberately unref'd. A timer-only synthetic observation
  // otherwise would not keep this test process alive; this sentinel is strictly test-owned.
  const sentinel = setInterval(() => {}, 100)
  let elapsed
  try {
    await assert.rejects(() => runLocalDshPlugin({ heartbeat_ms: 100 }, {
      createClient: async () => ({ runner: { capabilities: [] },
        client: { heartbeat: async () => { polling++ }, poll: async () => { polling++ } }, capabilities: [] }),
      localDispatcher: () => ({
        capabilities: [], initializeModelCatalog: () => new Promise(() => {}),
        modelCatalogLookupExpired: () => { expired++; controller.abort(reason) },
      }),
    }, { signal: controller.signal }), error => error === reason)
  } finally {
    clearInterval(sentinel)
    elapsed = Date.now() - start
  }
  assert.ok(elapsed >= 4000, `The actual 5-second lookup deadline must have fired, not an early generic failure: ${elapsed}ms`)
  assert.equal(expired, 1, 'The genuine deadline retains its unavailable/expired observation, even if caller cancellation follows')
  assert.equal(polling, 0)
  return { elapsed_ms: elapsed, actual_deadline_observation_recorded: true, late_cancel_stopped_coordinator: true }
}

async function realCentreRegression(Runner, Identity) {
  const root = await mkdtemp(join(tmpdir(), 'loom-startup-real-rust-'))
  await mkdir(join(root, 'server'), { mode: 0o700 })
  const server = await startRustConcierge({ root: join(root, 'server') })
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const stateDir = join(root, 'node-state')
  const stop = new AbortController()
  const reason = new Error('Stop after genuine center-issued node registration is durably saved')
  let runner, genuineToken
  const originalSet = Identity.prototype.setToken
  try {
    const project = await admin.post('/api/v1/projects', { name: 'Startup cancellation resume', root: root, mode: 'read_write' })
    const enrollment = await admin.post('/api/v1/enrollment-codes', {})
    runner = new Runner({ stateDir, artifactDir: join(root, 'artifacts'), baseUrl: server.baseUrl,
      projectRoots: { [project.project.id]: root } })
    Identity.prototype.setToken = async function (response) {
      const result = await originalSet.call(this, response)
      genuineToken = this.token
      stop.abort(reason)
      return result
    }
    try {
      await assert.rejects(() => runner.start({ enrollmentCode: enrollment.code, signal: stop.signal }), error => error === reason)
    } finally { Identity.prototype.setToken = originalSet }
    const identity = await Identity.open(stateDir)
    const afterCancel = await admin.get('/api/v1/nodes')
    const registered = afterCancel.nodes.filter(entry => entry.id === identity.nodeId)
    assert.equal(registered.length, 1, 'The real centre accepted one matching signed registration before local cancellation')
    assert.equal(identity.token, genuineToken)
    assert.equal(typeof genuineToken, 'string')
    assert.ok(genuineToken.length > 10)
    const resumed = new Runner({ stateDir, artifactDir: join(root, 'artifacts'), baseUrl: server.baseUrl })
    await resumed.start({})
    assert.equal(resumed.nodeId, identity.nodeId)
    assert.equal(resumed.installationId, identity.installationId)
    const online = (await admin.get('/api/v1/nodes')).nodes.filter(entry => entry.id === identity.nodeId)
    assert.equal(online.length, 1)
    assert.equal(online[0].status, 'online')
    return true
  } finally {
    Identity.prototype.setToken = originalSet
    await server.stop()
  }
}

const results = [
  await prove('main', MainRunner, MainIdentity, MainState),
  await prove('vendored', PluginRunner, PluginIdentity, PluginState),
]
const coordinatorProof = await coordinatorCancellation(createClient)
for (const [Runner, Identity] of [[MainRunner, MainIdentity], [PluginRunner, PluginIdentity]]) {
  const proof = await realCentreRegression(Runner, Identity)
  results.push({ real_rust_center: proof, runner: Runner === MainRunner ? 'main' : 'vendored', saved_node_credentials_survive_cancel_resume: proof })
}
console.log(JSON.stringify({ overall: 'PASS', schema: 'loom.startup-cancellation.v1', results, coordinator_factor_cancel: coordinatorProof,
    catalog_lifecycle: await catalogDeadlineAndLateCancel(),
    scope: 'Actual owned identity files, real registration/heartbeat API, owned Rust Concierge. No external provider/profile/credentials.',
  not_claimed: ['server registration rollback', 'all Cordis effect cancellation', 'underlying SDK callback cancellation', 'new grants', 'physical mobile recovery'] }, null, 2))
