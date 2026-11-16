import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const PROTOCOL = 'loom.node.v1'
/** Tests and callers must explicitly choose an isolated root; never silently use HOME or cwd. */
export function requireIsolatedRoot(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('LOOM_STATE_DIR must explicitly name an isolated fixture directory')
  const resolved = resolve(value)
  if (!isAbsolute(value) || resolved === '/' || resolved === resolve(process.env.HOME || '__none__')) throw new Error('An explicit non-broad isolated absolute directory is required')
  // Absolute isolated path only; no broad default profile path is accepted.
  return resolved
}
export const id = () => randomUUID()
export const sha256 = (value) => createHash('sha256').update(value).digest('hex')
export const canonical = (value) => JSON.stringify(sort(value))
function sort(value) {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sort(value[key])]))
  }
  return value
}
export function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value
}
export function assertString(value, name) {
  if (typeof value !== 'string' || !value.length) throw new TypeError(`${name} must be a non-empty string`)
  return value
}
export function assertIdentifier(value, name) {
  assertString(value, name)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,253}$/.test(value)) throw new TypeError(`${name} contains unsupported characters`)
  return value
}
export function text(value, max = 4096) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}
export async function readJson(file, fallback = undefined) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(`Cannot read durable JSON state: ${error.message}`, { cause: error })
  }
}
/** Same-directory rename prevents partially visible persisted state. */
export async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = join(dirname(file), `.state-${process.pid}-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally { await rm(temporary, { force: true }).catch(() => {}) }
}
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason)
  const timer = setTimeout(resolve, ms)
  timer.unref()
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})
