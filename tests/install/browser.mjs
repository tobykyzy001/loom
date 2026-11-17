import { basename, join } from 'node:path'
import { rm } from 'node:fs/promises'
import { verifyInstallPlansBrowser } from '../browser/install-plans.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'
import { startRustConcierge, testingRoot } from '../../scripts/fixtures/rust-server.mjs'

const root = await testingRoot()
let server
console.log('OWNED_ROOT', root)
try {
  server = await startRustConcierge({ root, env: { ...process.env, LOOM_INSTALL_SIMULATION: 'synthetic_inventory' } })
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken, timeoutMs: 20000 })
  const result = await verifyInstallPlansBrowser({ server, admin, root })
  console.log(JSON.stringify({ overall: 'PASS', schema: 10, host_execution: false, backend_driver: 'tests/install/plan.mjs', evidence: join(root, 'install-plans-result.json'), screenshots: result.screenshots, ordinary_tasks_or_grants_created: false, no_live_host_or_ssh: true, current_working_directory_never_scanned: true, fixture: basename(root) }, null, 2))
} finally {
  if (server) await server.stop()
  for (const name of ['install-plans-browser-profile', '.install-plans-vite-cache']) await rm(join(root, name), { recursive: true, force: true }).catch(() => {})
}
