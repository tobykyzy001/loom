import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

const abortFailure = () => ({ code: 'ABORTED', message: 'Fixture provider cancelled by DSH.' })
function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason || Object.assign(new Error('Fixture provider cancelled'), { failure: abortFailure() })
}

/** A real in-process LlmAdapter. It never uses HTTP, credentials or a live model. */
class DeterministicAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
    this.serial = 0
    this.pending = new Set()
  }
  providerInfo(provider) { return { id: provider, name: 'Loom isolated fixture (no live LLM)' } }
  listModels(provider) {
    return Promise.resolve([{ provider, id: 'loom-stub-v1', name: 'Loom deterministic stub', inputModalities: ['text'] }])
  }
  resolveModel(provider, model) {
    return Promise.resolve({ provider, id: model, name: 'Loom deterministic stub', inputModalities: ['text'], context: { contextWindow: 131072 } })
  }
  async record(value) {
    const file = this.config.control_path
    await appendFile(file, JSON.stringify({ ...value, provider: 'loom-stub', live_llm: false }) + '\n', { mode: 0o600 })
  }
  async *stream(options) {
    const id = `loom-stub-${++this.serial}`
    const history = []
    const toolCalls = []
    for (const message of options.messages) {
      for (const block of message.content || []) {
        if (block.type === 'text') history.push({ role: message.role, text: block.text })
        if (message.role === 'tool') history.push({ role: message.role, callId: message.toolCallId || message.source?.callId, content: message.content })
        if (block.type === 'tool-call') toolCalls.push(block.name)
      }
    }
    await this.record({ type: 'request', id, session_id: options.sessionId || '', call_count: history.length, tool_calls: toolCalls })
    if (this.serial > 40) throw new Error('Fixture model-call budget exceeded; refusing an unproductive repeated-tool loop')
    const text = history.map((entry) => entry.text || '').join('\n')
    const latestUser = history.filter((entry) => entry.role === 'user').at(-1)?.text || ''
    const block = () => ({ type: 'block-start', index: 0, blockType: 'text' })
    const finish = () => ({ type: 'finish', reason: { kind: 'stop' } })
    const textResponse = (value, note = 'ordinary assistant text from the real DSH loop; no live LLM') => [
      block(), { type: 'text-delta', index: 0, text: value },
      { type: 'block-end', index: 0, block: { type: 'text', text: value } },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      { type: 'provider-note', note }, finish(),
    ]
    let chunks
    if (options.purpose) {
      chunks = textResponse('Loom isolated fixture')
    } else if (/LOOM_FIXTURE_CANCEL/i.test(text)) {
      await this.record({ type: 'hold', id })
      let release
      const pending = new Promise((ok) => { release = ok })
      this.pending.add(release)
      const aborted = () => release()
      options.signal?.addEventListener('abort', aborted, { once: true })
      await pending
      this.pending.delete(release)
      options.signal?.removeEventListener('abort', aborted)
      throwIfAborted(options.signal)
      chunks = textResponse('Unexpected release without cancellation')
    } else if (/LOOM_FIXTURE_RESUME/i.test(text)) {
      chunks = textResponse(toolCalls.includes('loom_fixture_inspect')
        ? 'The resumed Session reused loom_fixture_inspect and retained synthetic input ORBITAL-731.'
        : 'Missing actual history: the resumed request did not contain an earlier loom_fixture_inspect tool call.')
    } else if (/LOOM_FIXTURE_TOOL_ARGS/i.test(latestUser)) {
      const match = latestUser.match(/LOOM_FIXTURE_TOOL_ARGS\s+([A-Za-z0-9._-]+)/i)
      const args = JSON.stringify({ mode: 'write', relative_path: 'artifact.txt', text: `Fixture artifact ${match?.[1] || 'missing'}\n` })
      chunks = [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: 'loom-fixture-controlled-write', name: 'loom_fixture_inspect', argumentsDelta: args },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'loom-fixture-controlled-write', name: 'loom_fixture_inspect', arguments: args } },
        { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
    } else if (history.some((entry) => entry.role === 'tool' && entry.content)) {
      const result = history.filter((entry) => entry.role === 'tool').at(-1)
      chunks = textResponse(`Observed actual controlled tool result: ${JSON.stringify(result.content)}`)
    } else if (text.includes('ORBITAL-731') || /LOOM_FIXTURE_(?:READ|WRITE|RESUME)/i.test(latestUser)) {
      const args = JSON.stringify({ mode: 'read', relative_path: 'input.txt' })
      chunks = [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: 'loom-fixture-controlled-read', name: 'loom_fixture_inspect', argumentsDelta: args },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'loom-fixture-controlled-read', name: 'loom_fixture_inspect', arguments: args } },
        { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        { type: 'tool-declaration-check', declared: (options.tools || []).some((tool) => tool.name === 'loom_fixture_inspect') },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
    } else {
      chunks = textResponse(`Loom real DSH isolated Stub turn: ${latestUser.slice(0, 256)}`)
    }
    for (const chunk of chunks) {
      throwIfAborted(options.signal)
      if (chunk.type === 'provider-note' || chunk.type === 'tool-declaration-check') {
        await this.record(chunk)
        continue
      }
      yield chunk
      if (chunk.type === 'finish') await this.record({ type: 'finish', id, session_id: options.sessionId || '', reason: chunk.reason })
    }
  }
}

export const inject = ['llm', 'tools']
export const Config = z.object({ control_path: z.string().default('') })

export function apply(ctx, config) {
  const controlPath = resolve(config.control_path || '')
  if (!isAbsolute(config.control_path || '') || !controlPath.startsWith(sep) || controlPath === sep || !controlPath.includes('loom-dsh-')) {
    throw new Error('The disposable Stub requires a control_path inside a test-owned /tmp/loom-dsh-* root')
  }
  const prepared = mkdir(dirname(controlPath), { recursive: true, mode: 0o700 })
  ctx.effect(async () => {
    await prepared
    const registration = ctx.llm.registerAdapter(['loom-stub'], new DeterministicAdapter({ ...config, control_path: controlPath }))
    return () => registration()
  }, 'register zero-network fixture provider')
  const registration = ctx.tools.register({
    name: 'loom_fixture_inspect',
    description: 'Read only the synthetic fixture token ORBITAL-731. No filesystem, network, model or side effect.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', properties: { project_code: { type: 'string' }, synthetic_only: { type: 'boolean' } }, required: ['project_code', 'synthetic_only'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => {
      throwIfAborted(exec.signal)
      await appendFile(controlPath, JSON.stringify({ type: 'tool-execute', name: 'loom_fixture_inspect' }) + '\n', { mode: 0o600 })
      return { project_code: 'ORBITAL-731', synthetic_only: true }
    },
  })
  return registration
}
