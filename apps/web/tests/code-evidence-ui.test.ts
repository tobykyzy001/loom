import { createSSRApp } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { describe, expect, it } from 'vitest'
import CodeArtifactView from '../src/components/CodeArtifactView.vue'
import { codeArtifactPresentation, CODE_DIFF } from '../src/lib/codeEvidence'
import type { ArtifactContent, ArtifactRef, Effect, Ticket } from '../src/api/types'

type Evidence = Record<string, unknown>
type Meta = ArtifactRef & { assignment_id: string; name: string; parents: []; code_evidence: Evidence }
const ticketId = 'ticket-code-evidence'
const nodeId = 'a'.repeat(64)
const oldSha = '0'.repeat(64)
const newSha = '1'.repeat(64)
const sessionId = '22222222-2222-4222-8222-222222222222'
const ids = {
  diff: '11111111-1111-4111-8111-111111111111',
  verification: '33333333-3333-4333-8333-333333333333',
  effect: '44444444-4444-4444-8444-444444444444',
  secondDiff: '55555555-5555-4555-8555-555555555555',
  secondVerification: '66666666-6666-4666-8666-666666666666',
  secondEffect: '77777777-7777-4777-8777-777777777777',
}
function session(): Evidence { return { harness: 'dsh', session_id: sessionId, host_api: '0.2.2-rc.3', protocol: 'dsh-session-log', observed_seq: 4 } }
function change(result = 'edit-result'): Evidence {
  return { schema: 'loom.code-change.v1', type: 'dsh-tool-result', name: 'loom_fixture_code_edit', call_id: 'edit-call', call_seq: 1, result_id: result, result_seq: 2, session: session(), path: 'src/calc.js', previous_sha256: oldSha, sha256: newSha, size_bytes: 52 }
}
function verify(diffId: string, result = 'verify-result'): Evidence {
  return { type: 'dsh-tool-result', name: 'loom_fixture_verify', call_id: 'verify-call', call_seq: 3, result_id: result, result_seq: 4, session: session(), code_change_artifact_id: diffId, path: 'src/calc.js', sha256: newSha }
}
function body(passed: boolean, diffId: string): Evidence {
  return { schema: 'loom.code-verification.v1', sha256: newSha, source_change_artifact_id: diffId, edit_tool_result: 'edit-result', verification_tool_result: 'verify-result', path: 'src/calc.js', command: { file: 'node', args: ['--test', 'test/calc.test.js'] }, runner: 'node:test', cwd_scope: 'authorized_project_root', execution_status: 'completed', exit_code: passed ? 0 : 1, passed, previous_test_exit_code: 1, stdout: passed ? 'all tests passed\n' : 'assertion failed\n', stderr: passed ? '' : '<script>globalThis.pwned = true</script>\n', dsh_session: session() }
}
function projected(evidence: Evidence): Evidence {
  const isChange = evidence.name === 'loom_fixture_code_edit'
  return { schema: 'loom.code-provenance.v1', kind: isChange ? 'change' : 'verification',
    call_id: evidence.call_id, call_seq: evidence.call_seq, result_id: evidence.result_id, result_seq: evidence.result_seq,
    session: evidence.session, path: evidence.path, sha256: evidence.sha256,
    ...(isChange ? { previous_sha256: evidence.previous_sha256, size_bytes: evidence.size_bytes } : { source_change_artifact_id: evidence.code_change_artifact_id }) }
}
function content(id: string, assignmentId: string, evidence: Evidence, bytes: string, mediaType: 'text/x-diff' | 'application/json'): ArtifactContent {
  return { metadata: { artifact_id: id, assignment_id: assignmentId, ticket_id: ticketId, origin_node_id: nodeId, name: 'evidence.bin', media_type: mediaType, parents: [], code_evidence: projected(evidence) } as Meta, content: bytes, encoding: 'utf8', truncated: false }
}
function fixture(passed = false, second = false): { ticket: Ticket; diff: ArtifactContent; verification: ArtifactContent } {
  const prefix = passed ? 'second' : ''
  const diffId = passed ? ids.secondDiff : ids.diff
  const verificationId = passed ? ids.secondVerification : ids.verification
  const effectId = passed ? ids.secondEffect : ids.effect
  const assignmentId = passed ? 'assignment-passed' : 'assignment-failed'
  const edit = change()
  const effectEvidence = { ...edit, test_tool_result_id: 'verify-result', verification_artifact_id: verificationId, test_exit_code: passed ? 0 : 1 }
  const diff = content(diffId, assignmentId, edit, CODE_DIFF, 'text/x-diff')
  const verification = content(verificationId, assignmentId, verify(diffId), JSON.stringify(body(passed, diffId)), 'application/json')
  const baseTicket: Ticket = { id: ticketId, project_id: 'project', objective: 'fix fixture', status: 'succeeded', attempt: 2, created_at: '', updated_at: '' }
  return { diff, verification, ticket: { ...baseTicket,
    assignments: [{ id: 'assignment-failed', ticket_id: ticketId, node_id: nodeId, worker_id: 'default', attempt: 1 }, { id: 'assignment-passed', ticket_id: ticketId, node_id: nodeId, worker_id: 'default', attempt: 2 }],
    reports: [{ assignment_id: 'assignment-failed', status: 'failed', state: 'failed', summary: 'first attempt failed' }, { assignment_id: 'assignment-passed', status: 'succeeded', state: 'succeeded', summary: 'retry succeeded' }],
    effects: [{ effect_id: effectId, assignment_id: assignmentId, status: 'confirmed', evidence: JSON.stringify(effectEvidence), artifacts: [diffId] } as Effect & { assignment_id: string; artifacts: string[] }],
    artifacts: [diff.metadata, verification.metadata],
  } }
}
function html(ticket: Ticket, artifact: ArtifactContent, artifacts: ArtifactContent[]) {
  return renderToString(createSSRApp(CodeArtifactView, { ticket, artifact, artifacts }))
}
function incomplete(ticket: Ticket, artifact: ArtifactContent, artifacts: ArtifactContent[]) {
  expect(codeArtifactPresentation(ticket, artifact, artifacts)).toMatchObject({ kind: 'unsupported', reason: 'incomplete_relation' })
}

describe('strict downloaded code evidence relation', () => {
  it('renders the failed original Attempt and passed retry independently of input/Ticket order', async () => {
    const failed = fixture(false), passed = fixture(true)
    const ticket = { ...failed.ticket, effects: [...failed.ticket.effects!, ...passed.ticket.effects!], artifacts: [...passed.ticket.artifacts!, ...failed.ticket.artifacts!] }
    const diffView = codeArtifactPresentation(ticket, failed.diff, [passed.verification, passed.diff, failed.verification])
    expect(diffView).toMatchObject({ kind: 'change', relation: { assignmentId: 'assignment-failed', attempt: 1, reportStatus: 'failed', verificationArtifactId: ids.verification } })
    const verifyView = codeArtifactPresentation(ticket, passed.verification, [failed.diff, passed.diff, failed.verification])
    expect(verifyView).toMatchObject({ kind: 'verification', exitCode: 0, passed: true, relation: { assignmentId: 'assignment-passed', attempt: 2, reportStatus: 'succeeded', sourceArtifactId: ids.secondDiff } })
    const failedHtml = await html(ticket, failed.verification, [passed.diff, failed.diff])
    const passedHtml = await html(ticket, passed.verification, [passed.diff, failed.diff])
    expect(failedHtml).toContain('data-exit-code="1" data-report-status="failed" data-assignment-id="assignment-failed"')
    expect(failedHtml).toContain('FAILED')
    expect(failedHtml).not.toContain('>PASSED<')
    expect(passedHtml).toContain('data-exit-code="0" data-report-status="succeeded" data-assignment-id="assignment-passed"')
    expect(passedHtml).toContain('PASSED')
    expect(passedHtml).not.toContain('>FAILED<')
    const diffHtml = await html(ticket, failed.diff, [passed.verification, failed.verification])
    expect(diffHtml).toContain('code-diff-line removed')
    expect(diffHtml).toContain('-  return a - b;')
    expect(diffHtml).toContain('code-diff-line added')
    expect(diffHtml).toContain('+  return a + b;')
    expect(diffHtml).toContain(oldSha)
    expect(diffHtml).toContain(newSha)
    expect(diffHtml).toContain(ids.effect)
    expect(diffHtml).toContain(ids.verification)
    expect(diffHtml).toContain('class="artifact-content"')
    expect(diffHtml).toContain(CODE_DIFF)
    expect(passedHtml).toContain('node --test test/calc.test.js')
    expect(passedHtml).toContain('class="artifact-content"')
  })

  it('follows the selected reviewed DSH version through every evidence relation without accepting unknown hosts', () => {
    const f = fixture(false)
    const upgrade = (value: unknown, host_api: string): unknown => {
      if (Array.isArray(value)) return value.map(item => upgrade(item, host_api))
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'host_api' ? host_api : upgrade(item, host_api)]))
      return value
    }
    const upgraded = upgrade(f, '0.2.2-rc.5') as ReturnType<typeof fixture>
    expect(codeArtifactPresentation(upgraded.ticket, upgraded.verification, [upgraded.diff])).toMatchObject({ kind: 'verification', exitCode: 1, passed: false })
    for (const version of ['0.2.2-rc.4', '0.2.3', 'https://private.invalid']) {
      const invalid = upgrade(f, version) as ReturnType<typeof fixture>
      incomplete(invalid.ticket, invalid.verification, [invalid.diff])
    }
  })

  it('rejects missing source, cross-Assignment, source SHA and result reference mismatches', () => {
    const f = fixture()
    incomplete({ ...f.ticket, artifacts: [f.verification.metadata] }, f.verification, [f.verification])
    incomplete(f.ticket, f.verification, [])
    const cross = { ...f.ticket, reports: [{ assignment_id: 'assignment-passed', status: 'failed' as const, summary: 'wrong Attempt' }] }
    incomplete(cross, f.diff, [f.verification])
    const badSha = { ...f.verification, content: JSON.stringify({ ...body(false, ids.diff), sha256: '2'.repeat(64) }) }
    incomplete(f.ticket, badSha, [f.diff])
    const badReference = content(ids.verification, 'assignment-failed', { ...verify(ids.diff), result_id: 'other-result' }, f.verification.content, 'application/json')
    incomplete(f.ticket, badReference, [f.diff])
    const badEdit = { ...f.diff, metadata: { ...f.diff.metadata, code_evidence: projected(change('other-edit')) } }
    incomplete(f.ticket, f.verification, [badEdit])
  })

  it('rejects arbitrary commands, inconsistent pass/exit/report and bad source identity', () => {
    const f = fixture()
    const command = { ...f.verification, content: JSON.stringify({ ...body(false, ids.diff), command: { file: 'sh', args: ['-c', 'anything'] } }) }
    incomplete(f.ticket, command, [f.diff])
    const passMismatch = { ...f.verification, content: JSON.stringify({ ...body(false, ids.diff), passed: true }) }
    incomplete(f.ticket, passMismatch, [f.diff])
    const wrongReport = { ...f.ticket, reports: [{ assignment_id: 'assignment-failed', status: 'succeeded' as const, summary: 'fabricated success' }] }
    incomplete(wrongReport, f.verification, [f.diff])
    const stateConflict = { ...f.ticket, reports: [{ assignment_id: 'assignment-failed', status: 'failed' as const, state: 'succeeded', summary: 'conflict' }] }
    incomplete(stateConflict, f.verification, [f.diff])
    const invalidId = { ...f.diff, metadata: { ...f.diff.metadata, artifact_id: 'not-a-uuid' } }
    incomplete(f.ticket, f.verification, [invalidId])
    const emptyName = { ...f.diff, metadata: { ...f.diff.metadata, name: '' } }
    incomplete(f.ticket, f.verification, [emptyName])
  })

  it('refuses verification which begins before the edit result in the same Session', () => {
    const f = fixture()
    const source = f.diff.metadata.code_evidence as Record<string, unknown>
    for (const result_seq of [3, 4]) {
      const outOfOrder = { ...f.diff, metadata: { ...f.diff.metadata,
        code_evidence: { ...source, result_seq } } }
      incomplete(f.ticket, outOfOrder, [f.verification])
    }
  })

  it('rejects corrupt diff, absent/unconfirmed Effect and incomplete bytes', async () => {
    const f = fixture()
    incomplete(f.ticket, { ...f.diff, content: 'diff --git a/src/calc.js b/src/calc.js\n-  return a - b;\n+  return a + b;\n' }, [f.verification])
    incomplete({ ...f.ticket, effects: [] }, f.diff, [f.verification])
    const unconfirmed = { ...f.ticket, effects: [{ ...f.ticket.effects![0], status: 'unknown' as const }] }
    incomplete(unconfirmed, f.diff, [f.verification])
    for (const artifact of [{ ...f.verification, truncated: true }, { ...f.verification, encoding: 'base64' as const }]) {
      expect(codeArtifactPresentation(f.ticket, artifact, [f.diff]).kind).toBe('unsupported')
      const broken = await html(f.ticket, artifact, [f.diff])
      expect(broken).toContain('证据关联不完整')
      expect(broken).not.toContain('>PASSED<')
    }
  })

  it('rejects mismatched effect verification ID, result, exit and foreign metadata evidence', () => {
    const f = fixture()
    const base = JSON.parse(f.ticket.effects![0].evidence as string) as Evidence
    for (const changeTo of [{ verification_artifact_id: ids.secondVerification }, { test_tool_result_id: 'other' }, { test_exit_code: 0 }]) {
      const ticket = { ...f.ticket, effects: [{ ...f.ticket.effects![0], evidence: { ...base, ...changeTo } }] }
      incomplete(ticket, f.verification, [f.diff])
    }
    incomplete(f.ticket, content(ids.verification, 'assignment-failed', { ...verify(ids.diff), name: 'loom_fixture_code_edit' }, f.verification.content, 'application/json'), [f.diff])
  })

  it('rejects wrong Artifact membership, duplicate reports, altered media type and malformed output', () => {
    const f = fixture()
    const foreignRef = { ...f.diff.metadata, artifact_id: ids.secondDiff }
    incomplete({ ...f.ticket, artifacts: [foreignRef, f.verification.metadata] }, f.verification, [f.diff])
    const duplicate = { ...f.ticket, reports: [...f.ticket.reports!, { assignment_id: 'assignment-failed', status: 'failed' as const, summary: 'duplicate' }] }
    incomplete(duplicate, f.verification, [f.diff])
    const wrongType = { ...f.diff, metadata: { ...f.diff.metadata, media_type: 'application/json' } }
    incomplete(f.ticket, f.verification, [wrongType])
    incomplete(f.ticket, { ...f.verification, content: JSON.stringify({ ...body(false, ids.diff), stdout: 'x'.repeat(8193) }) }, [f.diff])
    incomplete(f.ticket, { ...f.verification, content: JSON.stringify({ ...body(false, ids.diff), extra: 'unknown' }) }, [f.diff])
    incomplete(f.ticket, { ...f.verification, content: '{' }, [f.diff])
  })

  it('publishes the bounded read evidence relationship without inventing raw content or accepting mismatched proof', async () => {
    const sessionMeta = { session_id: sessionId, protocol: 'dsh-session-log' }
    const source = { schema: 'loom.read-source.v1', path: 'input.txt', bytes: newSha, size_bytes: 47 }
    const proof = { schema: 'loom.read-proof.v1', name: 'loom_fixture_inspect', call_id: 'read-call', call_seq: 1, result_id: 'read-result', result_seq: 2, session: sessionMeta }
    const publicProof = { schema: 'loom.read-provenance.v1', call_id: proof.call_id, call_seq: 1, result_id: proof.result_id, result_seq: 2, session: session(), path: 'input.txt', sha256: newSha, size_bytes: 47, read_observed: true, raw_artifact_published: false }
    const artifact: ArtifactContent = {
      metadata: { artifact_id: ids.verification, ticket_id: ticketId, origin_node_id: nodeId, assignment_id: 'assignment-failed', name: 'read-evidence.json', read_evidence: publicProof } as ArtifactRef & { read_evidence: Evidence },
      content: JSON.stringify({ schema: 'loom.read-evidence.v1', source, read_observed: true, raw_artifact_published: false, proof }), encoding: 'utf8', truncated: false,
    }
    const ticket: Ticket = { id: ticketId, project_id: 'project', objective: 'Sensitive process is not published twice.', status: 'succeeded', attempt: 1, kind: 'read_summary', relative_path: 'input.txt', created_at: '', updated_at: '',
      assignments: [{ id: 'assignment-failed', ticket_id: ticketId, node_id: nodeId, worker_id: 'default', attempt: 1 }],
      reports: [{ assignment_id: 'assignment-failed', status: 'succeeded', summary: 'bounded valid source proof' }], effects: [] }
    expect(codeArtifactPresentation(ticket, artifact)).toMatchObject({ kind: 'read', sha256: newSha, sessionId })
    const rendered = await html(ticket, artifact, [artifact])
    expect(rendered).toContain('不公开源文件原文、工具参数或助手转录')
    expect(rendered).toContain(newSha)
    for (const publicProof of [{ ...(artifact.metadata as Meta & { read_evidence: Record<string, unknown> }).read_evidence, session: 'legacy-without-version', result_seq: 3 }]) {
      incomplete(ticket, { ...artifact, metadata: { ...artifact.metadata, read_evidence: publicProof } } as ArtifactContent, [artifact])
    }
    const corrupted = { ...artifact, content: JSON.stringify({ ...JSON.parse(artifact.content), source: { ...source, bytes: oldSha } }) }
    incomplete(ticket, corrupted, [artifact])
  })

  it('escapes sensitive stdout as text and preserves an ordinary artifact verbatim', async () => {
    const f = fixture()
    const output = await html(f.ticket, f.verification, [f.diff])
    expect(output).toContain('&lt;script&gt;globalThis.pwned = true&lt;/script&gt;')
    expect(output).not.toContain('<script>globalThis.pwned')
    expect(codeArtifactPresentation(f.ticket, f.verification, [f.diff])).toMatchObject({ kind: 'verification', stderr: '<script>globalThis.pwned = true</script>\n' })
    const ordinary: ArtifactContent = { metadata: { artifact_id: '88888888-8888-4888-8888-888888888888', ticket_id: ticketId, origin_node_id: nodeId, media_type: 'text/plain', type: 'notes' }, content: 'Meeting notes <b>plain text</b>\n' + CODE_DIFF, encoding: 'utf8' }
    expect(codeArtifactPresentation(f.ticket, ordinary)).toMatchObject({ kind: 'unsupported', reason: 'ordinary_artifact' })
    const raw = await html(f.ticket, ordinary, [f.diff, f.verification])
    expect(raw).toContain('Meeting notes &lt;b&gt;plain text&lt;/b&gt;')
    expect(raw).not.toContain('code-diff-line')
    expect(raw).not.toContain('>PASSED<')
  })
})
