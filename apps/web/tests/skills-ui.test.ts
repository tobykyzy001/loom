import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it, vi } from 'vitest'
import SkillsView from '../src/views/SkillsView.vue'
import type { LoomClient } from '../src/api/client'
import { SkillActions } from '../src/lib/skillActions'
import type { SkillCandidate, SkillProof, SkillReplay, SkillWorkspaceData, Ticket } from '../src/api/types'

const expectedHash = 'a'.repeat(64)
const originalArtifact = '11111111-1111-4111-8111-111111111111'
const freshArtifact = '22222222-2222-4222-8222-222222222222'

function ticket(id: string, artifactId: string): Ticket {
  return {
    id, project_id: 'project-a', objective: 'Original ordinary summary', kind: 'read_summary',
    status: 'succeeded', attempt: 1, created_at: '', updated_at: '',
    artifacts: [{ artifact_id: artifactId, ticket_id: id, origin_node_id: 'a'.repeat(64), sha256: expectedHash }],
  }
}
const original = ticket('tkt_original', originalArtifact)
const fresh = ticket('tkt_replay', freshArtifact)

function candidate(): SkillCandidate {
  return {
    id: 'candidate-a', kind: 'skill', scope: 'project-a',
    status: 'pending', content: JSON.stringify({ content: '有界只读摘要' }),
    source_refs: JSON.stringify(['tkt_original']), version: 1,
  }
}
function provenReplay(): SkillReplay {
  return {
    schema: 'loom.skill-replay.v1', candidate_id: 'candidate-a',
    source_ticket_id: original.id, source_artifact_id: originalArtifact,
    replay_ticket_id: fresh.id, replay_artifact_id: freshArtifact, expected_sha256: expectedHash,
    expected_sample: { path: 'samples/summary.json', line_count: 1, lines: ['bounded summary'] },
    sample: { path: 'samples/summary.json', line_count: 1, lines: ['bounded summary'], digest: 'b'.repeat(64) },
    status: 'verified', verified_at: '2026-11-17T06:00:00Z', current_project_valid: true,
    authority_created: false, runtime: 'bounded_exact_deterministic_read_summary_only',
    grant_id: 'grant-read', grant_revocation_denied_at: null,
  }
}
function data(status = 'pending'): SkillWorkspaceData {
  return { candidates: [{ ...candidate(), status }], skill_replays: [], skills: [] }
}
async function render(value: SkillWorkspaceData, tickets = [original]) {
  return renderToString(createSSRApp(SkillsView, {
    data: value, projects: [{ id: 'project-a', name: '授权资料项目', mode: 'read_only' }],
    tickets, loading: false, busy: false,
  }))
}

describe('Skill candidate and replay evidence view', () => {
  it('shows source choices and no acceptance without either a replay or implicit execution', async () => {
    const html = await render(data())
    expect(html).toContain('有界只读摘要')
    expect(html).toContain('tkt_original')
    expect(html).toContain('审阅回放影响')
    expect(html).not.toContain('接受已验证证据')
    expect(html).not.toContain('回放证据已通过')
    const invalid = await render({ ...data(), candidates: [{ ...candidate(), source_refs: JSON.stringify(['#/grant']) }] })
    expect(invalid).toContain('缺少合法的实际 source_ticket_id')
    expect(invalid).not.toContain('审阅回放影响')
    expect(invalid).not.toContain('接受已验证证据')
    expect(invalid).not.toContain('回放证据已通过')
  })

  it('accepts only coherent verified evidence and blocks revoked or mismatch proof', async () => {
    const valid = await render({ ...data(), skill_replays: [provenReplay()] }, [original, fresh])
    expect(valid).toContain('回放证据已通过')
    expect(valid).toContain(freshArtifact)
    expect(valid).toContain(expectedHash)
    expect(valid).toMatch(/<button class="button primary"[^>]*>接受已验证证据<\/button>/)

    const revoked = await render({ ...data(), skill_replays: [{ ...provenReplay(), grant_revocation_denied_at: '2026-11-17T06:01:00Z' }] }, [original, fresh])
    expect(revoked).toContain('原 Grant 已撤销，不能用于首次审核；历史可回看')
    expect(revoked).toMatch(/<button class="button primary" disabled[^>]*>接受已验证证据<\/button>/)

    const mismatch = await render({ ...data(), skill_replays: [{ ...provenReplay(), status: 'sample_mismatch' }] }, [original, fresh])
    expect(mismatch).toContain('回放样本不一致')
    expect(mismatch).toMatch(/<button class="button primary" disabled[^>]*>接受已验证证据<\/button>/)

    const reused = await render({ ...data(), skill_replays: [{ ...provenReplay(), replay_artifact_id: originalArtifact }] }, [original, fresh])
    expect(reused).toContain('回放必须创建独立 Artifact')
    expect(reused).toMatch(/<button class="button primary" disabled[^>]*>接受已验证证据<\/button>/)
  })

  it('shows a saved historical proof with task linkage and without execution affordances', async () => {
    const linked = provenReplay()
    const proofJson = {
      schema: 'loom.skill.v1', bounded_operation: 'read_summary', replay_verified: true,
      source_ticket_id: linked.source_ticket_id, source_artifact_id: linked.source_artifact_id,
      replay_ticket_id: linked.replay_ticket_id, replay_artifact_id: linked.replay_artifact_id,
      sha256: expectedHash, sample: linked.sample, grant_id: 'grant-read',
      standing_grant: false, activation: false,
    }
    const saved: SkillProof = {
      id: 'skill-saved', candidate_id: 'candidate-a', scope: 'project-a', kind: 'skill',
      source_ticket_id: original.id, source_artifact_id: originalArtifact,
      replay_ticket_id: fresh.id, replay_artifact_id: freshArtifact, grant_id: 'grant-read',
      definition_json: '{}', proof_json: JSON.stringify(proofJson),
    }
    const html = await render({ ...data('accepted'), skill_replays: [linked], skills: [saved] }, [original, fresh])
    expect(html).toContain('历史证明 · 非激活')
    expect(html).toContain('撤销这次已保存审阅')
    expect(html).toContain('有界只读摘要')
    expect(html).toContain(freshArtifact)
    expect(html).toContain(expectedHash)
    expect(html).not.toContain('运行 Skill')
    expect(html).not.toContain('激活 provider')
    expect(html).not.toContain('安装节点')
  })
})

describe('Limited client wrapper', () => {
  it('calls no network on construction and only posts a real source ID on an explicit request', async () => {
    const post = vi.fn().mockResolvedValue({})
    const get = vi.fn(async (path: string) => {
      if (path === '/candidates') return data()
      if (path === '/tickets') return [original]
      if (path === `/tickets/${original.id}`) return original
      throw new Error(`unexpected unbounded request: ${path}`)
    })
    const actions = new SkillActions({ post, get } as unknown as LoomClient)
    expect(post).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    await actions.replay(candidate(), original.id)
    expect(post).toHaveBeenCalledWith('/candidates/candidate-a/replay', { source_ticket_id: original.id })
    expect(get.mock.calls.map(call => call[0])).toEqual(['/candidates', '/tickets', `/tickets/${original.id}`])
    await expect(actions.replay(candidate(), '#/grant')).rejects.toThrow('回放来源不在真实候选绑定中')
  })
})
