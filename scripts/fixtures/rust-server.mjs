import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export function assertLoopback(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
    || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Automatic node configuration is restricted to a loopback HTTP Concierge without a remote path or credentials')
  }
  return url.origin
}
export function testingClientToken() { return randomBytes(24).toString('base64url') }
export async function testingRoot() { return mkdtemp(join(tmpdir(), 'loom-real-http-')) }
export async function prepareProject(root) {
  const project = join(root, 'project')
  await mkdir(project, { mode: 0o700 })
  await writeFile(join(project, 'input.txt'), 'Real isolated project input.\nNo LLM, DSH host or network model was called.\n', { mode: 0o600 })
  return realpath(project)
}
// A reserved port is closed before Loom binds it; this avoids a proxy or fixed-port collision.
async function availablePort() {
  const socket = createServer()
  await new Promise((ok, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', ok) })
  const port = socket.address().port
  await new Promise((ok) => socket.close(ok))
  return port
}
function commandWords(source) {
  const words = []; let word = ''; let quote = ''; let escaped = false
  for (const character of source) {
    if (escaped) { word += character; escaped = false; continue }
    if (character === '\\' && quote !== "'") { escaped = true; continue }
    if (quote) { if (character === quote) quote = ''; else word += character; continue }
    if (character === '"' || character === "'") { quote = character; continue }
    if (/\s/.test(character)) { if (word) { words.push(word); word = '' } } else word += character
  }
  if (quote || escaped) throw new Error('LOOM_SERVER_CMD has an unterminated quote or escape')
  if (word) words.push(word)
  if (!words.length || words.some((word) => /[\u0000-\u001f]/.test(word))) throw new Error('LOOM_SERVER_CMD must be a direct command, not a shell script')
  return words
}

/** A foreground child of this test. It is always terminated in finally, never installed as a service. */
export async function startRustConcierge({ env = process.env, root } = {}) {
  root ||= await testingRoot()
  const clientToken = env.LOOM_CLIENT_TOKEN || testingClientToken()
  if (clientToken.length < 24) throw new Error('The synthetic integration client token must have at least 24 characters')
  const dataDir = join(root, 'concierge')
  await mkdir(dataDir, { mode: 0o700 })
  let binary
  if (env.LOOM_SERVER_CMD) binary = commandWords(env.LOOM_SERVER_CMD)
  else if (env.LOOM_TARGET_BINARY) binary = [env.LOOM_TARGET_BINARY]
  else {
    // Never silently test the previous successful build after current edits.
    await promisify(execFile)('cargo', ['build', '--locked', '-p', 'loom-concierge', '--bin', 'loom'], { cwd: repository, timeout: 120000 })
    binary = [join(repository, 'target/debug/loom')]
  }
  const [executable, ...args] = binary
  const port = await availablePort()
  const log = []
  const child = spawn(executable, [...args, '--data-dir', dataDir, 'serve', '--listen', `127.0.0.1:${port}`], {
    cwd: repository, shell: false,
    env: { LOOM_CLIENT_TOKEN: clientToken, PATH: env.PATH || process.env.PATH, RUST_LOG: 'loom_concierge=warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let earlyExit = null
  child.once('exit', (code, signal) => { earlyExit = { code, signal } })
  child.once('error', (error) => { earlyExit = { message: error.message } })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
    log.push(String(chunk).replaceAll(clientToken, '[redacted-test-token]').slice(-24000))
    if (log.length > 40) log.splice(0, log.length - 40)
  })
  const origin = `http://127.0.0.1:${port}`
  let stopped = false
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (earlyExit) return
    const exited = new Promise((ok) => child.once('exit', ok))
    child.kill('SIGTERM')
    if (!await Promise.race([exited.then(() => true), new Promise((ok) => setTimeout(ok, 4000).unref())])) {
      child.kill('SIGKILL'); await exited
    }
  }
  const deadline = Date.now() + 120000
  try {
    while (Date.now() < deadline) {
      if (earlyExit) throw new Error(`Concierge exited before health became ready: ${JSON.stringify(earlyExit)}; ${log.join('').slice(-1600)}`)
      try {
        const response = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(1000) })
        if (response.ok) {
          const health = await response.json()
          if (health.status === 'ok') {
            return { baseUrl: origin, clientToken, external: false, dataDir, stop,
              command: { executable, args: [...args, '--data-dir', '<temporary>', 'serve', '--listen', `127.0.0.1:${port}`] } }
          }
        }
      } catch { /* health retry is only readiness, not an execution result */ }
      await new Promise((ok) => setTimeout(ok, 250))
    }
    throw new Error(`Timed out waiting for real Concierge health; ${log.join('').slice(-1600)}`)
  } catch (error) { await stop(); throw error }
}
