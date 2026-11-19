import { describe, expect, it, vi } from 'vitest'
import type { SourceEvent } from '../src/api/types'
import { sourceIntentFromEvent } from '../src/lib/sourceIntent'

const FIRST_CONTENT = '  \n读取 docs/input.txt\t '
const FIRST: SourceEvent = {
  id: 'source-event-1', source_id: 'src-exact', thread_id: 'internal-thread',
  client_thread_id: 'client-thread', external_event_id: 'external-1', kind: 'user_message',
  content: FIRST_CONTENT, source_sequence: 41, thread_sequence: 7, ticket_id: null, task_ticket_id: null,
}
const SECOND: SourceEvent = {
  ...FIRST, id: 'source-event-2', external_event_id: 'external-2',
  content: '用 Grant grn_reader.01', source_sequence: 42, thread_sequence: 8,
}

function resolve(current = SECOND, previous: SourceEvent = FIRST, ids = ['grn_reader.01']) {
  return sourceIntentFromEvent(current, ids, previous)
}

describe('bounded Source read intent', () => {
  it('starts a safe read with need-grant and preserves the raw objective byte-for-byte', () => {
    const original = FIRST.content
    const snapshot = { ...FIRST }
    expect(sourceIntentFromEvent(FIRST, [])).toEqual({ kind: 'need-grant', relativePath: 'docs/input.txt' })
    expect(FIRST.content).toBe(original)
    expect(FIRST.content).not.toBe(original.trim())
    expect(FIRST).toEqual(snapshot)
  })

  it('supports read/summarize synonyms, nested paths, and optional paired quotes', () => {
    const cases = [
      ['阅读 nested/input.txt', 'nested/input.txt'],
      ['总结 "reports/final notes.txt"', 'reports/final notes.txt'],
      [' 读取 \'input.txt\' ', 'input.txt'],
    ]
    for (const [content, relativePath] of cases) expect(sourceIntentFromEvent({ ...FIRST, content }, [])).toEqual({ kind: 'need-grant', relativePath })
  })

  it('never auto-selects a sole existing Grant on the first utterance', () => {
    expect(sourceIntentFromEvent(FIRST, ['grn_reader.01'])).toEqual({ kind: 'need-grant', relativePath: 'docs/input.txt' })
  })

  it('resolves only a consecutive, same-Source/thread, exact available Grant second utterance', () => {
    expect(resolve()).toEqual({ kind: 'ready', relativePath: 'docs/input.txt', grantId: 'grn_reader.01' })
  })

  it('does not mute or rewrite either frozen Source objective while interpreting it', () => {
    const first = { ...FIRST }
    const current = { ...SECOND }
    const ready = resolve(current, first)
    const repeated = resolve(current, first, ['different', 'grn_reader.01'])
    expect(ready).toMatchObject({ kind: 'ready', relativePath: 'docs/input.txt' })
    expect(repeated).toEqual(ready)
    expect(first.content).toBe(FIRST_CONTENT)
    expect(current.content).toBe('用 Grant grn_reader.01')
  })

  it('rejects a Grant-only utterance without a stored preceding read', () => {
    const result = sourceIntentFromEvent(SECOND, ['grn_reader.01'])
    expect(result.kind).toBe('none')
    expect(result).not.toHaveProperty('grantId')
    expect(result).not.toHaveProperty('relativePath')
    expect(result).toMatchObject({ reason: expect.stringContaining('没有可核对的连续首句') })
  })

  it('does not infer memory or invent a filename for bare commands, empty text, or arbitrary language', () => {
    for (const content of ['读取', '阅读', '总结', '读取   ', '读取 /tmp/input.txt', 'Project 自动选择', '']) {
      const result = sourceIntentFromEvent({ ...FIRST, content }, ['grn_reader.01'])
      expect(result.kind).toBe('none')
      expect(result).not.toHaveProperty('relativePath')
      expect(result).toMatchObject({ reason: expect.any(String) })
    }
  })

  it('rejects traversal, absolute paths, and injection-shaped filename bombs', () => {
    for (const content of ['读取 ../input.txt', '读取 /etc/passwd', '读取 ../../input.txt --grant=grn_reader.01', '读取 input.txt\u0000; rm -rf', '读取 C:\\秘密.txt']) {
      const result = sourceIntentFromEvent({ ...FIRST, content }, [])
      expect(result).toMatchObject({ kind: 'none', reason: expect.stringContaining('相对文件路径') })
    }
  })

  it('rejects shell flags and authority-looking tokens in the second utterance', () => {
    for (const content of [
      '用 Grant grn_reader.01 --request', '用 Grant grn_reader.01;执行代码', 'ddg code child',
      '用 Grant auto', '用 Grant ', '读取 docs/input.txt',
    ]) expect(resolve({ ...SECOND, content })).toMatchObject({ kind: 'none', reason: expect.any(String) })
  })

  it('rejects an unavailable Grant without selecting another, stripping a prefix, or guessing scope', () => {
    for (const ids of [[], ['grn_other'], ['RN_reader.01']]) {
      const result = resolve(SECOND, FIRST, ids)
      expect(result.kind).toBe('none')
      expect(result).not.toHaveProperty('grantId')
      expect(result).not.toHaveProperty('relativePath')
    }
  })

  it('rejects duplicate exact available IDs rather than falling back to the first one', () => {
    const result = resolve(SECOND, FIRST, ['grn_other', 'grn_reader.01', 'grn_reader.01'])
    expect(result).toMatchObject({ kind: 'none', reason: expect.stringContaining('重复') })
    expect(result).not.toHaveProperty('grantId')
  })

  it('keeps exact case and punctuation while rejecting invented Grant IDs', () => {
    expect(resolve({ ...SECOND, content: '用 Grant grn_reader.01 ' })).toMatchObject({ kind: 'ready', grantId: 'grn_reader.01' })
    for (const content of ['用 Grant GRN_reader.01', '用 Grant grn_reader', '用 Grant grn_reader.01 extra']) {
      const result = resolve({ ...SECOND, content })
      expect(result.kind).toBe('none')
    }
    expect(resolve({ ...SECOND, content: '用 Grant :grn_reader.01' })).toMatchObject({ kind: 'none' })
    expect(resolve({ ...SECOND, content: '用 Grant grn_reader.01:child' }, FIRST, ['grn_reader.01:child'])).toMatchObject({ kind: 'ready', grantId: 'grn_reader.01:child' })
    expect(resolve({ ...SECOND, content: ' 用 Grant grn_reader.01  ' })).toMatchObject({ kind: 'ready' })
  })

  it('rejects overlong Grant tokens using a bounded exact grammar', () => {
    const token = 'g' + 'r'.repeat(160)
    expect(token).toHaveLength(161)
    const result = resolve({ ...SECOND, content: `用 Grant ${token}` }, FIRST, [token])
    expect(result).toMatchObject({ kind: 'none', reason: expect.stringContaining('第二句') })
    expect(result).not.toHaveProperty('grantId')
    expect(resolve({ ...SECOND, content: `用 Grant g${'r'.repeat(159)}` }, FIRST, [`g${'r'.repeat(159)}`])).toMatchObject({ kind: 'ready' })
  })

  it('rejects different Source IDs or client threads even when sequences are consecutive', () => {
    const changes: Array<Partial<SourceEvent>> = [
      { source_id: 'src-other' }, { thread_id: 'internal-other' }, { client_thread_id: 'client-other' },
      { id: FIRST.id }, { external_event_id: FIRST.external_event_id },
    ]
    for (const change of changes) {
      const result = resolve({ ...SECOND, ...change })
      expect(result).toMatchObject({ kind: 'none', reason: expect.any(String) })
      expect(result).not.toHaveProperty('grantId')
    }
  })

  it('rejects equal, skipped, reversed, or reversed-source sequences', () => {
    const changes: Array<Partial<SourceEvent>> = [
      { thread_sequence: 7 }, { thread_sequence: 9 }, { thread_sequence: 6 },
      { thread_sequence: 8, source_sequence: 41 }, { thread_sequence: 8, source_sequence: 40 },
    ]
    for (const change of changes) expect(resolve({ ...SECOND, ...change })).toMatchObject({ kind: 'none', reason: expect.stringContaining('序号') })
  })

  it('rejects non-integer, negative, and unsafe sequence values', () => {
    const changes: Array<Partial<SourceEvent>> = [
      { thread_sequence: 7.5 }, { thread_sequence: -1 }, { thread_sequence: Number.MAX_SAFE_INTEGER },
      { source_sequence: 41.5 }, { source_sequence: -1 }, { source_sequence: Number.NaN },
    ]
    for (const change of changes) {
      const result = resolve({ ...SECOND, ...change })
      expect(result.kind).toBe('none')
      expect(result).toMatchObject({ reason: expect.stringMatching(/不是有效|序号/) })
    }
  })

  it('rejects malformed non-user or incomplete Source evidence instead of trusting typed fixtures', () => {
    const malformed = [
      { ...SECOND, kind: 'assistant_message' }, { ...SECOND, id: '' }, { ...SECOND, external_event_id: '' },
      { ...SECOND, client_thread_id: '' }, { ...SECOND, content: null }, { ...FIRST, source_id: '' },
    ]
    for (const event of malformed) expect(resolve(event as unknown as SourceEvent)).toMatchObject({ kind: 'none', reason: expect.stringContaining('不是有效') })
  })

  it('revalidates the previous raw first event: bad content or an unsafe path cannot authorize', () => {
    for (const first of [
      { ...FIRST, content: '读取 ../secret.txt' }, { ...FIRST, content: '用 Grant grn_reader.01' },
      { ...FIRST, content: 'Project 自动选择' }, { ...FIRST, content: 'x'.repeat(16 * 1024 + 1) },
    ]) {
      const result = resolve(SECOND, first)
      expect(result.kind).toBe('none')
      expect(result).not.toHaveProperty('grantId')
      expect(result).not.toHaveProperty('relativePath')
    }
  })

  it('is purely synchronous and bounded, with no fetch, side effects, or backtracking blowup', () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const originalSecond = { ...SECOND }
    const available = ['grn_reader.01']
    const tooLong = 'x'.repeat(16 * 1024 + 1)
    const result = sourceIntentFromEvent({ ...FIRST, content: tooLong }, [])
    expect(result).toMatchObject({ kind: 'none', reason: expect.stringMatching(/为空|16 KiB/) })
    expect(sourceIntentFromEvent({ ...FIRST, content: '读取 ' + 'a'.repeat(16_000) }, [])).toMatchObject({ kind: 'none' })
    expect(resolve({ ...SECOND, content: '用 Grant ' + 'a'.repeat(100_000) })).toMatchObject({ kind: 'none' })
    expect(resolve(SECOND, FIRST, available)).toMatchObject({ kind: 'ready' })
    expect(SECOND).toEqual(originalSecond)
    expect(available).toEqual(['grn_reader.01'])
    expect(fetch).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
