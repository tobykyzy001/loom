import { describe, expect, it } from 'vitest'
import type { LoomNode, Project } from '../src/api/types'
import { nodeOptionKey, selection } from '../src/binding-input'

const project: Project = { id: 'project-b', name: 'Actual B', root: '/owned/actual-project-b', mode: 'read_write' }
const node = (installation_id?: string, extra: Partial<LoomNode> = {}): LoomNode => ({
  id: 'shared-node-id', name: 'Shared example', installation_id, revoked_at: null, ...extra,
})

describe('Node and Installation selection', () => {
  it('preserves the exact four-key single-installation request without manufacturing an installation selector', () => {
    const chosen = node('single-installation')
    const result = selection(project, [chosen], nodeOptionKey(chosen, [chosen]), ' worker ')
    expect(result.payload).toEqual({
      project_id: 'project-b', node_id: chosen.id, worker_id: 'worker', root_scope: project.root,
    })
    expect(Object.keys(result.payload!).includes('installation_id')).toBe(false)
    expect(result.requiresInstallation).toBe(false)
  })

  it('preserves the selected installation and exact input root/worker, not the first shared-key row', () => {
    const rows = [node('install-a'), node('install-b')]
    const wanted = nodeOptionKey(rows[1])
    const result = selection(project, [...rows].reverse(), wanted, ' worker-b ')
    expect(result.payload).toEqual({
      project_id: 'project-b', node_id: rows[1].id, installation_id: 'install-b',
      worker_id: 'worker-b', root_scope: project.root,
    })
    expect(result.requiresInstallation).toBe(true)
  })

  it('rejects missing or duplicate installation identities without dropping those problematic records', () => {
    for (const candidates of [[node(undefined), node('usable-second')], [node('duplicate'), node('duplicate')]]) {
      const result = selection(project, candidates, nodeOptionKey(candidates[1]), 'worker')
      expect(result.issue).toBe('ambiguous_identity')
      expect(result.payload).toBeNull()
    }
  })

  it('never silently substitutes another install when the requested row is revoked or no longer exists', () => {
    const rows = [node('online-other'), node('selected-revoked', { revoked_at: '2026-01-01T00:00:00Z' })]
    expect(selection(project, rows, nodeOptionKey(rows[1]), 'worker').issue).toBe('not_usable')
    expect(selection(project, [node('other')], JSON.stringify([rows[0].id, 'absent-installation']), 'worker').issue).toBe('not_usable')
  })

  it('rejects malformed/hand-edited keys rather than manufacturing a credential from the raw tuple', () => {
    const result = selection(project, [node('valid-but-unselected')], JSON.stringify([{}, 'valid-but-unselected']), 'worker')
    expect(result.issue).toBe('invalid_selection')
    expect(result.payload).toBeNull()
  })
})
