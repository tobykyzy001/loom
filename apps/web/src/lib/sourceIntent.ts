import type { SourceEvent } from '../api/types'
import { safeRelativePath } from './format'

export interface SourceIntentDraft {
  relativePath: string
  grantId: string | null
}

export type SourceIntentResolution =
  | { kind: 'need-grant'; relativePath: string }
  | { kind: 'ready'; relativePath: string; grantId: string }
  | { kind: 'none'; reason: string }

// Kept in UTF-8 bytes, rather than UTF-16 units, for parity with source text storage bounds.
const MAX_SOURCE_TEXT_BYTES = 16 * 1024
const REQUEST = /^(读取|阅读|总结)(?:[\s]+)(.+)$/s
const GRANT = /^用 Grant ([A-Za-z0-9][A-Za-z0-9._:-]{0,159})$/

function none(reason: string): SourceIntentResolution {
  return { kind: 'none', reason }
}

function genuineUserEvent(event: SourceEvent): boolean {
  if (event === null || typeof event !== 'object') return false
  const candidate: Partial<SourceEvent> = event
  return typeof candidate.id === 'string' && candidate.id.length > 0
    && typeof candidate.source_id === 'string' && candidate.source_id.length > 0
    && typeof candidate.thread_id === 'string' && candidate.thread_id.length > 0
    && typeof candidate.client_thread_id === 'string' && candidate.client_thread_id.length > 0
    && typeof candidate.external_event_id === 'string' && candidate.external_event_id.length > 0
    && candidate.kind === 'user_message' && typeof candidate.content === 'string'
    && Number.isSafeInteger(candidate.source_sequence) && (candidate.source_sequence ?? -1) >= 0
    && Number.isSafeInteger(candidate.thread_sequence) && (candidate.thread_sequence ?? -1) >= 0
}

// This deliberately recognizes only the two bounded commands, not arbitrary Chinese intent.
function requestPath(text: string): string | null {
  const match = REQUEST.exec(text)
  if (!match) return null
  const candidate = match[2]
  const quoted = candidate.length >= 3
    && ((candidate.startsWith('"') && candidate.endsWith('"')) || (candidate.startsWith("'") && candidate.endsWith("'")))
  return quoted ? candidate.slice(1, -1) : candidate
}

function grantId(text: string): string | null {
  return GRANT.exec(text)?.[1] ?? null
}

function hasBoundedContent(text: string): boolean {
  if (text.length > MAX_SOURCE_TEXT_BYTES || !text.trim()) return false
  return new TextEncoder().encode(text).byteLength <= MAX_SOURCE_TEXT_BYTES
}

export function sourceIntentFromEvent(
  current: SourceEvent,
  availableGrantIds: string[],
  previousEvent?: SourceEvent,
): SourceIntentResolution {
  // Interpret only a trimmed copy. In particular, never replace current.content, the original objective.
  if (!genuineUserEvent(current)) return none('当前记录不是有效的 Source 用户消息，未解释或授权。')
  if (!hasBoundedContent(current.content)) return none('消息为空或超过 16 KiB，未进行意图解释。')
  const text = current.content.trim()

  if (previousEvent !== undefined) {
    if (!genuineUserEvent(previousEvent)) return none('上一条不是有效的 Source 用户消息，不能接管授权。')
    if (!hasBoundedContent(previousEvent.content)) return none('上一条消息为空或超过 16 KiB，未进行意图解释。')
    if (current.source_id !== previousEvent.source_id
      || current.thread_id !== previousEvent.thread_id
      || current.client_thread_id !== previousEvent.client_thread_id) {
      return none('两条消息不属于同一 Source 和 client thread，不能接续授权。')
    }
    if (current.id === previousEvent.id || current.external_event_id === previousEvent.external_event_id) {
      return none('两条消息没有不同的真实事件身份，不能接续授权。')
    }
    if (!Number.isSafeInteger(previousEvent.thread_sequence + 1)
      || current.thread_sequence !== previousEvent.thread_sequence + 1
      || current.source_sequence <= previousEvent.source_sequence) {
      return none('授权消息必须紧跟首句，且 Source 序号递增；不接受跳步或重排。')
    }

    const relativePath = requestPath(previousEvent.content.trim())
    if (relativePath === null) return none('上一条不是“读取 / 阅读 / 总结 + 明确路径”的首句，不能推断其路径。')
    if (!safeRelativePath(relativePath)) return none('上一条首句没有安全的项目相对文件路径，不能接续授权。')
    const selectedGrantId = grantId(text)
    if (selectedGrantId === null) return none('连续第二句只能是“用 Grant <完整ID>”；不接受其他指令或注入参数。')
    const matches = availableGrantIds.filter(id => id === selectedGrantId)
    if (matches.length === 0) return none('该 Grant 不在当前可用且唯一的精确 ID 列表中；不会猜测、扩展或自动选择授权。')
    if (matches.length !== 1) return none('可用 Grant ID 列表存在重复匹配，无法确认唯一授权，未继续。')
    return { kind: 'ready', relativePath, grantId: selectedGrantId }
  }

  const relativePath = requestPath(text)
  if (relativePath !== null) {
    if (!safeRelativePath(relativePath)) return none('请提供项目内安全的相对文件路径；拒绝绝对路径、反斜杠、空段和 ..。')
    // An available Grant, even exactly one, is never an implicit choice.
    return { kind: 'need-grant', relativePath }
  }
  if (grantId(text) !== null) return none('只有授权句而没有可核对的连续首句；请先明确读取 / 阅读 / 总结的相对路径。')
  return none('仅支持“读取 / 阅读 / 总结 <项目内相对路径>”及下一句“用 Grant <完整ID>”。')
}
