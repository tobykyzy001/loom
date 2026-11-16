import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { SyntheticCoordinator } from '../../../scripts/fixtures/coordinator.mjs'
import { LocalNodeRunner } from '../src/runner.js'
import { LocalFileDispatcher } from '../lib/file-dispatcher.js'
import { CoordinatorLoop } from '../lib/coordinator.js'

test('real bundle local connector observes HTTP grant/edit and stops without touching Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'loom-bundle-connector-'))
  const server = new SyntheticCoordinator({ root }); const baseUrl = await server.listen()
  const code = 'single-use-fixture-code'; server.enrollmentCodes.set(createHash('sha256').update(code).digest('hex'), Date.now() + 60000)
  const project = await server.prepareProject('plugin-isolated'); const grant = server.makeGrant({ project_id: project.id })
  const node = await LocalNodeRunner.create({ baseUrl, stateDir: join(root, 'state'), artifactDir: join(root, 'artifacts'), enrollmentCode: code })
  const ticket = server.makeTicket({ project_id: project.id, objective: 'Fixture edit, not a model task' })
  await server.dispatchTicket(ticket.id, node.nodeId, { kind: 'edit_file', relative_path: 'result.txt', content: 'Fixture plugin connector output\n' })
  const loop = new CoordinatorLoop({ max_active_workers: 1, poll_seconds: 1, heartbeat_ms: 2000 }, new LocalFileDispatcher(node), node.client)
  const assignment = await loop.pollCycle()
  await loop.handle(assignment)
  await node.client.dispatchOutbox()
  assert.equal(await readFile(join(project.root, 'result.txt'), 'utf8'), 'Fixture plugin connector output\n')
  assert.equal(server.tickets.get(ticket.id).status, 'succeeded')
  await loop.dispose(); await server.close()
})
