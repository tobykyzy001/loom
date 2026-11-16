import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import TicketDetail from '../src/views/TicketDetail.vue'
import type { ModelObservation, Ticket } from '../src/api/types'

const artifactId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const base: Ticket = {
  id: 'tkt-model-text', project_id: 'project-a', objective: '读取授权文本并生成摘要',
  kind: 'read_summary', status: 'succeeded', attempt: 1, created_at: '', updated_at: '',
  artifacts: [{ artifact_id: artifactId, ticket_id: 'tkt-model-text', origin_node_id: 'a'.repeat(64), type: 'summary.txt', sha256: 'c'.repeat(64) }],
}
function observation(): ModelObservation {
  return {
    schema: 'loom.model-observation.v1', artifact_id: artifactId, ticket_id: base.id, assignment_id: 'as-model-text',
    origin_node_id: 'a'.repeat(64), provider: 'loom-stub', model: 'loom-stub-v1', input_modalities: ['text'],
    source: 'host_reported', execution_observed: true, output_observed: true, not_live_llm: true,
    observed_at: '2026-11-17T05:10:00Z', recorded_at: '2026-11-17T05:10:01Z', grant_id: 'grant-model', operation: 'invoke_text',
    grant_current: false, session_id: sessionId,
  }
}
async function render(ticket: Ticket) {
  return renderToString(createSSRApp(TicketDetail, { ticket, projects: [], artifacts: {} }))
}

describe('ticket-scoped model observation', () => {
  it('shows host-reported model fields and the associated same-ticket artifact without claiming activation', async () => {
    const html = await render({ ...base, model_observation: observation() })
    expect(html).toContain('模型观察')
    expect(html).toContain('loom-stub / loom-stub-v1')
    expect(html).toContain('宿主报告（非 controller 独立验证的商业 LLM）')
    expect(html).toContain('已关联模型调用报告')
    expect(html).toContain('零网络确定性 Stub；不是实际 LLM，无 Live LLM 调用。')
    expect(html).toContain('关联 Grant 已撤销，不能用于新调用。')
    expect(html).toContain(sessionId)
    expect(html).toContain(artifactId)
    expect(html).toContain(base.artifacts![0].sha256!)
    expect(html).toContain('Artifact 的 ticket 关系一致')
    expect(html).toContain('查看关联产物')
    expect(html).not.toContain('已激活')
    expect(html).not.toContain('one-click')
  })

  it('does not show the observation for a normal ticket or imply activation for an invalid observation', async () => {
    const html = await render({ ...base, model_observation: null })
    expect(html).not.toContain('模型观察')
    expect(html).not.toContain('loom-stub-v1')
    expect(html).not.toContain('已激活')
    const invalid = await render({ ...base, model_observation: { ...observation(), grant_current: true, artifact_id: 'not-a-uuid', not_live_llm: null, execution_observed: false, output_observed: false } })
    expect(invalid).not.toContain('模型观察')
    expect(invalid).not.toContain('可用模型')
  })
})
