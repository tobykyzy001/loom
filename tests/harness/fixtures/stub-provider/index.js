import { appendFile, open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { installAckResponseLoss } from './ack-recovery.js'
export { registerScopedCodeTools, CODE_FIXTURE_SOURCE, CODE_FIXTURE_TEST, CODE_SOURCE_PATH, CODE_TEST_PATH } from './code-tools.js'

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
  async listModels(provider) {
      await this.record({ type: 'models-listed', provider })
      return [{ provider, id: 'loom-stub-v1', name: 'Loom deterministic stub', inputModalities: ['text'] }]
  }
  async resolveModel(provider, model) {
      await this.record({ type: 'model-resolved', provider, model })
      return { provider, id: model, name: 'Loom deterministic stub', inputModalities: ['text'], context: { contextWindow: 131072 } }
  }
  async prepareCall(provider, model, signal) {
    await this.record({ type: 'model-prepared', provider, model })
    return super.prepareCall(provider, model, signal)
  }
  record(value) {
    const file = this.config.control_path
    // Strictly bounded synthetic control log only. Awaiting fs.promises during
    // this Electron SDK's startup could leave SDK initialize shutdown-sensitive;
    // direct completion of this test write ensures response scheduling never
    // depends on an extra event-loop turn. This is not model/network I/O.
    appendFileSync(file, JSON.stringify({ ...value, provider: 'loom-stub', live_llm: false }) + '\n', { mode: 0o600 })
  }
  async *stream(options) {
    const id = `loom-stub-${++this.serial}`
    const history = []
    const toolCalls = []
    for (const message of options.messages) {
      for (const block of message.content || []) {
        if (block.type === 'text') history.push({ role: message.role, text: block.text, source: message.source })
        if (message.role === 'tool') history.push({ role: message.role, toolCallId: message.toolCallId || message.source?.callId,
          source: message.source, content: message.content })
        if (block.type === 'tool-call') toolCalls.push(block.name)
      }
    }
    await this.record({ type: 'request', id, session_id: options.sessionId || '', call_count: history.length, tool_calls: toolCalls })
    // Declared scoped names, never user controls outside the approved fixture.
    if (this.serial > 40) throw new Error('Fixture model-call budget exceeded; refusing an unproductive repeated-tool loop')
    const text = history.map((entry) => entry.text || '').join('\n')
    // The SDK appends a runtime-context user snapshot on its tool followup. For
    // this adapter, "latestUser" is the latest actual Loom caller's text rather
    // than replacing a scoped trigger with that internal snapshot.
    const latestUser = history.filter((entry) => entry.role === 'user' && entry.source?.kind === 'loom').at(-1)?.text || ''
    const block = () => ({ type: 'block-start', index: 0, blockType: 'text' })
    const finish = () => ({ type: 'finish', reason: { kind: 'stop' } })
    const textResponse = (value, note = 'ordinary assistant text from the real DSH loop; no live LLM') => [
      block(), { type: 'text-delta', index: 0, text: value },
      { type: 'block-end', index: 0, block: { type: 'text', text: value } },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      { type: 'provider-note', note }, finish(),
    ]
    const toolResponse = (name, parameters, suffix = id) => [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: `${name}-${suffix}`, name, argumentsDelta: parameters },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: `${name}-${suffix}`, name, arguments: parameters } },
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
      { type: 'tool-declaration-check', declared: (options.tools || []).some((tool) => tool.name === name), name },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
    const postEditTurnError = latestUser.includes('LOOM_FIXTURE_CODE_TOOL_ERROR_AFTER_EDIT')
      && toolCalls.includes('loom_fixture_code_edit')
    const editResultForDiagnostic = history.findLast(entry => entry.role === 'tool' && entry.toolCallId?.startsWith('loom_fixture_code_edit-'))
    await this.record({
      type: 'request-diagnostic', id, session_id: options.sessionId || '',
      latest_user_marker: latestUser.includes('LOOM_FIXTURE_CODE_TOOL_ERROR_AFTER_EDIT'),
      history_marker: text.includes('LOOM_FIXTURE_CODE_TOOL_ERROR_AFTER_EDIT'),
      post_edit_turn_error: postEditTurnError,
      latest_user_role: history.filter(entry => entry.role === 'user').at(-1)?.role ?? null,
      tool_calls: toolCalls,
      edit_result_tool_call_id: editResultForDiagnostic?.toolCallId || null,
      edit_result_source_call_id: editResultForDiagnostic?.source?.callId || null,
      edit_result_has_fixed_error_text: JSON.stringify(editResultForDiagnostic || null).includes('LOOM fixture edit outcome unavailable after file replacement'),
    })
    let chunks
    if (postEditTurnError) {
      const result = history.findLast(entry => entry.role === 'tool' && entry.toolCallId?.startsWith('loom_fixture_code_edit-'))
      if (!result || !JSON.stringify(result).includes('LOOM fixture edit outcome unavailable after file replacement')) {
        throw new Error('The scoped failure requires an actual SDK error result from the already-completed source edit')
      }
      chunks = textResponse('The source edit callback failed after replacement; no completed verification can be inferred.')
    } else if (options.purpose) {
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
    } else if (text.includes('LOOM_FIXTURE_CODE_TASK')) {
      // The two ordinary ToolCalls derive solely from the trigger and prior real
      // edit result. No controlled central file effect replaces SDK execution.
      if (!toolCalls.includes('loom_fixture_code_edit')) {
        chunks = toolResponse('loom_fixture_code_edit', JSON.stringify({ path: 'src/calc.js' }))
      } else if (!toolCalls.includes('loom_fixture_verify')) {
        const editResult = history.findLast((entry) => entry.role === 'tool' && entry.toolCallId?.startsWith('loom_fixture_code_edit-'))
          || history.filter((entry) => entry.role === 'tool').at(-1)
        const rendered = JSON.stringify(editResult?.content || [])
        let edit
        // Public ToolExecutionResult carries canonical `value` plus rendered content.
        try {
          const block = editResult?.content?.find?.((item) => item?.type === 'text')
          edit = editResult?.value || JSON.parse(block?.text || '{}')
          if (edit.schema !== 'loom.fixture-code-edit.v1' || edit.path !== 'src/calc.js' || edit.created !== true
            || !Number.isInteger(edit.baseline_test_exit_code) || edit.next_tool !== 'loom_fixture_verify') throw new Error('incomplete real edit result')
        } catch {
          try { edit = JSON.parse(rendered.match(/(\{[^{}]*"schema"\s*:\s*"loom\.fixture-code-edit\.v1"[^{}]*\})/)?.[1] || '{}') } catch { edit = null }
        }
        if (edit?.next_tool !== 'loom_fixture_verify' || !/^[0-9a-f]{64}$/.test(edit?.sha256 || '')) throw new Error('The code fixture requires the complete actual successful edit result')
        chunks = toolResponse('loom_fixture_verify', JSON.stringify({ path: edit.path, sha256: edit.sha256 }))
      } else {
        chunks = textResponse(`Observed real code verification: ${JSON.stringify(history.filter((entry) => entry.role === 'tool').at(-1)?.content || [])}`)
      }
    } else if (text.includes('LOOM_FIXTURE_DELEGATE') && !toolCalls.includes('loom_fixture_delegate_write')) {
      // A specific delegated fixture takes priority over the generic ORBITAL
      // inspect trigger, even though the parent instructed that observation.
      const parameters = '{}'
      chunks = [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: `loom-delegate-${id}`, name: 'loom_fixture_delegate_write', argumentsDelta: parameters },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: `loom-delegate-${id}`, name: 'loom_fixture_delegate_write', arguments: parameters } },
        { type: 'tool-declaration-check', declared: (options.tools || []).some((tool) => tool.name === 'loom_fixture_delegate_write') },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
    } else if (/LOOM_FIXTURE_FILE_WRITE/i.test(text) && !toolCalls.includes('loom_fixture_write')) {
      const parameters = JSON.stringify({ path: 'demo.html', title: 'Loom verifier portal' })
      chunks = [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: `loom-fixture-write-${id}`, name: 'loom_fixture_write', argumentsDelta: parameters },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: `loom-fixture-write-${id}`, name: 'loom_fixture_write', arguments: parameters } },
        { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        { type: 'tool-declaration-check', declared: (options.tools || []).some((tool) => tool.name === 'loom_fixture_write') },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
    } else if (/LOOM_FIXTURE_TRAVERSAL/i.test(text) && !toolCalls.includes('loom_fixture_write')) {
      const parameters = JSON.stringify({ path: '../escape.html', title: 'Must not be written' })
      chunks = [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: 'loom-fixture-invalid-write', name: 'loom_fixture_write', argumentsDelta: parameters },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'loom-fixture-invalid-write', name: 'loom_fixture_write', arguments: parameters } },
        { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
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
    } else if (text.includes('LOOM_FIXTURE_DELEGATE') && history.some((entry) => entry.role === 'tool' && entry.content)) {
      const result = history.filter((entry) => entry.role === 'tool').at(-1)
      chunks = result.role === 'tool' && result.content.some((block) => JSON.stringify(block).includes('Verified delegated Agent'))
        ? textResponse('The child Agent observed the verified delegated HTML artifact result.')
        : (() => { throw new Error('The delegated child used the wrong fixture tool; no file effect can be claimed from this branch') })()
    } else if (history.some((entry) => entry.role === 'tool' && entry.content)) {
      const result = history.filter((entry) => entry.role === 'tool').at(-1)
      let inspected
      try { inspected = JSON.parse(result.content.find((block) => block.type === 'text')?.text || '{}') } catch { inspected = null }
      if (text.includes('LOOM_FIXTURE_ECHO_SOURCE')) {
        // Deliberately repeat private fixture content inside the actual SDK
        // Session. A correct public read projection must not upload this echo.
        const bytes = await readFixtureSource(this.config.project_root, options.signal)
        chunks = textResponse(`Synthetic private assistant echo: ${bytes.bytes.toString('utf8')}`)
      } else if (inspected?.schema === 'loom.fixture-read.v1' && inspected.read === true) {
        chunks = textResponse(inspected.path === 'docs/input.txt'
          ? `Observed actual controlled parent projection: ${JSON.stringify(result.content)}`
          : 'Observed the fixed input.txt source read and its public digest; original source bytes remain private.')
      } else if (inspected?.schema === 'loom.fixture-probe-write.v1' && inspected.probe_write === true) {
        // Preserve the old observable probe marker without disclosing caller text.
        chunks = textResponse('Observed actual controlled tool result for the fixed artifact.txt write probe.')
      } else chunks = textResponse('The controlled fixture ToolResult did not match a permitted public source/probe shape.')
    } else if (text.includes('ORBITAL-731') || /LOOM_FIXTURE_(?:READ|WRITE|RESUME)/i.test(latestUser) || /^(?:读取|阅读|总结)[\s]+/.test(latestUser)) {
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
    if (postEditTurnError) throw new Error('LOOM fixture terminal error after the uncertain source-edit ToolResult')
  }
}

export const inject = ['llm', 'tools']
export const Config = z.object({ control_path: z.string().default(''), project_root: z.string().default('') })

function semanticHtml(title) {
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${title}</title></head>\n<body><main><h1>${title}</h1><p>Generated by an explicitly authorized Loom fixture tool.</p></main></body>\n</html>\n`
}

/** One fixed real source; its bytes are never included in a ToolResult/log. */
async function readFixtureSource(configuredRoot, signal, relativePath = 'input.txt') {
  if (!['input.txt', 'docs/input.txt'].includes(relativePath)) throw new Error('Only two explicitly owned fixture source paths are supported')
  const root = await realpath(configuredRoot)
  let source
  try {
    const scope = relativePath === 'docs/input.txt' ? 'docs' : ''
    if (scope && await realpath(join(root, scope)) !== join(root, scope)) throw new Error('Delegated fixture docs must be a real non-symlink directory')
    const file = join(root, scope, 'input.txt')
    // This direct child check also rejects a replaced symlink before hashing.
    if (await realpath(file) !== file) throw new Error('Loom fixture source must not be a symlink')
    source = await open(file, 'r')
    const stat = await source.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error('Loom fixture source must be one ordinary file within 4 KiB')
    const bytes = await source.readFile()
    throwIfAborted(signal)
    if (bytes.length !== stat.size) throw new Error('Loom fixture source changed during its bounded read')
    return { bytes }
  } finally {
    await source?.close().catch(() => {})
  }
}

export function apply(ctx, config) {
  const delegatedDocs = process.env.LOOM_FIXTURE_DELEGATION_TOOLS === 'scoped_fixture'
  const controlPath = resolve(config.control_path || '')
  if (!isAbsolute(config.control_path || '') || !controlPath.startsWith(sep) || controlPath === sep || !controlPath.includes('loom-dsh-')) {
    throw new Error('The disposable Stub requires a control_path inside a test-owned /tmp/loom-dsh-* root')
  }
  // Synchronous test setup: SDK initialize can be observed before an async
  // effect or an awaited directory operation. Publish adapters now, with one
  // owner and disposer, never during a later loader promotion step.
  mkdirSync(dirname(controlPath), { recursive: true, mode: 0o700 })
  const registration = ctx.llm.registerAdapter(['loom-stub'], new DeterministicAdapter({ ...config, control_path: controlPath }))
  const inspectRegistration = ctx.tools.register({
    name: 'loom_fixture_inspect',
    description: 'Read only the authorized input.txt fixture; alternatively create its controlled artifact.txt probe. Returns public hashes and byte sizes, never source bytes.',
    parameters: {
      type: 'object',
      required: ['mode', 'relative_path'],
      properties: {
        mode: { type: 'string', enum: ['read', 'write'] },
        relative_path: { type: 'string', enum: ['input.txt', 'artifact.txt'] },
        text: { type: 'string', maxLength: 4096 },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object', required: ['schema', 'path', 'sha256', 'size_bytes'],
        properties: {
          schema: { type: 'string', enum: ['loom.fixture-read.v1', 'loom.fixture-probe-write.v1'] },
          path: { type: 'string' }, sha256: { type: 'string' }, size_bytes: { type: 'integer' },
          read: { type: 'boolean' }, probe_write: { type: 'boolean' },
          project_code: { type: 'string', enum: ['ORBITAL-731'] }, synthetic_only: { type: 'boolean', enum: [true] },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      const inputs = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
      const { mode, relative_path: path, text } = inputs
      if (mode === 'write') {
        // Existing scoped argument probes retain their write-only semantics. They
        // do not become a source read or a broader file-writing authority.
        if (path !== 'artifact.txt' || typeof text !== 'string' || !/^Fixture artifact [A-Za-z0-9._-]+\n$/.test(text)
          || Buffer.byteLength(text) > 4096 || Object.keys(inputs).length !== 3) {
          throw new Error('Loom fixture arguments permit only the bounded artifact.txt write probe')
        }
        throwIfAborted(exec.signal)
        const configured = resolve(config.project_root || '')
        if (!isAbsolute(config.project_root || '') || !configured.includes('loom-dsh-')) throw new Error('Fixture project root must be an authorized isolated directory')
        const root = await realpath(configured)
        const file = resolve(root, path)
        if (dirname(file) !== root) throw new Error('Resolved fixture write escaped its project')
        const bytes = Buffer.from(text, 'utf8')
        const temporary = join(root, `.loom-fixture-${randomUUID()}.tmp`)
        try {
          await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
          throwIfAborted(exec.signal)
          await rename(temporary, file)
        } finally { await rm(temporary, { force: true }).catch(() => {}) }
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        await appendFile(controlPath, JSON.stringify({ type: 'tool-execute', name: 'loom_fixture_inspect', path, sha256, size_bytes: bytes.length }) + '\n', { mode: 0o600 })
        return { schema: 'loom.fixture-probe-write.v1', path, sha256, size_bytes: bytes.length, probe_write: true }
      }
      if (mode !== 'read' || path !== 'input.txt' || Object.keys(inputs).length !== 2) throw new Error('Loom fixture read accepts only mode=read and relative_path=input.txt')
      throwIfAborted(exec.signal)
      const configured = resolve(config.project_root || '')
      if (!isAbsolute(config.project_root || '') || !configured.includes('loom-dsh-')) throw new Error('Fixture project root must be an authorized isolated directory')
      const { bytes } = await readFixtureSource(configured, exec.signal, delegatedDocs ? 'docs/input.txt' : 'input.txt')
      if (delegatedDocs && !bytes.toString('utf8').includes('ORBITAL-731')) throw new Error('The legacy delegation fixture requires its declared synthetic fact')
      const result = delegatedDocs
        ? { schema: 'loom.fixture-read.v1', path: 'docs/input.txt', sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length, read: true,
          project_code: 'ORBITAL-731', synthetic_only: true }
        : { schema: 'loom.fixture-read.v1', path, sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length, read: true }
      await appendFile(controlPath, JSON.stringify({ type: 'tool-execute', name: 'loom_fixture_inspect', ...result }) + '\n', { mode: 0o600 })
      return result
    },
  })
  const writeRegistration = ctx.tools.register({
    name: 'loom_fixture_write',
    description: 'Create one small semantic HTML page at an authorized fixture project root. This is a test-owned editor, not generic filesystem access.',
    parameters: {
      type: 'object',
      required: ['path', 'title'],
      properties: {
        path: { type: 'string', enum: ['demo.html', '../escape.html'], description: 'The fixture permits only demo.html; other paths are deliberately rejected.' },
        title: { type: 'string', enum: ['Loom verifier portal', 'Must not be written'], description: 'Fixed synthetic HTML title, not user private content.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object', required: ['created', 'path', 'sha256', 'size_bytes', 'title'],
        properties: { created: { type: 'boolean' }, path: { type: 'string' }, sha256: { type: 'string' }, size_bytes: { type: 'integer' }, title: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      presentationMeta: (_args, value) => ({ fixture_bounded_write: true, sha256: value.sha256, size_bytes: value.size_bytes }),
    },
    execute: async (args, exec) => {
      const inputs = args && typeof args === 'object' ? args : {}
      const { path, title } = inputs
      if (path !== 'demo.html' || title !== 'Loom verifier portal') throw new Error('Loom fixture write is limited to demo.html with its synthetic title')
      throwIfAborted(exec.signal)
      const configured = resolve(config.project_root || '')
      if (!isAbsolute(config.project_root || '') || !configured.includes('loom-dsh-')) throw new Error('Fixture project root must be an authorized isolated directory')
      const root = await realpath(configured)
      const file = resolve(root, 'demo.html')
      if (dirname(file) !== root || (file !== root && !file.startsWith(root + sep))) throw new Error('Resolved file escaped fixture project')
      const bytes = Buffer.from(semanticHtml(title), 'utf8')
      if (bytes.length > 4096) throw new Error('Fixture file exceeds the strict 4 KiB limit')
      const temporary = join(root, `.loom-fixture-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' })
        throwIfAborted(exec.signal)
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }).catch(() => {}) }
      const result = { created: true, path: 'demo.html', sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length, title }
      await appendFile(controlPath, JSON.stringify({ type: 'tool-execute', name: 'loom_fixture_write', result }) + '\n', { mode: 0o600 })
      return result
    },
  })
  installAckResponseLoss({ control_path: controlPath })
  return () => { registration(); inspectRegistration(); writeRegistration() }
}
