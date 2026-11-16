/* Invalid or partial evidence stays unavailable. */
import type { ReplaySample, SkillCandidate, SkillProof, SkillProofJson, SkillReplay, SkillWorkspaceData } from '../api/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256 = /^[0-9a-f]{64}$/
const bounded = (value: string, max = 500) => typeof value === 'string' && value.length > 0 && value.length <= max
const boundedId = (value: unknown): value is string => typeof value === 'string' && bounded(value, 160) && !value.startsWith('#/') && !value.includes('/')

export function skillSourceRefs(value: unknown): string[] {
  let entries: unknown = value
  if (typeof value === 'string') {
    if (value.length > 4096) return []
    try { entries = JSON.parse(value) } catch { return [] }
  }
  if (!Array.isArray(entries) || entries.length > 8) return []
  const ids: string[] = []
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && (entry as { kind?: unknown }).kind === 'source_ticket' ? (entry as { ticket_id?: unknown }).ticket_id : null
    if (!boundedId(id)) return []
    ids.push(id)
  }
  return ids
}

export function candidateContent(candidate: SkillCandidate): string | null {
  if (!boundedId(candidate.id) || candidate.kind !== 'skill' || !bounded(candidate.content, 4096) || !boundedId(candidate.scope)) return null
  try {
    const content: unknown = JSON.parse(candidate.content)
    if (!content || typeof content !== 'object') return null
    const text = (content as { content?: unknown }).content
    return typeof text === 'string' && bounded(text, 500) ? text : null
  } catch { return null }
}

function commonReplayFields(value: unknown): string[] {
  const row = value as Partial<SkillReplay>
  if (!row || row.schema !== 'loom.skill-replay.v1') return ['未知回放证明格式']
  const blockers: string[] = []
  if (!boundedId(row.candidate_id) || !boundedId(row.source_ticket_id) || !boundedId(row.replay_ticket_id)) blockers.push('任务关联不完整')
  if (!UUID.test(row.source_artifact_id ?? '') || (row.replay_artifact_id !== null && !UUID.test(row.replay_artifact_id ?? ''))) blockers.push('Artifact 引用不完整')
  if (!SHA256.test(row.expected_sha256 ?? '') || row.current_project_valid !== true || row.authority_created !== false || row.runtime !== 'bounded_exact_deterministic_read_summary_only') blockers.push('原项目、执行范围或预期摘要无效')
  if (row.source_ticket_id === row.replay_ticket_id) blockers.push('回放必须创建独立普通 Ticket')
  if (row.replay_artifact_id && row.replay_artifact_id === row.source_artifact_id) blockers.push('回放必须创建独立 Artifact')
  if (sampleDigest(row.sample) === null || !Array.isArray(row.expected_sample?.lines) || !bounded(row.expected_sample?.path ?? '') || row.expected_sample?.line_count !== row.sample?.line_count || row.expected_sample?.path !== row.sample?.path) blockers.push('样本与来源关联不完整')
  return blockers
}

function sampleDigest(sample: ReplaySample | undefined): string | null {
  if (!sample || !SHA256.test(sample.digest) || !bounded(sample.path) || typeof sample.line_count !== 'number' || sample.line_count < 0 || sample.line_count > 100 || !Array.isArray(sample.lines) || sample.lines.length > 25 || sample.lines.some(line => typeof line !== 'string' || line.length > 500)) return null
  return sample.digest
}
export function replaySnapshot(value: unknown): SkillReplay | null {
  if (!value || typeof value !== 'object') return null
  return value as SkillReplay
}

export function replayRequirement(replay: SkillReplay | null, candidate?: SkillCandidate): string | null {
  if (!replay) return '尚无回放证据；等待用户确认一次普通只读执行。'
  const blockers = commonReplayFields(replay)
  if (candidate && (candidate.id !== replay.candidate_id || !skillSourceRefs(candidate.source_refs).includes(replay.source_ticket_id) || !candidateContent(candidate))) return '回放来源未绑定在此候选上。'
  if (blockers.length) return blockers.join('；')
  if (replay.grant_revocation_denied_at) return '原 Grant 已撤销，不能用于首次审核；历史可回看。'
  if (replay.replay_artifact_id === null || replay.status === 'awaiting_execution') return '等待普通节点的真实报告与独立 Artifact；请刷新后检查。'
  if (replay.status !== 'verified') return replay.status === 'sample_mismatch' ? '回放样本不一致，不能接受此证据。' : replay.status === 'failed' ? '回放执行失败，不能代替验证通过。' : '结果未知或仍待对账，不能标记为验证通过。'
  if (!replay.verified_at) return '缺少首次验证时间，不能判定为已通过回放。'
  if (!boundedId(replay.grant_id)) return 'Grant 关联不完整。'
  return null
}

export function saveRecordedProof(value: unknown): SkillProofJson | null {
  if (!value || typeof value !== 'object') return null
  const record = value as SkillProof
  if (!bounded(record.proof_json, 8192) || !boundedId(record.id)) return null
  let proof: unknown
  try { proof = JSON.parse(record.proof_json) } catch { return null }
  if (!proof || typeof proof !== 'object') return null
  const result = proof as Partial<SkillProofJson>
  if (result.schema !== 'loom.skill.v1' || result.replay_verified !== true || result.bounded_operation !== 'read_summary' || !SHA256.test(result.sha256 ?? '') || result.standing_grant !== false || result.activation !== false || sampleDigest(result.sample) === null || result.grant_id !== record.grant_id) return null
  const ids = ['source_ticket_id', 'source_artifact_id', 'replay_ticket_id', 'replay_artifact_id'] as const
  if (record.kind !== 'skill') return null
  for (const key of ids) {
    if (result[key] !== record[key]) return null
  }
  if (result.source_artifact_id === result.replay_artifact_id || result.source_ticket_id === result.replay_ticket_id || !UUID.test(result.source_artifact_id!) || !UUID.test(result.replay_artifact_id!)) return null
  return result as SkillProofJson
}

export function skillDataFrom(value: unknown): SkillWorkspaceData | null {
  if (!value || typeof value !== 'object') return null
  const body = value as Partial<SkillWorkspaceData>
  if (!Array.isArray(body.candidates) || !Array.isArray(body.skill_replays) || !Array.isArray(body.skills)) return null
  if (body.candidates.length > 500 || body.skill_replays.length > 500 || body.skills.length > 500) return null
  return {
    candidates: body.candidates.filter((candidate): candidate is SkillCandidate => !!candidate && typeof candidate === 'object' && typeof candidate.id === 'string' && candidate.kind === 'skill'),
    skill_replays: body.skill_replays.map(replaySnapshot).filter((replay): replay is SkillReplay => !!replay),
    skills: body.skills.filter((skill): skill is SkillProof => !!skill && typeof skill === 'object' && typeof skill.id === 'string'),
    policy: typeof body.policy === 'string' ? body.policy.slice(0, 600) : undefined,
  }
}
