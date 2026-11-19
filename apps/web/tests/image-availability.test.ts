import { describe, expect, it } from 'vitest'
import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import ImageAvailabilityAssessment from '../src/components/ImageAvailabilityAssessment.vue'
import { imageGrantCandidates, imageWaitMeaning, placementResult } from '../src/lib/imageAvailability'
import type { Grant, LoomNode, Project } from '../src/api/types'

const project: Project = { id: 'project-a', name: 'A', root: '/private/owned/a', mode: 'read_only' }
const node = (installation_id: string | undefined = 'installation-a'): LoomNode => ({
  id: 'node-a', installation_id, status: 'online', capabilities: [{ ticket_kind: 'read_summary', permission: 'read' }],
  inventory: { schema: 'loom.inventory.v1', canonical_project_roots: { 'project-a': '/private/owned/a' } },
})
const grant = (changes: Partial<Grant> = {}): Grant => ({
  id: 'grant-a', project_id: 'project-a', project_binding_id: 'binding-a', node_id: 'node-a', installation_id: 'installation-a', worker_id: 'default', operations: ['read'], revoked_at: null, status: 'active', ...changes,
})
const response = () => ({
  schema: 'loom.inventory.v1', selected: null,
  waiting: [{ code: 'hardware_incompatible', resource: 'hardware.memory_bytes', source: 'controller_probed', confidence: 'incompatible' }],
  explanation: 'These exact conditions are not satisfied.', existing_grant_matching_passed: true,
  permission_boundary: 'Discovery is not a Grant.',
})

describe('explicit read-Grant scope for a hardware condition evaluation', () => {
  it('accepts the exact Node/Installation/Worker/declared-root combination only when the human selects it', () => {
    expect(imageGrantCandidates(node(), [project], [grant()]).map(row => row.id)).toEqual(['grant-a'])
    expect(imageGrantCandidates(node(), [project], [grant(), grant({ id: 'another-valid-grant' })])).toHaveLength(2)
  })
  it('never borrows another installation, missing installation, auto node, revoked/worker or read-less Grant', () => {
    expect(imageGrantCandidates(node(), [project], [grant({ node_id: 'node-b' })])).toHaveLength(0)
    expect(imageGrantCandidates(node('other-installation'), [project], [grant()])).toHaveLength(0)
    expect(imageGrantCandidates({ ...node(), installation_id: undefined }, [project], [grant({ installation_id: undefined })])).toHaveLength(0)
    expect(imageGrantCandidates(node(), [project], [grant({ node_id: 'auto' })])).toHaveLength(0)
    expect(imageGrantCandidates(node(), [project], [grant({ revoked_at: new Date().toISOString() })])).toHaveLength(0)
    expect(imageGrantCandidates(node(), [project], [grant({ status: 'revoked' })])).toHaveLength(0)
    expect(imageGrantCandidates(node(), [project], [grant({ operations: ['invoke_text'] })])).toHaveLength(0)
    expect(imageGrantCandidates(node(), [project], [grant({ worker_id: undefined })])).toHaveLength(0)
  })
  it('requires an actual declared project root and no fallback from canonical absence', () => {
    expect(imageGrantCandidates(node(), [project], [grant({ project_binding_id: undefined })])).toHaveLength(0)
    expect(imageGrantCandidates(node(), [project], [grant({ project_id: 'project-b' })])).toHaveLength(0)
    const aliased = node().inventory!.canonical_project_roots!['project-a']
    if (typeof aliased !== 'string') throw new Error('test fixture must have a canonical root')
    expect(imageGrantCandidates(node(), [{ ...project, root: aliased }], [grant()])).toHaveLength(1)
    const withoutCanonical = node()
    delete withoutCanonical.inventory!.canonical_project_roots
    expect(imageGrantCandidates(withoutCanonical, [project], [grant()])).toHaveLength(0)
  })
  it('requires an explicit user choice and makes no image readiness claim in collapsed SSR', async () => {
    const html = await renderToString(createSSRApp(ImageAvailabilityAssessment, { node: node(), projects: [project], grants: [grant()], result: null }))
    expect(html).toContain('必须明确选择')
    expect(html).toContain('没有当前固定硬件探针结果')
    expect(html).toContain('disabled')
    expect(html).not.toContain('已支持本地图像生成')
  })
})

describe('bounded placement result for a report, not a new permission', () => {
  it('preserves a properly formed conditional reason and never calls generation', () => {
    const parsed = placementResult(response())
    expect(parsed?.selected).toBeNull()
    expect(parsed?.waiting[0].resource).toBe('hardware.memory_bytes')
    expect(imageWaitMeaning(parsed!.waiting[0])).toContain('并非据此否定所有图像生成')
  })
  it('preserves an exact candidate scope without turning its Root text into an Artifact URI or Grant', () => {
    const parsed = placementResult({ ...response(), waiting: [], selected: { node_id: 'node-a', installation_id: 'installation-a', worker_id: 'default', project_binding_id: 'binding-a', root_scope: '/private/owned/a' } })
    expect(parsed?.selected?.project_binding_id).toBe('binding-a')
    expect(parsed?.selected?.root_scope).toBe('/private/owned/a')
    expect(parsed?.existing_grant_matching_passed).toBe(true)
  })
  it('refuses missing or untyped reason/source/boundary fields and unsupported schemas', () => {
    expect(placementResult({ ...response(), schema: 'untrusted.schema' })).toBeNull()
    expect(placementResult({ ...response(), waiting: [{ code: 'offline' }] })).toBeNull()
    expect(placementResult({ ...response(), existing_grant_matching_passed: 'yes' })).toBeNull()
    expect(placementResult({ ...response(), permission_boundary: '' })).toBeNull()
    expect(placementResult({ ...response(), waiting: Array.from({ length: 65 }, () => response().waiting[0]) })).toBeNull()
  })
  it('rejects a candidate missing root, project Binding or exact identity', () => {
    expect(placementResult({ ...response(), selected: { node: 'node-a' } })).toBeNull()
    expect(placementResult({ ...response(), selected: null })).not.toBeNull()
  })
})
