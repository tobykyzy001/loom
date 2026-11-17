// Same real isolated DSH installation used by the other harness lifecycle tests.
// This helper only prepares owned directories; it does not emulate a Host/Agent.
import { join } from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'
import { fixtureRoot, isolatedEnv, installBundles, installation } from './environment.mjs'
import { FixtureHost } from './runtime.mjs'
import { startRustConcierge } from '../../scripts/fixtures/rust-server.mjs'
import { LoomHttpClient } from '../../packages/node-client/src/http.js'

export async function prepareScenario({ envPrefix = 'MODEL_BINDING', credentialRecords = false } = {}) {
  const root = await fixtureRoot(process.env[`LOOM_${envPrefix}_ROOT`])
  const { cli, executable } = installation()
  await writeFile(join(root, 'private', 'fixture-control.jsonl'), '', { mode: 0o600 })
  const server = await startRustConcierge({ root: join(root, 'rust') })
  const admin = new LoomHttpClient({ baseUrl: server.baseUrl, clientToken: server.clientToken })
  const projectRoot = join(root, 'project')
  const projectId = (await admin.post('/api/v1/projects', { name: 'Strict registry-bound adapter execution', root: projectRoot, mode: 'read_write' })).project.id
  const enrollment = await admin.post('/api/v1/enrollment-codes', {})
  const env = isolatedEnv(root, {
    LOOM_FIXTURE_COORDINATOR_URL: server.baseUrl,
    LOOM_FIXTURE_ENROLLMENT_CODE: enrollment.code,
    LOOM_FIXTURE_PROJECT_MAPPING: JSON.stringify({ [projectId]: projectRoot }),
    LOOM_FIXTURE_MODEL_TEXT_TASKS: 'true',
    LOOM_FIXTURE_MODEL_DESCRIPTOR_TASKS: 'true',
    LOOM_FIXTURE_CREDENTIAL_BROKER: credentialRecords ? 'dsh_records' : 'unsupported',
  })
  await installBundles({ env, root, cli, executable, bundles: [join(root, 'fixture-packages/stub-provider'), join(root, 'fixture-packages/dsh-loom'), ...(credentialRecords ? [join(root, 'fixture-packages/credential-record')] : [])] })
  return { root, server, admin, projectRoot, projectId, env, envHandle: env }
}

export async function startIsolatedHost(root, env, secrets) {
  const host = new FixtureHost(root, env, secrets)
  await host.start()
  return host
}
