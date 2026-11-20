import assert from 'node:assert/strict'
import { dirname } from 'node:path'
import { startRustConcierge, testingRoot, testingClientToken } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { LoomNodeClient } from '../../packages/node-client/src/client.js'
import { NodeIdentity } from '../../packages/node-client/src/identity.js'
import { verifyModelInventoryBrowser } from '../browser/model-inventory.mjs'

const root = await testingRoot()
console.log(`MODEL_INVENTORY_TEST_ROOT=${root}`)
const clientToken = testingClientToken()
let server, node, identity
try {
  server = await startRustConcierge({ root, env: { PATH: process.env.PATH, LOOM_CLIENT_TOKEN: clientToken } })
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 15000 })
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  identity = await NodeIdentity.open(dirname(server.dataDir))
  node = new LoomNodeClient({ http: admin, identity, state: {} })
  await node.enroll({ enrollmentCode: enrollment.code, capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }], harnessKind: 'dsh-loom', workerId: 'default' })
  const worker = { worker_id: 'default', harness_kind: 'dsh-loom', profile_id: 'isolated', status: 'online', capabilities: [] }
  const at = new Date().toISOString()
  const catalog = {
    schema: 'loom.model-inventory.v1', revision: 1, worker_id: 'default',
    lookup_source: 'ctx.llm.listProviders/listModels/resolveModelInfo/prepareCall',
    source: 'host_reported', observed_at: at,
    models: [{ provider: 'loom-stub', model: 'loom-stub-v1', source: 'host_reported', observed_at: at, resource_state: 'adapter_observed', prepared_call_observed: true, generation_observed: false, input_modalities: ['text'], context_window: 131072 }],
    findings: [{ state: 'prepared_call_ready', provider: 'loom-stub', model: 'loom-stub-v1', source: 'host_reported', observed_at: at }],
    policy: { install: false, download: false, activation: false, generation: false },
  }
  const workerCatalog = { ...catalog }
  const produce = async () => {
    await node.heartbeat({ capabilities: [], workers: [worker], inventory: { project_roots: {}, resources: [], model_catalog: workerCatalog } })
    return {
      catalog: workerCatalog,
      observation: await admin.get(`/api/v1/model-inventory?node_id=${identity.nodeId}&installation_id=${encodeURIComponent(identity.installationId)}&worker_id=default`),
    }
  }
  await verifyModelInventoryBrowser({
    server, admin, root,
    observer: {
      heartbeat: async () => produce(),
      offline_worker: async () => {
        await node.heartbeat({ status: 'online', capabilities: [], workers: [{ ...worker, status: 'offline' }],
          inventory: { project_roots: {}, resources: [], model_catalog: workerCatalog } })
        return admin.get(`/api/v1/model-inventory?node_id=${identity.nodeId}&installation_id=${encodeURIComponent(identity.installationId)}&worker_id=default`)
      },
      refresh: async () => admin.get('/api/v1/model-inventory'),
    },
  })
  const [tickets, grants] = await Promise.all([admin.get('/api/v1/tickets'), admin.get('/api/v1/grants')])
  assert.deepEqual(tickets.tickets, [])
  assert.deepEqual(grants.grants, [])
  console.log(JSON.stringify({ overall: 'PASS', browser_driver: 'tests/model-inventory/browser.mjs', no_generation: true, no_registration_or_grant: true }, null, 2))
} catch (error) {
  console.error(`MODEL_INVENTORY_DRIVER_FAIL ${String(error.stack || error).replaceAll(clientToken, '[redacted]')}`)
  process.exitCode = 1
} finally {
  if (server) await server.stop().catch(() => {})
}
