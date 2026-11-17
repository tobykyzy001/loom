import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { LoomHttpClient as SharedHttp } from '../../packages/node-client/src/http.js'
import { LoomHttpClient as VendoredHttp } from '../../plugins/dsh-loom/src/http.js'

const baseRoute = '/api/v1/nodes/challenge'
const results = []
let server, address
const sockets = new Set()
const observations = []

// Node's default HTTP agent can retain idle connections. Opt only this owned
// loopback fixture into standard HTTP Connection: close, with no global dispatcher changes.
const transport = (url, options) => globalThis.fetch(url, {
  ...options, headers: { ...options.headers, connection: 'close' },
})

// Local-only fixture. It never discovers other machines or touches a user profile.
async function startFixture() {
  server = createServer((req, res) => { handle(req, res).catch(error => {
    try { res.writeHead(500); res.end('fixture handler error') } catch { /* Client disconnect is not a central Ticket outcome. */ }
    observations.push({ kind: 'handler_error', message: error.message.slice(0, 120) })
  }) })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  address = `http://127.0.0.1:${server.address().port}`
}

async function handle(request, response) {
  const chunks = []
  for await (const chunk of request) {
    chunks.push(chunk)
    if (Buffer.concat(chunks).length > 8192) {
      response.writeHead(413, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(request.url, baseRoute)
  assert.equal(payload.protocol, 'loom.node.v1')
  const wroteHeader = Promise.withResolvers()
  let closed = Promise.withResolvers()
  let ended = false
  let remaining = 0
  let timer
  const finish = () => {
    if (timer) clearTimeout(timer)
    closed.resolve({ case: payload.case, ended, remaining })
  }
  response.once('close', finish)
  response.on('error', () => {})
  if (payload.case === 'oversize') {
    const parts = [Buffer.from('{"fixture":"'), ...Array.from({ length: 16 }, (_, i) => Buffer.from(String(i).repeat(96))), Buffer.from('"}')]
    remaining = parts.length
    const write = () => {
      if (response.destroyed) return
      const part = parts.shift()
      if (part) {
        remaining--
        response.write(part)
        timer = setTimeout(write, 25)
      } else {
        ended = true
        response.end()
      }
    }
    response.writeHead(200, { 'content-type': 'application/json', 'x-looma-fixture-chunks': 'true' })
    write()
  } else if (payload.case === 'stall') {
    // The bytes are deliberately incomplete JSON. The reader cannot successfully parse them.
    response.writeHead(200, { 'content-type': 'application/json' })
    wroteHeader.resolve()
    response.write('{"assignment":')
    timer = setTimeout(() => {
      // This deadline closes the owned fixture even if an implementation forgets to stop.
      // It is not claimed to have returned an actual late assignment.
      ended = false
      response.destroy()
    }, 2000)
  } else {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ assignment: null }))
    ended = true
  }
  const closure = await closed.promise
  observations.push(closure)
  return wroteHeader.promise
}

async function closeFixture() {
  const closing = server
  const owned = [...sockets]
  for (const socket of owned) socket.destroy()
  if (server) {
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
  }
  assert.ok(owned.every(socket => socket.destroyed), 'Every socket owned by this fixture must actually be destroyed')
  server = null
  sockets.clear()
  if (closing) {
    assert.equal(closing.listening, false, 'The specific HTTP server referenced by this fixture must be truly closed')
  }
  assert.equal(sockets.size, 0, 'This fixture must not leave any owned socket alive')
}

async function stalledProbe(label, HttpClient, kind) {
  await closeFixture()
  await startFixture()
  try {
    const caller = new AbortController()
    const reason = new Error(`Caller stop for ${label}`)
    const pending = new HttpClient({ baseUrl: address, fetch: transport, timeoutMs: kind === 'caller' ? 2000 : 50 })
      .post(baseRoute, { protocol: 'loom.node.v1', case: 'stall' },
        { noAuth: true, ...(kind === 'caller' ? { signal: caller.signal } : {}) })
    const timer = kind === 'caller' ? setTimeout(() => caller.abort(reason), 50) : null
    await assert.rejects(pending, error => kind === 'caller' ? error === reason : error.message.includes('timed out'))
    if (timer) clearTimeout(timer)
    const initial = observations.filter(item => item.case === 'stall').length
    const deadline = Date.now() + 3000
    while (observations.filter(item => item.case === 'stall').length < initial + 1 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(observations.filter(item => item.case === 'stall').length, initial + 1,
      `${label}/${kind}: actual server-side connection closure must settle`)
    assert.equal(observations.at(-1).ended, false, 'An incomplete JSON prefix cannot become a valid assignment')
    return observations.at(-1)
  } finally { await closeFixture() }
}

async function runScenario(label, HttpClient) {
  const allowed = await new HttpClient({ baseUrl: address, fetch: transport }).post(baseRoute, { protocol: 'loom.node.v1', case: 'ok' }, { noAuth: true })
  assert.deepEqual(allowed, { assignment: null })

  await assert.rejects(
    new HttpClient({ baseUrl: address, fetch: transport, maxResponseBytes: 32 }).post(baseRoute,
      { protocol: 'loom.node.v1', case: 'oversize' }, { noAuth: true }),
    error => error.message.includes('exceeds configured limit'),
  )

  const callerResult = await stalledProbe(label, HttpClient, 'caller')
  const timeoutResult = await stalledProbe(label, HttpClient, 'timeout')
  assert.equal(callerResult.ended, false)
  assert.equal(timeoutResult.ended, false)

  return {
    implementation: label,
    normal_streamed_json: true,
    actual_bytes_oversize_refused: true,
    caller_abort_wakes_real_stalled_socket: true,
    actual_timeout_wakes_stalled_read: true,
    fixture_completed_socket_handlers: observations.filter(item => item.case && ['ok', 'oversize'].includes(item.case)).length,
    remaining_chunks_after_limited_read: observations.filter(item => item.case === 'oversize').reduce((sum, item) => sum + item.remaining, 0),
  }
}

try {
  for (const [label, Client] of [['shared', SharedHttp], ['vendored', VendoredHttp]]) {
    await startFixture()
    results.push(await runScenario(label, Client))
    await closeFixture()
  }
  assert.equal(observations.some(item => item.kind === 'handler_error'), false)
  assert.equal(observations.filter(item => item.case === 'stall').length, 4)
  console.log(JSON.stringify({ overall: 'PASS', schema: 'loom.http.socket-stream.v1', results,
    observations,
    scope: '127.0.0.1 ephemeral Node HTTP fixture, not physical remote/TLS or Compose',
    cleanup: 'Owned connections destroyed and listener closed', server_closed: true }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ overall: 'FAIL', error: String(error.stack || error), observations }, null, 2))
  process.exitCode = 1
} finally { await closeFixture() }
