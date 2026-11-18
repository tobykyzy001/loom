import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { handOffArtifactDownload, verifyArtifactBytes } from '../src/lib/artifactDownload'
import { artifactFrom } from '../src/api/parsing'
import type { ArtifactRef } from '../src/api/types'

const bytes = Uint8Array.from([0xff, 0xfe, 0])
const base64 = Buffer.from(bytes).toString('base64')
const sha256 = Buffer.from(bytes)
const digest = createHash('sha256').update(sha256).digest('hex')
function assertCanonicalExample(encoded: string, raw: Uint8Array) {
  const decoded = Buffer.from(encoded, 'base64')
  if (encoded.endsWith('=') && [...decoded].join(',') !== [...raw].join(',')) {
    throw new Error('This noncanonical-tail example must preserve actual bytes, rather than relying on a merely different SHA fixture')
  }
}
function response(overrides: Record<string, unknown> = {}) {
  return { artifact: { id: 'artifact-a', ticket_id: 'ticket-a', assignment_id: 'assignment-a', origin_node_id: 'node-a', name: 'raw.bin', media_type: 'application/octet-stream', sha256: digest, size_bytes: 3, ...overrides }, content: base64, encoding: 'base64', truncated: false }
}
function scope() {
  return { ticketId: 'ticket-a', artifactId: 'artifact-a', originNodeId: 'node-a', assignmentId: 'assignment-a', sha256: digest, sizeBytes: 3 }
}
describe('an explicit byte response preserves rather than decodes binary text', () => {
  it('accepts captured identities only at the requested base64 encoding', () => {
    const parsed = artifactFrom(response(), { ...scope(), encoding: 'base64' })
    expect(parsed.metadata.sha256).toBe(digest)
    expect(parsed.content).toBe('//4A')
    expect(() => artifactFrom(response(), scope())).toThrow('only supports')
    expect(() => artifactFrom(response({ origin_node_id: 'other' }), { ...scope(), encoding: 'base64' })).toThrow('does not belong')
    expect(() => artifactFrom({ ...response(), content: [255, 254, 0] }, { ...scope(), encoding: 'base64' })).toThrow()
  })

  it('recomputes SHA-256 and rejects canonicality, truncation, byte limits and altered bytes', async () => {
    const original = artifactFrom(response(), { ...scope(), encoding: 'base64' })
    expect(original.truncated).toBe(false)
    const file = await verifyArtifactBytes(original.content, original.metadata, original.truncated)
    expect([...file.bytes]).toEqual([...bytes])
    expect(file.sha256).toBe(digest)
    expect(file.filename).toBe('raw.bin')
    const changes: [string, Record<string, unknown>][] = [
      ['length', { ...response(), content: '//4' }],
      ['urlsafe/noncanonical', { ...response(), content: '__4=' }],
      ['excess padding', { ...response(), content: '//4A==' }],
      ['wrong bytes', { ...response(), content: Buffer.from([1, 2, 3]).toString('base64') }],
      ['reported truncation', { ...response(), truncated: true }],
      ['too large', { ...response({ size_bytes: 8 * 1024 * 1024 + 1 }) }],
      ['missing digest', { ...response({ sha256: '' }) }],
    ]
    for (const [label, raw] of changes) {
      if (label === 'reported truncation') {
        expect(() => artifactFrom(raw, { ...scope(), encoding: 'base64' })).toThrow('truncated:false')
        continue
      }
      const parsed = artifactFrom(raw, { ...scope(), ...(label === 'too large' ? { sizeBytes: 8 * 1024 * 1024 + 1 } : {}), ...(label === 'missing digest' ? { sha256: undefined } : {}), encoding: 'base64' })
      await expect(verifyArtifactBytes(parsed.content, parsed.metadata, parsed.truncated), label).rejects.toThrow()
    }
  })

  it('rejects nonzero pad bits that atob can ignore, and altered/unnecessarily padded three-byte forms', async () => {
    for (const [canonical, noncanonical, raw] of [
      ['/w==', '/x==', Buffer.from([0xff])],
      ['//4=', '//5=', Buffer.from([0xff, 0xfe])],
      ['//4A', '//4A=', bytes],
    ] as const) {
      assertCanonicalExample(canonical, raw)
      const metadata = { artifact_id: 'fixture-tail', sha256: createHash('sha256').update(raw).digest('hex'), size_bytes: raw.length }
      const file = await verifyArtifactBytes(canonical, metadata, false)
      expect([...file.bytes]).toEqual([...raw])
      assertCanonicalExample(noncanonical, raw)
      await expect(verifyArtifactBytes(noncanonical, metadata, false)).rejects.toThrow()
    }
    await expect(verifyArtifactBytes('//5A', { artifact_id: 'changed-byte', sha256: digest, size_bytes: 3 }, false)).rejects.toThrow('SHA-256')
  })

  it('requires a literal untruncated response for bytes without loosening ordinary text parsing', async () => {
    for (const value of [undefined, null, 'false', true, 0, {}]) {
      const raw = { ...response(), truncated: value }
      expect(() => artifactFrom(raw, { ...scope(), encoding: 'base64' })).toThrow('truncated:false')
    }
    expect(artifactFrom({ ...response(), encoding: 'utf8', truncated: null }, scope()).encoding).toBe('utf8')
    await expect(verifyArtifactBytes(base64, { artifact_id: 'missing-flag', size_bytes: 3, sha256: digest }, undefined)).rejects.toThrow()
  })

  it('never treats a filename/content-type as execution/path authority and requires actual browser crypto', async () => {
    const parsed = artifactFrom(response({ name: '../raw\\name\r\n?.txt', storage_name: 'route-is-not-for-download', media_type: 'text/plain\r\ninvalid' }), { ...scope(), encoding: 'base64' })
    const file = await verifyArtifactBytes(parsed.content, parsed.metadata, parsed.truncated)
    expect(file.mediaType).toBe('application/octet-stream')
    expect(file.filename).toBe('.._raw_name_.txt')
    expect(file.filename.includes('/')).toBe(false)
    expect(file.filename.includes('\\')).toBe(false)
    expect(file.filename.includes('\r')).toBe(false)
    const withoutCrypto = artifactFrom(response(), { ...scope(), encoding: 'base64' })
    const original = globalThis.crypto
    vi.stubGlobal('crypto', {})
    await expect(verifyArtifactBytes(withoutCrypto.content, withoutCrypto.metadata, withoutCrypto.truncated)).rejects.toThrow('SHA-256')
    vi.stubGlobal('crypto', original)
    const emptyName = artifactFrom(response({ name: '..' }), { ...scope(), encoding: 'base64' })
    expect((await verifyArtifactBytes(emptyName.content, emptyName.metadata, emptyName.truncated)).filename).toBe('artifact-artifact-a.bin')
    const boundaryName = `A${'📦'.repeat(80)}`
    const unicodeName = artifactFrom(response({ name: boundaryName }), { ...scope(), encoding: 'base64' })
    const unicodeFile = await verifyArtifactBytes(unicodeName.content, unicodeName.metadata, unicodeName.truncated)
    expect(new TextEncoder().encode(unicodeFile.filename).length).toBeLessThanOrEqual(240)
    expect(Array.from(unicodeFile.filename).at(-1)).toBe('📦')
    expect(unicodeFile.filename.endsWith('�')).toBe(false)
    expect([...unicodeFile.bytes]).toEqual([...bytes])
  })
})

async function workspaceFixture() {
  vi.resetModules()
  const seed = (id: string) => ({
    id, artifactId: `artifact-${id}`, nodeId: `node-${id}`, assignmentId: `assignment-${id}`,
    objective: 'download fixture', artifactName: 'owned-output.bin',
  })
  const a = seed('ticket-a')
  const b = seed('ticket-b')
  const ticketFor = (model: typeof a) => ({
    id: model.id, project_id: 'owned-project', objective: model.objective, kind: 'read_summary',
    relative_path: 'input.txt', status: 'succeeded', attempt: 1,
    artifacts: [{ artifact_id: model.artifactId, ticket_id: model.id, assignment_id: model.assignmentId,
      origin_node_id: model.nodeId, sha256: digest, size_bytes: 3, name: model.artifactName, media_type: 'application/octet-stream' }],
    assignments: [], reports: [], effects: [],
  })
  const calls: string[] = []
  let resolvePending!: (body: Response) => void
  let delayed = false
  const pending = new Promise<Response>(resolve => { resolvePending = resolve })
  const fetcher: typeof globalThis.fetch = vi.fn(async input => {
    const url = new URL(String(input), 'http://fixture.invalid')
    calls.push(String(input))
    if (url.pathname === '/api/v1/preferences') return jsonResponse({ expanded: false, sender_filter: null })
    if (url.pathname.endsWith('/audit')) return jsonResponse({ audit: [] })
    if (url.pathname === '/api/v1/tickets/ticket-a') return jsonResponse(ticketFor(a))
    if (url.pathname === '/api/v1/tickets/ticket-b') return jsonResponse(ticketFor(b))
    if (url.pathname === `/api/v1/tickets/ticket-a/artifacts/${a.artifactId}`) {
      if (delayed) return pending
      return expectedDownload(a)
    }
    return jsonResponse({ error: { code: 'no_fixture', message: 'No fixture' } }, 404)
  }) as typeof globalThis.fetch
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('window', { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  const workspace = await import('../src/state/workspace')
  workspace.useWorkspace().state.credentialState = 'valid'
  return { workspace, state: workspace.useWorkspace().state, a, b, calls,
    delay: () => { delayed = true; return { resolve: (body: Response) => resolvePending(body) } },
    resolve: (body: Response) => resolvePending(body), response: jsonResponse }
}
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function expectedDownload(model: Awaited<ReturnType<typeof workspaceFixture>>['a']) {
  return jsonResponse(response({ ticket_id: model.id, id: model.artifactId, assignment_id: model.assignmentId, origin_node_id: model.nodeId, name: model.artifactName }))
}

describe('a state download preserves its originating snapshot independently of text display', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules() })

  it('requests base64 explicitly and does not write the ordinary text cache or error', async () => {
    const fixture = await workspaceFixture()
    const { workspace, state, a, calls } = fixture
    const click = vi.fn()
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({ href: '', download: '', rel: '', style: {}, click, remove: vi.fn() })),
      body: { appendChild: vi.fn() },
    })
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-response')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    await workspace.selectTicket(a.id)
    state.errors[`artifact:${a.artifactId}`] = 'Cannot show these bytes as plain text'
    const result = await workspace.downloadArtifact(a.id, state.ticket!.artifacts![0] as ArtifactRef)
    expect(result?.sha256).toBe(digest)
    expect(calls.some(url => url.endsWith(`/artifacts/${a.artifactId}?encoding=base64`))).toBe(true)
    expect(state.artifacts[a.artifactId]).toBeUndefined()
    expect(state.errors[`artifact:${a.artifactId}`]).toBe('Cannot show these bytes as plain text')
    expect(click).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('cannot emit an old Ticket file after a deferred response arrives for a new selection', async () => {
    const fixture = await workspaceFixture()
    const { workspace, state, a, b } = fixture
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:forbidden-late-response')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const documentCreate = vi.fn(() => ({ href: '', download: '', rel: '', style: {}, click: vi.fn(), remove: vi.fn() }))
    vi.stubGlobal('document', { createElement: documentCreate, body: { appendChild: vi.fn() } })
    await workspace.selectTicket(a.id)
    const delayed = fixture.delay()
    const pendingDownload = workspace.downloadArtifact(a.id, state.ticket!.artifacts![0] as ArtifactRef)
    await vi.waitFor(() => expect(state.busy[`artifact-download:${a.artifactId}`]).toBe(true))
    await workspace.selectTicket(b.id)
    delayed.resolve(expectedDownload(a))
    expect(await pendingDownload).toBeNull()
    expect(state.selectedTicketId).toBe(b.id)
    expect(documentCreate).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
    expect(revoke).not.toHaveBeenCalled()
    expect(state.errors[`artifact-download:${a.artifactId}`]).toContain('已切换Ticket')
    expect(state.artifacts[a.artifactId]).toBeUndefined()
  })
})

describe('a browser download only uses a temporary user-authorized byte URL', () => {
  beforeEach(() => {
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({ href: '', download: '', rel: '', style: {}, click: vi.fn(), remove: vi.fn() })),
      body: { appendChild: vi.fn() },
    })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it('hands exact digested bytes to a short-lived download and revokes the URL', async () => {
    const file = await verifyArtifactBytes(base64, { artifact_id: 'a', name: 'raw.txt', size_bytes: 3, sha256: digest }, false)
    const blobs: Blob[] = []
    const created = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
      if (!(blob instanceof Blob)) throw new Error('The fixture expected a byte Blob, not an executable MediaSource')
      blobs.push(blob)
      return 'blob:fixture-artifact'
    })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    handOffArtifactDownload(file)
    expect(blobs).toHaveLength(1)
    expect(blobs[0].type).toBe('application/octet-stream')
    expect([...new Uint8Array(await blobs[0].arrayBuffer())]).toEqual([...bytes])
    expect(created).toHaveBeenCalledTimes(1)
    expect(revoke).toHaveBeenCalledWith('blob:fixture-artifact')
    expect(document.body.appendChild).toHaveBeenCalledWith(expect.objectContaining({ download: 'raw.txt', href: 'blob:fixture-artifact' }))
  })

  it('revokes the URL even if the actual click fails', async () => {
    const file = await verifyArtifactBytes(base64, { artifact_id: 'a', name: 'raw.txt', size_bytes: 3, sha256: digest }, false)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('http://unrelated.invalid/path')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    expect(() => handOffArtifactDownload(file)).toThrow()
    expect(revoke).toHaveBeenCalledWith('http://unrelated.invalid/path')
  })
})
